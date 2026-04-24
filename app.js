const SESSION_NICK_KEY = "chat_session_nickname";
const MUTE_KEY = "chat_mute_map";
const DEMO_ROOMS_KEY = "chat_demo_rooms_v1";
const DEMO_MESSAGES_KEY = "chat_demo_messages_v1";

const gateEl = document.getElementById("gate");
const appEl = document.getElementById("app");
const sessionFormEl = document.getElementById("sessionForm");
const nicknameInputEl = document.getElementById("nicknameInput");

const selfNameEl = document.getElementById("selfName");
const rolePillEl = document.getElementById("rolePill");
const scopeLabelEl = document.getElementById("scopeLabel");
const scopeTitleEl = document.getElementById("scopeTitle");
const muteBtnEl = document.getElementById("muteBtn");
const statsBtnEl = document.getElementById("statsBtn");
const switchUserBtnEl = document.getElementById("switchUserBtn");
const newRoomInputEl = document.getElementById("newRoomInput");
const createRoomBtnEl = document.getElementById("createRoomBtn");
const roomListEl = document.getElementById("roomList");
const onlineUsersListEl = document.getElementById("onlineUsersList");
const pinnedWrapEl = document.getElementById("pinnedWrap");
const pinnedMessagesEl = document.getElementById("pinnedMessages");
const messagesEl = document.getElementById("messages");
const typingIndicatorEl = document.getElementById("typingIndicator");
const searchInputEl = document.getElementById("searchInput");
const searchBtnEl = document.getElementById("searchBtn");
const historyBtnEl = document.getElementById("historyBtn");
const composerEl = document.getElementById("composer");
const messageInputEl = document.getElementById("messageInput");
const dmTargetInputEl = document.getElementById("dmTargetInput");
const fileInputEl = document.getElementById("fileInput");
const attachmentLabelEl = document.getElementById("attachmentLabel");
const sendBtnEl = document.getElementById("sendBtn");
const messageTemplateEl = document.getElementById("messageTemplate");

const socket = typeof window.io === "function" ? window.io() : null;
const isDemoMode = !socket;

let config = {
  maxMessageLength: 500,
  maxFileSize: 5 * 1024 * 1024,
  allowedFileTypes: [],
  editWindowMs: 120000
};

const state = {
  userId: null,
  nickname: "",
  rooms: [],
  roomRole: "member",
  onlineUsers: [],
  current: { type: "room", roomName: null, targetNickname: null },
  messages: [],
  pinned: [],
  blockedUserIds: new Set(),
  deliveryByMessageId: new Map(),
  attachedFile: null,
  typingTimeout: null,
  muteMap: loadMuteMap()
};

bootstrap();

