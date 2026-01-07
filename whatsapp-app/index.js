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

    const message = msg.body.trim();
    const rawFrom = msg.author || msg.from; // Could be @lid or @c.us
    const lidId = rawFrom; // Always use this as unique ID

    try {
        // Step 1: Handle DM staff registration
        if (msg.body && msg.body.toUpperCase().startsWith("REGISTER STAFF")) {
            const parts = msg.body.trim().split("-");
            if (parts.length === 3) {
                const staffName = parts[2];
                const staffPhone = parts[1];

                const contact = await msg.getContact();
                const lidId = contact.id._serialized;

                const payload = {
                    lid: lidId,
                    phone: staffPhone,
                    name: staffName,
                };

                const response = await axios.post('https://elitegentessentials.com/api/map-staff', payload);

                if (response.data && response.data.success) {
                    const code = response.data.code;
                    await msg.reply(`✅ Hi ${staffName}, you're almost done! Please copy this code and post it in the group:\n\n🔑 *${code}*`);
                } else {
                    await msg.reply(response.data.error);
                }
            } else {
                await msg.reply('⚠️ Invalid format. Use: REGISTER STAFF-phone-name');
            }
        }

        // Step 2: Detect unique code posted in group for final mapping
        // Step 2: Detect unique code posted in group for final mapping
        if (msg.body && msg.body.startsWith("UNIQUE_CODE_")) {
            const code = msg.body.trim();

            // Get sender's contact ID (not the group ID)
            const senderId = msg.author || msg.from; // msg.author is available in group chats
            // const contact = await client.getContactById(senderId);

            const payload = {
                code: code,
                group_lid: msg.from,
                lid: msg.author,
                msg: msg,
            };

            try {
                const res = await axios.post('https://elitegentessentials.com/api/map-staff-finalize', payload);

                const responseMsg = res.data?.success
                    ? '✅ You’ve been successfully registered!'
                    : '❌ Could not complete your registration. Please try again or contact support.';

                // Send DM to user directly
                await client.sendMessage(res.data.sender_id, responseMsg);
            } catch (error) {
                console.error('Error verifying code:', error.message);
                await client.sendMessage(senderId, '❌ Something went wrong while processing your registration.');
            }
        }


   } catch (error) {
        console.error('❌ Error in onMessage:', error.message);
    }

    // 2. Business owner adding group and agent
    if (message.toUpperCase().startsWith('ADD GROUP TO CRM -')) {
        if (!msg.from.includes('@g.us')) {
            await msg.reply('❌ This command must be used **inside a group chat**.');
            return;
        }

        const parts = message.split(' - ');
        if (parts.length < 3) {
            await msg.reply('⚠️ Invalid format. Use:\n\n*ADD GROUP TO CRM - Group Name - AgentPhone*');
            return;
        }

        const groupName = parts[1].trim();
        const agentPhoneRaw = parts[2].trim();
        const agentPhone = agentPhoneRaw.replace(/\D/g, '');
        const groupId = msg.from;
        const senderPhone = msg.to;
        const sender = msg.author;

        if (!/^234\d{10}$/.test(agentPhone)) {
            await msg.reply('❌ Invalid agent phone number. Must be in 234XXXXXXXXXX format.');
            return;
        }

        console.log(`📥 Group mapping request by ${senderPhone} for group "${groupName}" and agent ${agentPhone}`);

        try {
            const res = await axios.post('https://elitegentessentials.com/api/map-group-agent', {
                sender: sender,
                group_id: groupId,
                group_name: groupName,
                agent_phone: agentPhone,
            });

            const data = res.data;
            if (data.status === 'success') {
                await msg.reply(data.message || '✅ Agent mapped to group successfully.');
            } else {
                await msg.reply(data.message || '⚠️ Unexpected response from server.');
            }

        } catch (err) {
            console.error('❌ Group Mapping Error:', err.response?.data || err.message);

            if (err.response) {
                const errorData = err.response.data;
                if (errorData.message) {
                    await msg.reply(`❌ ${errorData.message}`);
                } else if (errorData.errors) {
                    const errorMessages = Object.values(errorData.errors).flat().join('\n');
                    await msg.reply(`❌ Validation failed:\n${errorMessages}`);
                } else {
                    await msg.reply('❌ Failed to map group due to server error.');
                }
            } else {
               // await msg.reply('❌ Network error or server unreachable.');
            }
        }

        return;
    }

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

