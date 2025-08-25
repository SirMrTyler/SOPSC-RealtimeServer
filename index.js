const WebSocket = require('ws');
const wws = new WebSocket.Server({ port: 3001 });

wss.on('connection', () => {
  console.log('User has connected.');
});