function bootstrap() {
  fetch("/api/config")
    .then((res) => res.json())
    .then((value) => {
      config = value;
      messageInputEl.maxLength = value.maxMessageLength;
    })
    .catch(() => null);

  const saved = sessionStorage.getItem(SESSION_NICK_KEY);
  if (saved) {
    nicknameInputEl.value = saved;
  }

  sessionFormEl.addEventListener("submit", onSessionSubmit);
  switchUserBtnEl.addEventListener("click", onSwitchUser);
  createRoomBtnEl.addEventListener("click", onCreateRoom);
  muteBtnEl.addEventListener("click", onToggleMute);
  statsBtnEl.addEventListener("click", onRequestStats);
  composerEl.addEventListener("submit", onSendMessage);
  messageInputEl.addEventListener("input", onTypingInput);
  fileInputEl.addEventListener("change", onFileSelected);
  searchBtnEl.addEventListener("click", onSearchMessages);
  historyBtnEl.addEventListener("click", onLoadOlder);

  if (!isDemoMode) {
    socket.on("connect", () => {
      const nickname = sessionStorage.getItem(SESSION_NICK_KEY);
      if (nickname) {
        startSession(nickname, false);
      }
    });
    socket.on("session:ready", onSessionReady);
    socket.on("room:list", (rooms) => {
      state.rooms = rooms || [];
      renderRooms();
    });
    socket.on("room:joined", ({ room, role, history, replay, pinned }) => {
      state.current = { type: "room", roomName: room.name, targetNickname: null };
      state.roomRole = role || "member";
      const merged = mergeByMessageId([...(history || []), ...(replay || [])]);
      state.messages = merged;
      state.pinned = pinned || [];
      renderScopeHeader();
      renderPinned();
      renderMessages();
      renderRoomSelection();
      sendTyping(false);
    });
    socket.on("presence:update", ({ roomId, users }) => {
      const currentRoom = state.rooms.find((room) => room.id === roomId);
      if (currentRoom && currentRoom.name === state.current.roomName) {
        state.onlineUsers = users || [];
        renderOnlineUsers();
      }
    });
    socket.on("chat:message", (message) => {
      if (!belongsToCurrentScope(message)) return;
      state.messages.push(message);
      state.messages = mergeByMessageId(state.messages);
      renderMessages();
      if (message.senderId !== state.userId && !isCurrentScopeMuted()) {
        transientNotice(`New message from ${message.senderNickname}`);
      }
    });
    socket.on("chat:messageUpdate", (payload) => {
      if (payload.type === "edit" && payload.message) {
        state.messages = state.messages.map((msg) => (msg.id === payload.message.id ? payload.message : msg));
      }
      if (payload.type === "delete") {
        state.messages = state.messages.map((msg) =>
          msg.id === payload.messageId ? { ...msg, deleted: true, content: "[deleted]" } : msg
        );
      }
      if (payload.type === "reaction") {
        state.messages = state.messages.map((msg) =>
          msg.id === payload.messageId ? { ...msg, reactions: payload.reactions } : msg
        );
      }
      renderMessages();
    });
    socket.on("chat:typing", (payload) => {
      if (payload.nickname === state.nickname) return;
      if (payload.scope === "room" && state.current.type === "room") {
        typingIndicatorEl.textContent = payload.isTyping ? `${payload.nickname} is typing...` : "";
      }
      if (payload.scope === "dm" && state.current.type === "dm" && payload.nickname === state.current.targetNickname) {
        typingIndicatorEl.textContent = payload.isTyping ? `${payload.nickname} is typing...` : "";
      }
    });
    socket.on("chat:delivery", ({ messageId, status }) => {
      if (messageId) {
        state.deliveryByMessageId.set(messageId, status);
        renderMessages();
      }
    });
    socket.on("room:pinned", ({ roomId, pinned }) => {
      const currentRoom = state.rooms.find((room) => room.id === roomId);
      if (currentRoom && currentRoom.name === state.current.roomName) {
        state.pinned = pinned || [];
        renderPinned();
      }
    });
  } else {
    transientNotice("Demo mode enabled for GitHub Pages.");
  }

  const savedNick = sessionStorage.getItem(SESSION_NICK_KEY);
  if (savedNick && isDemoMode) {
    startDemoSession(savedNick);
    return;
  }

  if (!savedNick) {
    lockApp();
  }
}

function onSessionSubmit(event) {
  event.preventDefault();
  const nickname = nicknameInputEl.value.trim();
  if (!nickname) return;
  if (isDemoMode) {
    startDemoSession(nickname);
    return;
  }
  startSession(nickname, true);
}

function startSession(nickname, fromGate) {
  socket.emit("session:start", { nickname }, (result) => {
    if (!result?.ok) {
      alert(result?.error || "Could not start session");
      return;
    }
    state.userId = result.userId;
    state.nickname = result.nickname;
    if (fromGate) {
      sessionStorage.setItem(SESSION_NICK_KEY, result.nickname);
    }
  });
}

function startDemoSession(nickname) {
  const cleaned = nickname.trim();
  if (!cleaned) return;
  state.userId = stableDemoUserId(cleaned);
  state.nickname = cleaned;
  state.rooms = loadDemoRooms();
  if (!state.rooms.length) {
    state.rooms = [{ id: 1, name: "General" }];
    persistDemoRooms(state.rooms);
  }
  state.onlineUsers = [{ userId: state.userId, nickname: cleaned, role: "member" }];
  state.blockedUserIds = new Set();
  sessionStorage.setItem(SESSION_NICK_KEY, cleaned);
  unlockApp();
  renderRooms();
  joinRoomDemo(state.rooms[0].name);
}

