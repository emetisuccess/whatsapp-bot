// ================== ENV CONFIG ==================
const INSTANCE_ID = process.env.INSTANCE_ID || 'default_instance';
const SESSION_PATH = process.env.SESSION_PATH || './sessions';
const HTTP_PORT = process.env.HTTP_PORT || 9000;
const WS_PORT = process.env.WS_PORT || 9090;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || '';
const ERROR_BATCH_INTERVAL = 10 * 60 * 1000;

// ================== IMPORTS ==================
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fetch = require('node-fetch');
const winston = require('winston');
const axios = require('axios');

// ================== APP SETUP ==================
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

console.log(`🚀 Starting WhatsApp instance: ${INSTANCE_ID}`);

// ================== STATE ==================
let isClientReady = false;
let latestQR = null;

const reactionCache = [];
let cachingEnabled = true;
const errorLogBuffer = new Set();

// ================== LOGGING ==================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.simple() }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.File({ filename: 'errors.log', level: 'error' })
  ]
});

// ================== TELEGRAM ALERTS ==================
async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_USER_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_USER_ID,
        text: `🚨 *Error Alert from WhatsApp Server (${INSTANCE_ID})* 🚨\n\n${message}`,
        parse_mode: 'Markdown'
      })
    });
  } catch (err) {
    logger.warn("⚠️ Failed to send Telegram alert:", err.message);
  }
}

function logAndBufferError(label, error) {
  const msg = `❌ ${label}:\n${error?.stack || error?.message || error}`;
  logger.error(msg);
  errorLogBuffer.add(msg);
}

// Batch error alerts
setInterval(() => {
  if (errorLogBuffer.size === 0) return;

  const batchedMsg = Array.from(errorLogBuffer).join('\n\n').slice(0, 4000);
  sendTelegramAlert(batchedMsg);
  errorLogBuffer.clear();
}, ERROR_BATCH_INTERVAL);

// ================== WHATSAPP CLIENT ==================
const client = new Client({
  puppeteer: {
    headless: true,
    args: ['--no-sandbox']
  },
  authStrategy: new LocalAuth({
    clientId: INSTANCE_ID,
    dataPath: SESSION_PATH
  })
});

// ================== QR HANDLER ==================
client.on('qr', (qr) => {
  latestQR = qr; // store latest QR

  logger.info('QR Code generated');
  qrcode.generate(qr, { small: true });

  wss.clients.forEach(wsClient => {
    if (wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(qr);
    }
  });
});

// ================== READY ==================
client.on('ready', () => {
  isClientReady = true;
  latestQR = null; // clear QR once connected
  logger.info('WhatsApp Client is Ready');
});

// ================== GROUP EVENTS ==================
client.on('group_join', (notification) => {
  logger.info('User joined group', { group: notification.chatId });
  notification.reply('Hi, welcome and thank you for joining us.');
});

client.on('group_leave', (notification) => {
  logger.info('User left group', { group: notification.chatId });
  notification.reply('Who has left us o?');
});

// ================== MESSAGE HANDLER ==================
client.on('message', async (msg) => {
  try {
    const message = msg.body?.trim();
    if (!message) return;

    // ---- keep your business logic here ----

  } catch (error) {
    console.error('❌ Error in onMessage:', error.message);
  }
});

// ================== MESSAGE REACTION ==================
client.on('message_reaction', async (reaction) => {
  if (cachingEnabled) {
    reactionCache.push(reaction);
    logger.info('Reaction cached temporarily');
    return;
  }

  try {
    const msg = await client.getMessageById(reaction.msgId._serialized);
    if (!msg || !msg.body) {
      logAndBufferError("Reaction message missing", new Error("No body"));
      return;
    }

    const payload = { message: msg._data, reaction };

    await fetch("https://elitegentessentials.com/api/checkReaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

  } catch (err) {
    logAndBufferError("Unhandled error in message_reaction", err);
  }
});

// ================== CACHE FLUSH ==================
setTimeout(() => {
  cachingEnabled = false;
  logger.info("⌛ Caching window ended.");
  reactionCache.length = 0;
}, 60 * 60 * 500);

// ================== SEND ORDER ==================
app.post("/send-order", async (req, res) => {
  if (!isClientReady) {
    return res.status(503).json({ error: "WhatsApp client is not ready." });
  }

  try {
    const { channel, order } = req.body;
    const result = await client.sendMessage(channel, order);
    res.json(result);
  } catch (error) {
    logAndBufferError("Error sending WhatsApp order", error);
    res.status(500).json({ error: "Failed to send order" });
  }
});

// ================== QR ENDPOINT ==================
app.get('/qr', (req, res) => {
  if (!latestQR) {
    return res.json({ status: 'waiting' });
  }

  res.json({
    status: 'qr',
    qr: latestQR,
    instance: INSTANCE_ID
  });
});

// ================== STATUS ENDPOINT ==================
app.get('/status', (req, res) => {
  res.json({
    ready: isClientReady,
    instance: INSTANCE_ID
  });
});

// ================== HEALTH ==================
app.get("/", (req, res) => {
  res.status(200).json({ message: "success", instance: INSTANCE_ID });
});

// ================== START SERVERS ==================
server.listen(WS_PORT, () =>
  logger.info(`WebSocket running on ${WS_PORT}`)
);

app.listen(HTTP_PORT, () =>
  logger.info(`HTTP running on ${HTTP_PORT}`)
);

// ================== INIT ==================
client.initialize();

