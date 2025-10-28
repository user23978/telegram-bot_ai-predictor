import 'dotenv/config';
import http from 'node:http';

import { startBot } from './bot/bot.js';

const port = Number(process.env.PORT) || 8080;

startBot().catch((error) => {
  console.error('Failed to start Telegram bot:', error);
  process.exitCode = 1;
});

const server = http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

server.listen(port, () => {
  console.log(`Healthcheck server listening on ${port}`);
});