function onSessionReady(payload) {
  state.userId = payload.userId;
  state.nickname = payload.nickname;
  state.rooms = payload.rooms || [];
  state.blockedUserIds = new Set(payload.blockedUserIds || []);
  unlockApp();
  renderRooms();
  if (!state.rooms.length) {
    socket.emit("room:create", { roomName: "General" }, (result) => {
      if (result?.ok) {
        joinRoom("General");
      }
    });
    return;
  }
  const preferred = state.rooms.find((room) => room.name === "General")?.name || state.rooms[0].name;
  joinRoom(preferred);
}

function lockApp() {
  appEl.classList.add("hidden");
  appEl.setAttribute("aria-hidden", "true");
  gateEl.classList.remove("hidden");
}

function unlockApp() {
  gateEl.classList.add("hidden");
  appEl.classList.remove("hidden");
  appEl.setAttribute("aria-hidden", "false");
  selfNameEl.textContent = state.nickname;
}

function onSwitchUser() {
  sessionStorage.removeItem(SESSION_NICK_KEY);
  window.location.reload();
}

function onCreateRoom() {
  const roomName = newRoomInputEl.value.trim();
  if (!roomName) return;
  if (isDemoMode) {
    if (state.rooms.some((room) => room.name.toLowerCase() === roomName.toLowerCase())) {
      joinRoomDemo(roomName);
      return;
    }
    state.rooms.push({ id: Date.now(), name: roomName });
    persistDemoRooms(state.rooms);
    newRoomInputEl.value = "";
    joinRoomDemo(roomName);
    return;
  }
  socket.emit("room:create", { roomName }, (result) => {
    if (!result?.ok) {
      alert(result?.error || "Could not create room");
      return;
    }
    newRoomInputEl.value = "";
    joinRoom(result.room.name);
  });
}

function joinRoom(roomName) {
  if (isDemoMode) {
    joinRoomDemo(roomName);
    return;
  }
  socket.emit("room:join", { roomName, lastSeenTs: Date.now() - 10000 }, (result) => {
    if (!result?.ok) {
      alert(result?.error || "Could not join room");
    }
  });
}

function joinRoomDemo(roomName) {
  const room = state.rooms.find((entry) => entry.name.toLowerCase() === roomName.toLowerCase());
  if (!room) return;
  state.current = { type: "room", roomName: room.name, targetNickname: null };
  state.roomRole = "member";
  state.messages = loadDemoMessages(getScopeKey());
  state.pinned = [];
  renderScopeHeader();
  renderPinned();
  renderMessages();
  renderRoomSelection();
}

function openDm(targetNickname) {
  if (isDemoMode) {
    alert("DMs are disabled in GitHub Pages demo mode.");
    return;
  }
  if (!targetNickname || targetNickname === state.nickname) return;
  state.current = { type: "dm", roomName: null, targetNickname };
  state.roomRole = "member";
  dmTargetInputEl.classList.remove("hidden");
  dmTargetInputEl.value = targetNickname;
  scopeLabelEl.textContent = "Direct Message";
  scopeTitleEl.textContent = targetNickname;
  rolePillEl.textContent = "role: n/a";
  socket.emit(
    "chat:history",
    { scope: "dm", targetNickname, limit: 30 },
    (result) => {
      if (!result?.ok) {
        alert(result?.error || "Could not fetch DM history");
        return;
      }
      state.messages = result.messages || [];
      state.pinned = [];
      renderPinned();
      renderMessages();
      renderRoomSelection();
    }
  );
}

function renderRooms() {
  roomListEl.innerHTML = "";
  for (const room of state.rooms) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = `# ${room.name}`;
    if (room.name === state.current.roomName && state.current.type === "room") {
      button.classList.add("active");
    }
    button.addEventListener("click", () => joinRoom(room.name));
    li.appendChild(button);
    roomListEl.appendChild(li);
  }
}

function renderRoomSelection() {
  renderRooms();
  renderOnlineUsers();
  renderScopeHeader();
  renderMuteState();
}

function renderScopeHeader() {
  if (state.current.type === "room") {
    scopeLabelEl.textContent = "Room";
    scopeTitleEl.textContent = state.current.roomName || "-";
    rolePillEl.textContent = `role: ${state.roomRole}`;
    dmTargetInputEl.classList.add("hidden");
  } else {
    scopeLabelEl.textContent = "Direct Message";
    scopeTitleEl.textContent = state.current.targetNickname || "-";
    rolePillEl.textContent = "role: n/a";
    dmTargetInputEl.classList.remove("hidden");
    dmTargetInputEl.value = state.current.targetNickname || "";
  }
}

