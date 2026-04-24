const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const multer = require("multer");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = path.join(__dirname, "chat.sqlite");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const MAX_MESSAGE_LENGTH = Number(process.env.MAX_MESSAGE_LENGTH || 500);
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 5 * 1024 * 1024);
const EDIT_WINDOW_MS = Number(process.env.EDIT_WINDOW_MS || 2 * 60 * 1000);
const RATE_LIMIT_COUNT = Number(process.env.RATE_LIMIT_COUNT || 15);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 1000);
const HISTORY_PAGE_SIZE = 30;
const REPLAY_WINDOW_MS = 10 * 1000;
const ALLOWED_FILE_TYPES = (process.env.ALLOWED_FILE_TYPES || "image/png,image/jpeg,image/webp,application/pdf,text/plain")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const FILE_ENC_KEY = resolveEncryptionKey();
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

initializeDb(db);
cleanupOldAuditRows();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_FILE_TYPES.includes(file.mimetype)) {
      cb(new Error("File type not allowed"));
      return;
    }
    cb(null, true);
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

app.get("/api/config", (_req, res) => {
  res.json({
    maxMessageLength: MAX_MESSAGE_LENGTH,
    maxFileSize: MAX_FILE_SIZE,
    allowedFileTypes: ALLOWED_FILE_TYPES,
    editWindowMs: EDIT_WINDOW_MS
  });
});

