# Simple Chat Pro

Realtime chat app with rooms, direct messages, moderation, persistence, and file handling.

## Run

1. Install Node.js 20+.
2. In this folder run:
   - `npm install`
   - `npm start`
3. Open `http://localhost:3000`.

## Configuration

Environment variables:

- `PORT` (default `3000`)
- `MAX_MESSAGE_LENGTH` (default `500`)
- `MAX_FILE_SIZE` bytes (default `5242880`)
- `ALLOWED_FILE_TYPES` comma list (default `image/png,image/jpeg,image/webp,application/pdf,text/plain`)
- `EDIT_WINDOW_MS` (default `120000`)
- `RATE_LIMIT_COUNT` (default `15`)
- `RATE_LIMIT_WINDOW_MS` (default `10000`)
- `FILE_ENC_KEY_HEX` 64 hex chars for AES-256-GCM at-rest file encryption

## Requirement Mapping

### User Requirements

1. Unique nickname join: yes (`session:start`, uniqueness enforced for active users).
2. Online users list: yes (`presence:update`).
3. Public room messages: yes.
4. Direct messages: yes (`scope: dm`).
5. Message timestamps: yes.
6. Delivery status: yes (`chat:delivery`, sent/received).
7. Named rooms create/join: yes.
8. Mute per room/DM: yes (client mute map per scope).
9. `@nickname` mentions: yes (render + parsing metadata).
10. Reactions: yes.
11. Edit own last message in window: yes (`chat:editLast` + time window).
12. Delete own messages: yes.
13. Search by keyword: yes (`chat:search`).
14. Upload/send images/files: yes (`/api/upload` + attachment metadata).
15. Typing indicators room/DM: yes.
16. Block user: yes.
17. Moderators kick/ban: yes.
18. Moderators delete any room message: yes.
19. Pin important messages: yes.
20. Room stats member count/messages day: yes.

### System Requirements

1. Near-real-time via WebSockets: yes (Socket.IO).
2. Persistent history + pagination: yes (SQLite + `chat:history` with cursors).
3. Config message/file limits: yes (env-driven policy checks).
4. Metadata (sender/room/timestamp/edited): yes (message schema).
5. Reconnect/replay within 10 seconds: yes (room replay window on join/rejoin).
6. Nickname uniqueness per room: satisfied by stricter active-nickname uniqueness.
7. Rate limiting: yes (per-user token bucket window).
8. TLS in transit + encrypted stored files: file encryption implemented; TLS must be enabled in deployment (HTTPS/WSS reverse proxy).
9. Moderator action logging: yes (`moderation_logs`).
10. Deleted message audit metadata retention 30 days: yes (`deleted_messages_audit` + cleanup on startup).

## Notes

- TLS is deployment-level; run behind HTTPS (e.g., Nginx/Caddy) for full in-transit encryption.
- SQLite DB file: `chat.sqlite`.
- Encrypted file blobs stored in `uploads/`.