function renderOnlineUsers() {
  onlineUsersListEl.innerHTML = "";
  for (const online of state.onlineUsers) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = online.role === "moderator" ? `${online.nickname} [mod]` : online.nickname;
    button.addEventListener("click", () => openDm(online.nickname));
    if (online.nickname === state.current.targetNickname && state.current.type === "dm") {
      button.classList.add("active");
    }
    li.appendChild(button);
    onlineUsersListEl.appendChild(li);
  }
}

async function onSendMessage(event) {
  event.preventDefault();
  const text = messageInputEl.value.trim();
  const scope = state.current.type;
  const targetNickname = scope === "dm" ? (dmTargetInputEl.value.trim() || state.current.targetNickname) : null;

  if (isDemoMode) {
    if (!text) return;
    const message = {
      id: crypto.randomUUID(),
      scope: "room",
      roomName: state.current.roomName,
      senderId: state.userId,
      senderNickname: state.nickname,
      targetUserId: null,
      targetNickname: null,
      content: text,
      createdAt: Date.now(),
      edited: false,
      deleted: false,
      mentions: [],
      reactions: [],
      file: null
    };
    state.messages.push(message);
    persistDemoMessages(getScopeKey(), state.messages);
    renderMessages();
    messageInputEl.value = "";
    autoResizeTextarea();
    return;
  }

  if (scope === "dm" && !targetNickname) {
    alert("Choose a DM target");
    return;
  }

  let attachment = null;
  if (state.attachedFile) {
    attachment = await uploadFile(state.attachedFile);
    if (!attachment) return;
  }

  const clientMessageId = crypto.randomUUID();
  sendBtnEl.disabled = true;
  socket.emit(
    "chat:send",
    {
      scope,
      roomName: state.current.roomName,
      targetNickname,
      text,
      attachment,
      clientMessageId
    },
    (result) => {
      sendBtnEl.disabled = false;
      if (!result?.ok) {
        alert(result?.error || "Send failed");
        return;
      }
      if (result.messageId) {
        state.deliveryByMessageId.set(result.messageId, result.status || "sent");
      }
      messageInputEl.value = "";
      state.attachedFile = null;
      fileInputEl.value = "";
      attachmentLabelEl.textContent = "No file attached";
      autoResizeTextarea();
      sendTyping(false);
    }
  );
}

async function uploadFile(file) {
  if (file.size > config.maxFileSize) {
    alert(`File too large. Max ${Math.round(config.maxFileSize / (1024 * 1024))}MB`);
    return null;
  }
  if (config.allowedFileTypes.length && !config.allowedFileTypes.includes(file.type)) {
    alert("File type not allowed");
    return null;
  }
  const formData = new FormData();
  formData.append("file", file);
  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData,
      headers: { "x-user-id": String(state.userId) }
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Upload failed");
    }
    return response.json();
  } catch (error) {
    alert(error.message);
    return null;
  }
}

function onTypingInput() {
  autoResizeTextarea();
  sendTyping(true);
  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => sendTyping(false), 1200);
}

function sendTyping(isTyping) {
  if (isDemoMode) return;
  socket.emit("chat:typing", {
    scope: state.current.type,
    roomName: state.current.roomName,
    targetNickname: state.current.targetNickname,
    isTyping
  });
}

function onFileSelected() {
  if (isDemoMode) {
    fileInputEl.value = "";
    state.attachedFile = null;
    attachmentLabelEl.textContent = "Attachments disabled in demo mode";
    return;
  }
  const file = fileInputEl.files?.[0];
  state.attachedFile = file || null;
  attachmentLabelEl.textContent = file ? `${file.name} (${Math.ceil(file.size / 1024)} KB)` : "No file attached";
}

function onSearchMessages() {
  const query = searchInputEl.value.trim();
  if (!query) return;
  if (isDemoMode) {
    const list = loadDemoMessages(getScopeKey());
    state.messages = list.filter((msg) => String(msg.content || "").toLowerCase().includes(query.toLowerCase()));
    renderMessages();
    return;
  }
  socket.emit(
    "chat:search",
    {
      scope: state.current.type,
      roomName: state.current.roomName,
      targetNickname: state.current.targetNickname,
      query
    },
    (result) => {
      if (!result?.ok) {
        alert(result?.error || "Search failed");
        return;
      }
      state.messages = result.results || [];
      renderMessages();
    }
  );
}

