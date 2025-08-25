const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const { Expo } = require('expo-server-sdk');
const dotenv = require('dotenv');

const envFile = process.env.NODE_ENV === 'production'
  ? '.env'
  : '.env.development';

dotenv.config({ path: envFile });

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;
let server;
let protocol;

if (process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH) {
  const key = fs.readFileSync(process.env.SSL_KEY_PATH);
  const cert = fs.readFileSync(process.env.SSL_CERT_PATH);
  const server = https.createServer({key, cert}, app);
  protocol = 'https';
} else {
  server = http.createServer(app);
  protocol = 'http';
}

const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

const expo = new Expo();

// Map of userId -> number of active sockets
const activeSockets = {};

async function getPushTokens(userId) {
  const baseUrl = process.env.EXPO_PUBLIC_SOCKET_URL || 'http://localhost:5000';
  try {
    const res = await fetch(`${baseUrl}/api/notifications/token/${userId}`);
    if (!res.ok) {
      console.error(`[push] Failed to fetch tokens for user ${userId}: status ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.items?.map(t => t.expoPushToken).filter(Boolean) || [];
  } catch (err) {
    console.error(`[push] Error fetching tokens for user ${userId}:`, err);
    return [];
  }
}

async function sendPushWithRetry(expoPushToken, messageContent) {
  if (!Expo.isExpoPushToken(expoPushToken)) {
    console.warn(`[push] Invalid Expo push token: ${expoPushToken}`);
    return;
  }

  const message = {
    to: expoPushToken,
    title: 'New message',
    body: messageContent,
  };

  let delay = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const ticket = await expo.sendPushNotificationsAsync([message]);
      console.log(`[push] Sent to ${expoPushToken}`, ticket);
      return;
    } catch (err) {
      if (err?.statusCode === 429 && attempt < 4) {
        console.warn(`[push] Rate limited sending to ${expoPushToken}. retrying in ${delay}ms`);
        await new Promise(res => setTimeout(res, delay));
        delay *= 2;
      } else {
        console.error(`[push] Failed to send to ${expoPushToken}`, err);
        return;
      }
    }
  }
}

io.on('connection', socket => {
  const { userId } = socket.handshake.query;
  console.log(`[socket.io] New connection: socket.id=${socket.id}, userId=${userId}`);

  if (userId) {
    socket.join(`user:${userId}`);
    activeSockets[userId] = (activeSockets[userId] || 0) + 1;
    console.log(
      `[socket.io] Joined room user:${userId}; active connections=${activeSockets[userId]}`
    );

    socket.on('disconnect', () => {
      activeSockets[userId] = (activeSockets[userId] || 1) - 1;
      if (activeSockets[userId] <= 0) {
        delete activeSockets[userId];
      }
      console.log(
        `[socket.io] socket.id=${socket.id} disconnected; user:${userId} connections=${activeSockets[userId] || 0}`
      );
    });
  }

  // Handle direct message
  socket.on('sendDirectMessage', async payload => {
    const { recipientId, senderId, messageContent } = payload;
    console.log(`[sendDirectMessage] ${senderId} → ${recipientId}: ${messageContent}`);

    if (recipientId) {
      io.to(`user:${recipientId}`).emit('newDirectMessage', payload);

      const active = activeSockets[recipientId] || 0;
      if (active === 0) {
        const tokens = await getPushTokens(recipientId);
        await Promise.all(tokens.map(token => sendPushWithRetry(token, messageContent)));
      } else {
        console.log(
          `[sendDirectMessage] recipient ${recipientId} has ${active} active socket(s); skipping push`
        );
      }
    }
  });

  // Handle group message
  socket.on('sendGroupMessage', payload => {
    const { groupChatId } = payload;
    console.log(`[sendGroupMessage] Group ${groupChatId}: ${payload.messageContent}`);
    if (groupChatId) {
      io.to(`group:${groupChatId}`).emit('newGroupMessage', payload);
    }
  });

  // Handle direct message read status
  socket.on('directMessageRead', payload => {
    const { messageId, senderId, readerId } = payload;
    console.log(`[directMessageRead] messageId=${messageId} read by ${readerId}`);
    if (senderId) {
      io.to(`user:${senderId}`).emit('directMessageRead', payload);
    }
  });

  // Handle group join
  socket.on('joinGroup', ({ groupChatId }) => {
    console.log(`[joinGroup] socket.id=${socket.id} joining group:${groupChatId}`);
    if (groupChatId) {
      socket.join(`group:${groupChatId}`);
    }
  });
});

const SOCKET_URL = 
  process.env.EXPO_PUBLIC_SOCKET_URL || `${protocol}://localhost:${PORT}`;

server.listen(PORT, () => {
  console.log(`✅ Socket server running on address ${SOCKET_URL}`);
  console.log(`✅ Socket server running on port ${PORT}`);
});
