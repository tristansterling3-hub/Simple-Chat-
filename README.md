# Simple-Chat-
A small chat room using these requirements

User Requirements 

1. Users can join the chat with a unique nickname or account login. 
2. Users can see a list of online users. 
3. Users can send public messages to the room. 
4. Users can send private direct messages. 
5. Users can see timestamps on messages. 
6. Users can see delivery status (sent/received). 
7. Users can create/join named rooms. 
8. Users can mute notifications per room or DM. 
9. Users can mention others with @nickname. 
10. Users can react to messages (e.g., ). 

Users can edit their last message within a short window. 

Users can delete their own messages. 

Users can search chat history by keyword. 

Users can upload and send images/files. 

Users can see typing indicators per room/DM. 

Users can block another user. 

Moderators can kick/ban users from a room. 

Moderators can delete any message in a room they moderate. 

Users can pin important messages. 

Users can view basic room stats (member count, messages/day). 

 

System Requirements 
1. The system shall deliver near–real-time messages using WebSockets. 
2. The system shall persist message history with pagination. 
3. The system shall limit message size and file types by configuration. 
4. The system shall store metadata (sender, room, timestamp, edited flag). 
5. The system shall handle reconnects and message replay within 10 seconds. 

The system shall ensure nickname uniqueness per room. 

The system shall support rate limiting to prevent spam. 

The system shall encrypt data in transit (TLS) and encrypt stored files. 

The system shall log moderator actions (kick/ban/delete). 

The system shall retain deleted messages’ audit metadata for 30 days. 