function onLoadOlder() {
  if (!state.messages.length) return;
  if (isDemoMode) {
    transientNotice("Demo mode shows locally stored messages.");
    return;
  }
  const beforeTs = state.messages[0].createdAt;
  socket.emit(
    "chat:history",
    {
      scope: state.current.type,
      roomName: state.current.roomName,
      targetNickname: state.current.targetNickname,
      beforeTs,
      limit: 30
    },
    (result) => {
      if (!result?.ok) {
        alert(result?.error || "Could not load history");
        return;
      }
      state.messages = mergeByMessageId([...(result.messages || []), ...state.messages]);
      renderMessages(false);
    }
  );
}

function onToggleMute() {
  const key = getScopeKey();
  const next = !Boolean(state.muteMap[key]);
  state.muteMap[key] = next;
  persistMuteMap(state.muteMap);
  renderMuteState();
}

function onRequestStats() {
  if (state.current.type !== "room") return;
  if (isDemoMode) {
    alert(`Members online: 1\nMessages/day: ${state.messages.length}`);
    return;
  }
  socket.emit("room:stats", { roomName: state.current.roomName }, (result) => {
    if (!result?.ok) {
      alert(result?.error || "Could not load stats");
      return;
    }
    alert(`Members online: ${result.stats.memberCount}\nMessages/day: ${result.stats.messagesToday}`);
  });
}

function renderMuteState() {
  const muted = isCurrentScopeMuted();
  muteBtnEl.textContent = muted ? "Unmute" : "Mute";
  appEl.classList.toggle("muted-scope", muted);
}

function renderPinned() {
  pinnedMessagesEl.innerHTML = "";
  if (!state.pinned.length) {
    pinnedWrapEl.classList.add("hidden");
    return;
  }
  pinnedWrapEl.classList.remove("hidden");
  for (const message of state.pinned) {
    const item = document.createElement("p");
    item.className = "hint";
    item.textContent = `${message.senderNickname}: ${message.content}`;
    pinnedMessagesEl.appendChild(item);
  }
}

