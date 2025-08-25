const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 3001 });

wss.on('connection', () => {
  console.log('User has connected.');
});