app.get("/api/files/:id", (req, res) => {
  const fileId = Number(req.params.id);
  const fileRow = db
    .prepare("SELECT id, original_name, mime_type, size_bytes, stored_name, iv_hex, tag_hex FROM files WHERE id = ?")
    .get(fileId);
  if (!fileRow) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  const encryptedPath = path.join(UPLOADS_DIR, fileRow.stored_name);
  if (!fs.existsSync(encryptedPath)) {
    res.status(404).json({ error: "Stored file missing" });
    return;
  }

  try {
    const encryptedBuffer = fs.readFileSync(encryptedPath);
    const decrypted = decryptBuffer(encryptedBuffer, fileRow.iv_hex, fileRow.tag_hex);
    res.setHeader("Content-Type", fileRow.mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${sanitizeFilename(fileRow.original_name)}"`);
    res.send(decrypted);
  } catch {
    res.status(500).json({ error: "Could not decrypt file" });
  }
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    const userId = Number(req.header("x-user-id"));
    if (!userId || !req.file) {
      res.status(400).json({ error: "Missing user or file" });
      return;
    }
    const userExists = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
    if (!userExists) {
      res.status(403).json({ error: "Invalid user" });
      return;
    }

    const fileId = persistEncryptedFile(req.file, userId);
    const meta = db.prepare("SELECT id, original_name, mime_type, size_bytes FROM files WHERE id = ?").get(fileId);
    res.json({
      id: meta.id,
      name: meta.original_name,
      mimeType: meta.mime_type,
      sizeBytes: meta.size_bytes,
      url: `/api/files/${meta.id}`
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Upload failed" });
  }
});

const activeBySocketId = new Map();
const activeNicknameToSocketId = new Map();
const onlineByRoomId = new Map();
const typingState = new Map();
const rateLimitBuckets = new Map();
const blockedMap = hydrateBlockedMap();

io.on("connection", (socket) => {
  socket.emit("server:hello", {
    now: Date.now(),
    replayWindowMs: REPLAY_WINDOW_MS
  });

  socket.on("session:start", (payload, callback) => {
    try {
      const nickname = sanitizeNickname(payload?.nickname);
      if (!nickname) {
        throw new Error("Nickname is required");
      }
      if (activeNicknameToSocketId.has(nickname.toLowerCase())) {
        throw new Error("Nickname already in use");
      }

      const user = upsertUserByNickname(nickname);
      activeBySocketId.set(socket.id, { userId: user.id, nickname: user.nickname });
      activeNicknameToSocketId.set(user.nickname.toLowerCase(), socket.id);
      socket.emit("session:ready", {
        userId: user.id,
        nickname: user.nickname,
        rooms: fetchRooms(),
        blockedUserIds: Array.from(blockedMap.get(user.id) || [])
      });
      if (callback) callback({ ok: true, userId: user.id, nickname: user.nickname });
    } catch (error) {
      if (callback) callback({ ok: false, error: error.message });
    }
  });

  socket.on("room:create", ({ roomName }, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    try {
      const room = createRoom(roomName, actor.userId);
      io.emit("room:list", fetchRooms());
      callback?.({ ok: true, room });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("room:join", ({ roomName, lastSeenTs }, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    try {
      const room = getRoomByName(roomName);
      if (!room) {
        throw new Error("Room does not exist");
      }
      if (isBanned(room.id, actor.userId)) {
        throw new Error("You are banned from this room");
      }
      socket.join(roomSocketName(room.id));
      ensureOnlineRoom(room.id);
      onlineByRoomId.get(room.id).set(socket.id, {
        userId: actor.userId,
        nickname: actor.nickname,
        role: getRoomRole(room.id, actor.userId)
      });

      const history = fetchHistory({
        roomId: room.id,
        scope: "room",
        limit: HISTORY_PAGE_SIZE
      });
      const replay = fetchReplay(room.id, Number(lastSeenTs) || Date.now() - REPLAY_WINDOW_MS);
      socket.emit("room:joined", {
        room,
        role: getRoomRole(room.id, actor.userId),
        history,
        replay,
        pinned: fetchPinnedMessages(room.id)
      });
      emitPresence(room.id);
      callback?.({ ok: true, room });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("room:leave", ({ roomName }) => {
    const actor = getActor(socket);
    if (!actor) return;
    const room = getRoomByName(roomName);
    if (!room) return;
    socket.leave(roomSocketName(room.id));
    const onlineMap = onlineByRoomId.get(room.id);
    if (onlineMap) {
      onlineMap.delete(socket.id);
      emitPresence(room.id);
    }
  });

  socket.on("chat:send", (payload, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    if (!checkRateLimit(actor.userId)) {
      callback?.({ ok: false, error: "Rate limit exceeded. Slow down." });
      return;
    }

    try {
      const sentMessage = createMessage(actor, payload, socket);
      callback?.({
        ok: true,
        status: "sent",
        clientMessageId: payload?.clientMessageId,
        messageId: sentMessage.id
      });
      socket.emit("chat:delivery", {
        clientMessageId: payload?.clientMessageId,
        messageId: sentMessage.id,
        status: "received"
      });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("chat:history", (payload, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    try {
      const result = fetchHistoryForScope(actor.userId, payload);
      callback?.({ ok: true, ...result });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("chat:search", (payload, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    try {
      const query = String(payload?.query || "").trim();
      if (!query) throw new Error("Search query required");
      const results = searchMessages(actor.userId, payload, query);
      callback?.({ ok: true, results });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("chat:typing", ({ scope, roomName, targetNickname, isTyping }) => {
    const actor = getActor(socket);
    if (!actor) return;
    try {
      if (scope === "room") {
        const room = getRoomByName(roomName);
        if (!room) return;
        emitTypingRoom(room.id, actor, Boolean(isTyping));
      } else if (scope === "dm") {
        const target = getUserByNickname(targetNickname);
        if (!target) return;
        emitTypingDm(actor, target, Boolean(isTyping));
      }
    } catch {
      return;
    }
  });

  socket.on("chat:reaction", ({ messageId, emoji }, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    try {
      const normalizedEmoji = String(emoji || "").trim().slice(0, 12);
      if (!normalizedEmoji) throw new Error("Reaction required");
      const message = db.prepare("SELECT id, scope, room_id, sender_id, target_user_id FROM messages WHERE id = ?").get(messageId);
      if (!message) throw new Error("Message not found");
      ensureMessageVisible(actor.userId, message);

      db.prepare(
        "INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)"
      ).run(message.id, actor.userId, normalizedEmoji, Date.now());

      const reactions = fetchReactionsForMessage(message.id);
      emitMessageUpdate(message, { type: "reaction", messageId: message.id, reactions });
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("chat:editLast", ({ messageId, newText }, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    try {
      const trimmed = String(newText || "").trim();
      if (!trimmed) throw new Error("Message text required");
      if (trimmed.length > MAX_MESSAGE_LENGTH) throw new Error("Message too long");
      const message = db
        .prepare(
          "SELECT id, scope, room_id, sender_id, target_user_id, created_at, deleted FROM messages WHERE id = ?"
        )
        .get(messageId);
      if (!message) throw new Error("Message not found");
      if (message.deleted) throw new Error("Cannot edit deleted message");
      if (message.sender_id !== actor.userId) throw new Error("You can only edit your own messages");
      if (Date.now() - message.created_at > EDIT_WINDOW_MS) throw new Error("Edit window expired");
      const lastMessage = db
        .prepare(
          "SELECT id FROM messages WHERE sender_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1"
        )
        .get(actor.userId);
      if (!lastMessage || lastMessage.id !== message.id) {
        throw new Error("Only your latest message can be edited");
      }
      db.prepare("UPDATE messages SET content = ?, edited = 1, edited_at = ? WHERE id = ?").run(
        trimmed,
        Date.now(),
        message.id
      );
      const updated = hydrateMessageById(message.id);
      emitMessageUpdate(message, { type: "edit", message: updated });
      callback?.({ ok: true, message: updated });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("chat:deleteOwn", ({ messageId }, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    try {
      const message = db
        .prepare("SELECT id, scope, room_id, sender_id, target_user_id, content, deleted FROM messages WHERE id = ?")
        .get(messageId);
      if (!message) throw new Error("Message not found");
      if (message.deleted) throw new Error("Message already deleted");
      if (message.sender_id !== actor.userId) throw new Error("Cannot delete this message");
      markDeletedMessage(message, actor.userId, "own_delete");
      emitMessageUpdate(message, { type: "delete", messageId: message.id });
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("user:block", ({ nickname }, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    try {
      const target = getUserByNickname(nickname);
      if (!target) throw new Error("User not found");
      if (target.id === actor.userId) throw new Error("Cannot block yourself");
      db.prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)").run(
        actor.userId,
        target.id,
        Date.now()
      );
      refreshBlockedMap(actor.userId);
      callback?.({ ok: true, blockedUserIds: Array.from(blockedMap.get(actor.userId) || []) });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("user:unblock", ({ nickname }, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    try {
      const target = getUserByNickname(nickname);
      if (!target) throw new Error("User not found");
      db.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?").run(actor.userId, target.id);
      refreshBlockedMap(actor.userId);
      callback?.({ ok: true, blockedUserIds: Array.from(blockedMap.get(actor.userId) || []) });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("moderation:kick", ({ roomName, nickname, reason }, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    try {
      const room = getRoomByName(roomName);
      const target = getUserByNickname(nickname);
      if (!room || !target) throw new Error("Room or user not found");
      ensureModerator(room.id, actor.userId);
      kickUserFromRoom(room.id, target.id, reason || "kick");
      logModeration(room.id, actor.userId, target.id, "kick", reason || "");
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("moderation:ban", ({ roomName, nickname, reason }, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    try {
      const room = getRoomByName(roomName);
      const target = getUserByNickname(nickname);
      if (!room || !target) throw new Error("Room or user not found");
      ensureModerator(room.id, actor.userId);
      db.prepare(
        "INSERT OR IGNORE INTO room_bans (room_id, user_id, banned_by, reason, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(room.id, target.id, actor.userId, String(reason || "").slice(0, 120), Date.now());
      kickUserFromRoom(room.id, target.id, reason || "ban");
      logModeration(room.id, actor.userId, target.id, "ban", reason || "");
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("moderation:deleteMessage", ({ messageId, reason }, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    try {
      const message = db
        .prepare("SELECT id, scope, room_id, sender_id, target_user_id, content, deleted FROM messages WHERE id = ?")
        .get(messageId);
      if (!message) throw new Error("Message not found");
      if (message.scope !== "room" || !message.room_id) throw new Error("Only room messages can be moderated");
      ensureModerator(message.room_id, actor.userId);
      if (!message.deleted) {
        markDeletedMessage(message, actor.userId, reason || "moderator_delete");
        emitMessageUpdate(message, { type: "delete", messageId: message.id });
      }
      logModeration(message.room_id, actor.userId, message.sender_id, "delete", reason || "");
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("room:pin", ({ roomName, messageId }, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    try {
      const room = getRoomByName(roomName);
      if (!room) throw new Error("Room not found");
      ensureModerator(room.id, actor.userId);
      const message = db.prepare("SELECT id, room_id FROM messages WHERE id = ?").get(messageId);
      if (!message || message.room_id !== room.id) throw new Error("Message does not belong to room");
      db.prepare(
        "INSERT OR IGNORE INTO pinned_messages (room_id, message_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)"
      ).run(room.id, message.id, actor.userId, Date.now());
      io.to(roomSocketName(room.id)).emit("room:pinned", { roomId: room.id, pinned: fetchPinnedMessages(room.id) });
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("room:stats", ({ roomName }, callback) => {
    const actor = getActor(socket, callback);
    if (!actor) return;
    try {
      const room = getRoomByName(roomName);
      if (!room) throw new Error("Room not found");
      const memberCount = onlineByRoomId.get(room.id)?.size || 0;
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const messagesToday = db
        .prepare("SELECT COUNT(*) AS total FROM messages WHERE room_id = ? AND created_at >= ? AND deleted = 0")
        .get(room.id, since).total;
      callback?.({ ok: true, stats: { memberCount, messagesToday } });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on("disconnect", () => {
    const actor = activeBySocketId.get(socket.id);
    if (!actor) return;
    activeBySocketId.delete(socket.id);
    activeNicknameToSocketId.delete(actor.nickname.toLowerCase());
    for (const [roomId, onlineMap] of onlineByRoomId.entries()) {
      if (onlineMap.delete(socket.id)) {
        emitPresence(roomId);
      }
    }
    clearTypingForSocket(socket.id, actor);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on http://localhost:${PORT}`);
});

function initializeDb(dbConn) {
  dbConn.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_moderators (
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      assigned_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS room_bans (
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      banned_by INTEGER NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uploader_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      iv_hex TEXT NOT NULL,
      tag_hex TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      room_id INTEGER,
      sender_id INTEGER NOT NULL,
      target_user_id INTEGER,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      edited INTEGER NOT NULL DEFAULT 0,
      edited_at INTEGER,
      deleted INTEGER NOT NULL DEFAULT 0,
      file_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS pinned_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      pinned_by INTEGER NOT NULL,
      pinned_at INTEGER NOT NULL,
      UNIQUE(room_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS blocks (
      blocker_id INTEGER NOT NULL,
      blocked_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(blocker_id, blocked_id)
    );

    CREATE TABLE IF NOT EXISTS moderation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      moderator_id INTEGER NOT NULL,
      target_user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deleted_messages_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      room_id INTEGER,
      deleted_by INTEGER NOT NULL,
      original_sender INTEGER NOT NULL,
      reason TEXT,
      deleted_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_sender_created ON messages(sender_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_target_created ON messages(target_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_deleted_at ON deleted_messages_audit(deleted_at);
  `);
}

function sanitizeNickname(input) {
  const value = String(input || "").trim().replace(/\s+/g, " ");
  if (!value) return "";
  if (value.length > 24) return "";
  if (!/^[a-zA-Z0-9_ -]+$/.test(value)) return "";
  return value;
}

function sanitizeRoomName(input) {
  const value = String(input || "").trim().replace(/\s+/g, " ");
  if (!value) return "";
  if (value.length > 30) return "";
  if (!/^[a-zA-Z0-9_ -]+$/.test(value)) return "";
  return value;
}

function getActor(socket, callback) {
  const actor = activeBySocketId.get(socket.id);
  if (!actor && callback) {
    callback({ ok: false, error: "Session not initialized" });
  }
  return actor;
}

function upsertUserByNickname(nickname) {
  const existing = db.prepare("SELECT id, nickname FROM users WHERE lower(nickname) = lower(?)").get(nickname);
  if (existing) {
    db.prepare("UPDATE users SET nickname = ? WHERE id = ?").run(nickname, existing.id);
    return { id: existing.id, nickname };
  }
  const result = db.prepare("INSERT INTO users (nickname, created_at) VALUES (?, ?)").run(nickname, Date.now());
  return { id: result.lastInsertRowid, nickname };
}

function fetchRooms() {
  return db.prepare("SELECT id, name FROM rooms ORDER BY lower(name) ASC").all();
}

function getRoomByName(roomName) {
  const normalized = sanitizeRoomName(roomName);
  if (!normalized) return null;
  return db.prepare("SELECT id, name FROM rooms WHERE lower(name) = lower(?)").get(normalized);
}

function createRoom(roomName, userId) {
  const normalized = sanitizeRoomName(roomName);
  if (!normalized) throw new Error("Invalid room name");
  const existing = getRoomByName(normalized);
  if (existing) return existing;
  const result = db.prepare("INSERT INTO rooms (name, created_at) VALUES (?, ?)").run(normalized, Date.now());
  const room = { id: result.lastInsertRowid, name: normalized };
  db.prepare("INSERT INTO room_moderators (room_id, user_id, assigned_by, created_at) VALUES (?, ?, ?, ?)").run(
    room.id,
    userId,
    userId,
    Date.now()
  );
  return room;
}

function roomSocketName(roomId) {
  return `room:${roomId}`;
}

function ensureOnlineRoom(roomId) {
  if (!onlineByRoomId.has(roomId)) {
    onlineByRoomId.set(roomId, new Map());
  }
}

function emitPresence(roomId) {
  const users = Array.from(onlineByRoomId.get(roomId)?.values() || []).sort((a, b) =>
    a.nickname.localeCompare(b.nickname)
  );
  io.to(roomSocketName(roomId)).emit("presence:update", { roomId, users });
}

function getRoomRole(roomId, userId) {
  const isMod = db.prepare("SELECT 1 FROM room_moderators WHERE room_id = ? AND user_id = ?").get(roomId, userId);
  return isMod ? "moderator" : "member";
}

function ensureModerator(roomId, userId) {
  const role = getRoomRole(roomId, userId);
  if (role !== "moderator") {
    throw new Error("Moderator permission required");
  }
}

function isBanned(roomId, userId) {
  return Boolean(db.prepare("SELECT 1 FROM room_bans WHERE room_id = ? AND user_id = ?").get(roomId, userId));
}

function fetchHistory({ scope, roomId, userId, targetUserId, limit = HISTORY_PAGE_SIZE, beforeTs }) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit || HISTORY_PAGE_SIZE)));
  if (scope === "room") {
    if (beforeTs) {
      return hydrateMessages(
        db
          .prepare(
            "SELECT id FROM messages WHERE scope = 'room' AND room_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?"
          )
          .all(roomId, beforeTs, safeLimit)
      );
    }
    return hydrateMessages(
      db
        .prepare("SELECT id FROM messages WHERE scope = 'room' AND room_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(roomId, safeLimit)
    );
  }
  if (beforeTs) {
    return hydrateMessages(
      db
        .prepare(
          `SELECT id FROM messages
           WHERE scope = 'dm'
             AND ((sender_id = ? AND target_user_id = ?) OR (sender_id = ? AND target_user_id = ?))
             AND created_at < ?
           ORDER BY created_at DESC
           LIMIT ?`
        )
        .all(userId, targetUserId, targetUserId, userId, beforeTs, safeLimit)
    );
  }
  return hydrateMessages(
    db
      .prepare(
        `SELECT id FROM messages
         WHERE scope = 'dm'
           AND ((sender_id = ? AND target_user_id = ?) OR (sender_id = ? AND target_user_id = ?))
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(userId, targetUserId, targetUserId, userId, safeLimit)
  );
}

function fetchHistoryForScope(userId, payload) {
  const scope = payload?.scope === "dm" ? "dm" : "room";
  const beforeTs = Number(payload?.beforeTs) || null;
  const limit = Number(payload?.limit) || HISTORY_PAGE_SIZE;

  if (scope === "room") {
    const room = getRoomByName(payload?.roomName);
    if (!room) throw new Error("Room not found");
    const rows = fetchHistory({
      scope: "room",
      roomId: room.id,
      beforeTs,
      limit
    });
    return {
      scope,
      roomName: room.name,
      messages: rows,
      nextCursor: rows.length ? rows[rows.length - 1].createdAt : null
    };
  }

  const target = getUserByNickname(payload?.targetNickname);
  if (!target) throw new Error("Target user not found");
  const rows = fetchHistory({
    scope: "dm",
    userId,
    targetUserId: target.id,
    beforeTs,
    limit
  });
  return {
    scope,
    targetNickname: target.nickname,
    messages: rows,
    nextCursor: rows.length ? rows[rows.length - 1].createdAt : null
  };
}

function createMessage(actor, payload, socket) {
  const scope = payload?.scope === "dm" ? "dm" : "room";
  const text = String(payload?.text || "").trim();
  const attachment = payload?.attachment || null;

  if (!text && !attachment) throw new Error("Message or attachment required");
  if (text.length > MAX_MESSAGE_LENGTH) throw new Error(`Message exceeds ${MAX_MESSAGE_LENGTH} characters`);

  let room = null;
  let target = null;
  if (scope === "room") {
    room = getRoomByName(payload?.roomName);
    if (!room) throw new Error("Room not found");
    const onlineMap = onlineByRoomId.get(room.id);
    const duplicate = Array.from(onlineMap?.entries() || []).find(
      ([otherSocketId, online]) =>
        otherSocketId !== socket.id && online.nickname.toLowerCase() === actor.nickname.toLowerCase()
    );
    if (duplicate) throw new Error("Nickname already present in room");
  } else {
    target = getUserByNickname(payload?.targetNickname);
    if (!target) throw new Error("Target user not found");
    const blockedSet = blockedMap.get(target.id);
    if (blockedSet?.has(actor.userId)) throw new Error("User has blocked you");
  }

  let fileId = null;
  if (attachment?.id) {
    const fileMeta = db.prepare("SELECT id FROM files WHERE id = ?").get(Number(attachment.id));
    if (!fileMeta) throw new Error("Attachment not found");
    fileId = fileMeta.id;
  }

  const messageId = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO messages
       (id, scope, room_id, sender_id, target_user_id, content, created_at, edited, file_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(messageId, scope, room?.id || null, actor.userId, target?.id || null, text, now, fileId);

  const hydrated = hydrateMessageById(messageId);
  if (scope === "room") {
    emitToRoomWithBlocking(room.id, actor.userId, "chat:message", hydrated);
    io.to(roomSocketName(room.id)).emit("room:stats:update", {
      roomId: room.id,
      memberCount: onlineByRoomId.get(room.id)?.size || 0,
      messagesToday: countRoomMessagesToday(room.id)
    });
  } else {
    emitDm(actor.userId, target.id, "chat:message", hydrated);
  }
  return hydrated;
}

function getUserByNickname(nickname) {
  const normalized = sanitizeNickname(nickname);
  if (!normalized) return null;
  return db.prepare("SELECT id, nickname FROM users WHERE lower(nickname) = lower(?)").get(normalized);
}

function hydrateMessages(rows) {
  return rows.map((row) => hydrateMessageById(row.id)).filter(Boolean).reverse();
}

function hydrateMessageById(messageId) {
  const message = db
    .prepare(
      `SELECT m.id, m.scope, m.room_id, m.sender_id, m.target_user_id, m.content, m.created_at, m.edited, m.edited_at, m.deleted, m.file_id,
              sender.nickname AS sender_nickname,
              target.nickname AS target_nickname,
              r.name AS room_name
       FROM messages m
       LEFT JOIN users sender ON sender.id = m.sender_id
       LEFT JOIN users target ON target.id = m.target_user_id
       LEFT JOIN rooms r ON r.id = m.room_id
       WHERE m.id = ?`
    )
    .get(messageId);
  if (!message) return null;

  let file = null;
  if (message.file_id) {
    file = db
      .prepare("SELECT id, original_name, mime_type, size_bytes FROM files WHERE id = ?")
      .get(message.file_id);
    if (file) {
      file.url = `/api/files/${file.id}`;
      file.name = file.original_name;
      file.mimeType = file.mime_type;
      file.sizeBytes = file.size_bytes;
      delete file.original_name;
      delete file.mime_type;
      delete file.size_bytes;
    }
  }

  return {
    id: message.id,
    scope: message.scope,
    roomId: message.room_id,
    roomName: message.room_name,
    senderId: message.sender_id,
    senderNickname: message.sender_nickname,
    targetUserId: message.target_user_id,
    targetNickname: message.target_nickname,
    content: message.deleted ? "[deleted]" : message.content,
    createdAt: message.created_at,
    edited: Boolean(message.edited),
    editedAt: message.edited_at,
    deleted: Boolean(message.deleted),
    mentions: parseMentions(message.content),
    reactions: fetchReactionsForMessage(message.id),
    file
  };
}

function parseMentions(text) {
  const found = [];
  const regex = /@([a-zA-Z0-9_ -]{1,24})/g;
  for (const match of String(text || "").matchAll(regex)) {
    found.push(match[1].trim());
  }
  return found;
}

function fetchReactionsForMessage(messageId) {
  const rows = db
    .prepare(
      `SELECT mr.emoji, u.nickname
       FROM message_reactions mr
       JOIN users u ON u.id = mr.user_id
       WHERE mr.message_id = ?
       ORDER BY mr.created_at ASC`
    )
    .all(messageId);
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.emoji)) grouped.set(row.emoji, []);
    grouped.get(row.emoji).push(row.nickname);
  }
  return Array.from(grouped.entries()).map(([emoji, users]) => ({ emoji, users, count: users.length }));
}

function emitTypingRoom(roomId, actor, isTyping) {
  const key = `room:${roomId}:${actor.userId}`;
  if (isTyping) {
    typingState.set(key, Date.now());
  } else {
    typingState.delete(key);
  }
  io.to(roomSocketName(roomId)).emit("chat:typing", {
    scope: "room",
    roomId,
    userId: actor.userId,
    nickname: actor.nickname,
    isTyping
  });
}

function emitTypingDm(actor, target, isTyping) {
  const targetSocket = activeNicknameToSocketId.get(target.nickname.toLowerCase());
  if (!targetSocket) return;
  io.to(targetSocket).emit("chat:typing", {
    scope: "dm",
    userId: actor.userId,
    nickname: actor.nickname,
    isTyping
  });
}

function clearTypingForSocket(socketId, actor) {
  for (const key of typingState.keys()) {
    if (key.includes(`:${actor.userId}`)) {
      typingState.delete(key);
    }
  }
  for (const [roomId, onlineMap] of onlineByRoomId.entries()) {
    if (onlineMap.has(socketId)) {
      io.to(roomSocketName(roomId)).emit("chat:typing", {
        scope: "room",
        roomId,
        userId: actor.userId,
        nickname: actor.nickname,
        isTyping: false
      });
    }
  }
}

function emitToRoomWithBlocking(roomId, senderId, eventName, payload) {
  const onlineMap = onlineByRoomId.get(roomId);
  if (!onlineMap) return;
  for (const [socketId, info] of onlineMap.entries()) {
    const blockedSet = blockedMap.get(info.userId);
    if (blockedSet?.has(senderId)) continue;
    io.to(socketId).emit(eventName, payload);
  }
}

function emitDm(senderId, targetUserId, eventName, payload) {
  const targetSocketIds = [];
  for (const [socketId, actor] of activeBySocketId.entries()) {
    if (actor.userId === targetUserId || actor.userId === senderId) {
      targetSocketIds.push(socketId);
    }
  }
  for (const socketId of targetSocketIds) {
    const actor = activeBySocketId.get(socketId);
    const blockedSet = blockedMap.get(actor.userId);
    if (actor.userId === targetUserId && blockedSet?.has(senderId)) continue;
    io.to(socketId).emit(eventName, payload);
  }
}

function emitMessageUpdate(message, payload) {
  if (message.scope === "room") {
    emitToRoomWithBlocking(message.room_id, message.sender_id, "chat:messageUpdate", payload);
  } else if (message.scope === "dm") {
    emitDm(message.sender_id, message.target_user_id, "chat:messageUpdate", payload);
  }
}

function markDeletedMessage(message, deletedBy, reason) {
  db.prepare("UPDATE messages SET deleted = 1, edited = 0, edited_at = NULL WHERE id = ?").run(message.id);
  db.prepare(
    "INSERT INTO deleted_messages_audit (message_id, room_id, deleted_by, original_sender, reason, deleted_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(message.id, message.room_id || null, deletedBy, message.sender_id, String(reason || "").slice(0, 120), Date.now());
}

function kickUserFromRoom(roomId, userId, reason) {
  const onlineMap = onlineByRoomId.get(roomId);
  if (!onlineMap) return;
  for (const [socketId, info] of onlineMap.entries()) {
    if (info.userId === userId) {
      onlineMap.delete(socketId);
      io.to(socketId).emit("moderation:kicked", { roomId, reason });
      io.sockets.sockets.get(socketId)?.leave(roomSocketName(roomId));
    }
  }
  emitPresence(roomId);
}

function logModeration(roomId, moderatorId, targetUserId, action, reason) {
  db.prepare(
    "INSERT INTO moderation_logs (room_id, moderator_id, target_user_id, action, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(roomId, moderatorId, targetUserId, action, String(reason || "").slice(0, 240), Date.now());
}

function fetchPinnedMessages(roomId) {
  return db
    .prepare(
      `SELECT pm.message_id
       FROM pinned_messages pm
       WHERE pm.room_id = ?
       ORDER BY pm.pinned_at DESC`
    )
    .all(roomId)
    .map((row) => hydrateMessageById(row.message_id))
    .filter(Boolean);
}

function searchMessages(userId, payload, query) {
  const scope = payload?.scope === "dm" ? "dm" : "room";
  const pattern = `%${query.toLowerCase()}%`;
  if (scope === "room") {
    const room = getRoomByName(payload?.roomName);
    if (!room) throw new Error("Room not found");
    return hydrateMessages(
      db
        .prepare(
          "SELECT id FROM messages WHERE room_id = ? AND deleted = 0 AND lower(content) LIKE ? ORDER BY created_at DESC LIMIT 50"
        )
        .all(room.id, pattern)
    );
  }
  const target = getUserByNickname(payload?.targetNickname);
  if (!target) throw new Error("Target user not found");
  return hydrateMessages(
    db
      .prepare(
        `SELECT id FROM messages
         WHERE scope = 'dm'
           AND ((sender_id = ? AND target_user_id = ?) OR (sender_id = ? AND target_user_id = ?))
           AND deleted = 0
           AND lower(content) LIKE ?
         ORDER BY created_at DESC
         LIMIT 50`
      )
      .all(userId, target.id, target.id, userId, pattern)
  );
}

function ensureMessageVisible(userId, message) {
  if (message.scope === "room") return;
  if (message.sender_id !== userId && message.target_user_id !== userId) {
    throw new Error("Message is not visible to you");
  }
}

function fetchReplay(roomId, lastSeenTs) {
  return hydrateMessages(
    db
      .prepare(
        "SELECT id FROM messages WHERE room_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 100"
      )
      .all(roomId, Math.max(lastSeenTs, Date.now() - REPLAY_WINDOW_MS))
  );
}

function checkRateLimit(userId) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(userId) || [];
  const filtered = bucket.filter((entryTs) => now - entryTs < RATE_LIMIT_WINDOW_MS);
  if (filtered.length >= RATE_LIMIT_COUNT) {
    rateLimitBuckets.set(userId, filtered);
    return false;
  }
  filtered.push(now);
  rateLimitBuckets.set(userId, filtered);
  return true;
}

function hydrateBlockedMap() {
  const map = new Map();
  const rows = db.prepare("SELECT blocker_id, blocked_id FROM blocks").all();
  for (const row of rows) {
    if (!map.has(row.blocker_id)) map.set(row.blocker_id, new Set());
    map.get(row.blocker_id).add(row.blocked_id);
  }
  return map;
}

function refreshBlockedMap(userId) {
  const rows = db.prepare("SELECT blocked_id FROM blocks WHERE blocker_id = ?").all(userId);
  blockedMap.set(
    userId,
    new Set(rows.map((row) => row.blocked_id))
  );
}

function persistEncryptedFile(file, userId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", FILE_ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(file.buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  const storedName = `${crypto.randomUUID()}.bin`;
  fs.writeFileSync(path.join(UPLOADS_DIR, storedName), encrypted);
  const result = db
    .prepare(
      `INSERT INTO files (uploader_id, original_name, stored_name, mime_type, size_bytes, iv_hex, tag_hex, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      sanitizeFilename(file.originalname || "file"),
      storedName,
      file.mimetype,
      file.size,
      iv.toString("hex"),
      tag.toString("hex"),
      Date.now()
    );
  return result.lastInsertRowid;
}

function decryptBuffer(encryptedBuffer, ivHex, tagHex) {
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", FILE_ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
}

function sanitizeFilename(name) {
  return String(name || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
}

function cleanupOldAuditRows() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM deleted_messages_audit WHERE deleted_at < ?").run(cutoff);
}

function resolveEncryptionKey() {
  const fromEnv = process.env.FILE_ENC_KEY_HEX || "";
  if (/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
    return Buffer.from(fromEnv, "hex");
  }
  return crypto.createHash("sha256").update("simple-chat-dev-key").digest();
}

function countRoomMessagesToday(roomId) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  return db.prepare("SELECT COUNT(*) AS total FROM messages WHERE room_id = ? AND created_at >= ? AND deleted = 0").get(
    roomId,
    since
  ).total;
}