function renderMessages(scrollBottom = true) {
  messagesEl.innerHTML = "";
  for (const message of state.messages) {
    const fragment = messageTemplateEl.content.cloneNode(true);
    const card = fragment.querySelector(".message-card");
    const authorEl = fragment.querySelector(".author");
    const timeEl = fragment.querySelector(".time");
    const bodyEl = fragment.querySelector(".body");
    const controlsEl = fragment.querySelector(".controls");
    const reactionsEl = fragment.querySelector(".reactions");

    if (message.senderId === state.userId) {
      card.classList.add("own");
    }
    authorEl.textContent = message.senderNickname;
    const stamp = new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const delivery = message.senderId === state.userId ? state.deliveryByMessageId.get(message.id) || "received" : "";
    const edited = message.edited ? " · edited" : "";
    timeEl.textContent = `${stamp}${edited}${delivery ? ` · ${delivery}` : ""}`;
    bodyEl.innerHTML = decorateMessageBody(message.content);

    const reactQuick = ["👍", "😂", "🔥"];
    for (const emoji of reactQuick) {
      const btn = document.createElement("button");
      btn.textContent = emoji;
      btn.addEventListener("click", () => reactToMessage(message.id, emoji));
      controlsEl.appendChild(btn);
    }

    if (!message.deleted && message.senderId === state.userId) {
      const editBtn = document.createElement("button");
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => editMessage(message));
      controlsEl.appendChild(editBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "Delete";
      deleteBtn.classList.add("danger");
      deleteBtn.addEventListener("click", () => deleteOwnMessage(message.id));
      controlsEl.appendChild(deleteBtn);
    }

    if (!isDemoMode && state.current.type === "room" && state.roomRole === "moderator") {
      const pinBtn = document.createElement("button");
      pinBtn.textContent = "Pin";
      pinBtn.addEventListener("click", () => pinMessage(message.id));
      controlsEl.appendChild(pinBtn);
    }

    for (const reaction of message.reactions || []) {
      const badge = document.createElement("button");
      badge.textContent = `${reaction.emoji} ${reaction.count}`;
      reactionsEl.appendChild(badge);
    }

    messagesEl.appendChild(fragment);
  }
  if (scrollBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function reactToMessage(messageId, emoji) {
  if (isDemoMode) {
    state.messages = state.messages.map((msg) => {
      if (msg.id !== messageId) return msg;
      const reactions = msg.reactions || [];
      const existing = reactions.find((r) => r.emoji === emoji);
      if (!existing) {
        return { ...msg, reactions: [...reactions, { emoji, count: 1, users: [state.nickname] }] };
      }
      return msg;
    });
    persistDemoMessages(getScopeKey(), state.messages);
    renderMessages();
    return;
  }
  socket.emit("chat:reaction", { messageId, emoji }, () => null);
}

function editMessage(message) {
  const newText = window.prompt("Edit your message:", message.content);
  if (newText === null) return;
  if (isDemoMode) {
    state.messages = state.messages.map((msg) =>
      msg.id === message.id ? { ...msg, content: newText, edited: true } : msg
    );
    persistDemoMessages(getScopeKey(), state.messages);
    renderMessages();
    return;
  }
  socket.emit("chat:editLast", { messageId: message.id, newText }, () => null);
}

function deleteOwnMessage(messageId) {
  if (isDemoMode) {
    state.messages = state.messages.map((msg) =>
      msg.id === messageId ? { ...msg, deleted: true, content: "[deleted]" } : msg
    );
    persistDemoMessages(getScopeKey(), state.messages);
    renderMessages();
    return;
  }
  socket.emit("chat:deleteOwn", { messageId }, () => null);
}

function pinMessage(messageId) {
  socket.emit("room:pin", { roomName: state.current.roomName, messageId }, () => null);
}

function decorateMessageBody(content) {
  const escaped = escapeHtml(content || "");
  return escaped.replace(/@([a-zA-Z0-9_ -]{1,24})/g, '<span class="mention">@$1</span>');
}

function belongsToCurrentScope(message) {
  if (state.current.type === "room") {
    return message.scope === "room" && message.roomName === state.current.roomName;
  }
  if (message.scope !== "dm") return false;
  return (
    (message.senderNickname === state.current.targetNickname && message.targetUserId === state.userId) ||
    (message.senderId === state.userId && message.targetNickname === state.current.targetNickname)
  );
}

function transientNotice(text) {
  typingIndicatorEl.textContent = text;
  setTimeout(() => {
    if (typingIndicatorEl.textContent === text) typingIndicatorEl.textContent = "";
  }, 2200);
}

function autoResizeTextarea() {
  messageInputEl.style.height = "auto";
  messageInputEl.style.height = `${messageInputEl.scrollHeight}px`;
}

function mergeByMessageId(messages) {
  const map = new Map();
  for (const message of messages) map.set(message.id, message);
  return Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt);
}

function getScopeKey() {
  return state.current.type === "room" ? `room:${state.current.roomName}` : `dm:${state.current.targetNickname}`;
}

function isCurrentScopeMuted() {
  return Boolean(state.muteMap[getScopeKey()]);
}

function loadMuteMap() {
  try {
    const raw = localStorage.getItem(MUTE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistMuteMap(muteMap) {
  localStorage.setItem(MUTE_KEY, JSON.stringify(muteMap));
}

function loadDemoRooms() {
  try {
    const raw = localStorage.getItem(DEMO_ROOMS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistDemoRooms(rooms) {
  localStorage.setItem(DEMO_ROOMS_KEY, JSON.stringify(rooms));
}

function loadDemoMessages(scopeKey) {
  try {
    const raw = localStorage.getItem(DEMO_MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    return Array.isArray(parsed[scopeKey]) ? parsed[scopeKey] : [];
  } catch {
    return [];
  }
}

function persistDemoMessages(scopeKey, messages) {
  let parsed = {};
  try {
    const raw = localStorage.getItem(DEMO_MESSAGES_KEY);
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  parsed[scopeKey] = messages;
  localStorage.setItem(DEMO_MESSAGES_KEY, JSON.stringify(parsed));
}

function stableDemoUserId(nickname) {
  let hash = 0;
  for (let i = 0; i < nickname.length; i += 1) {
    hash = (hash * 31 + nickname.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) + 1;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
