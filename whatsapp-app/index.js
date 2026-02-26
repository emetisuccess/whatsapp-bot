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
const PQueue = require('p-queue').default;

// ================== CRASH SAFETY ==================
process.on('unhandledRejection', err => {
  console.error('❌ Unhandled rejection:', err);
});
process.on('uncaughtException', err => {
  console.error('❌ Uncaught exception:', err);
});

// ================== SYSTEM STATE ==================
const SYSTEM_STATE = {
  STARTING: 'starting',
  SYNCING: 'syncing',
  READY: 'ready'
};

let systemState = SYSTEM_STATE.STARTING;

// ================== APP SETUP ==================
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

console.log(`🚀 Starting WhatsApp instance: ${INSTANCE_ID}`);

// ================== STATE ==================
let isClientReady = false;
let latestQR = null;

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
const errorLogBuffer = new Set();

async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_USER_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_USER_ID,
        text: `🚨 *WhatsApp Server (${INSTANCE_ID})* 🚨\n\n${message}`,
        parse_mode: 'Markdown'
      })
    });
  } catch (err) {
    logger.warn("⚠️ Telegram alert failed:", err.message);
  }
}

function logAndBufferError(label, error) {
  const msg = `❌ ${label}:\n${error?.stack || error?.message || error}`;
  logger.error(msg);
  errorLogBuffer.add(msg);
}

setInterval(() => {
  if (!errorLogBuffer.size) return;
  const batched = Array.from(errorLogBuffer).join('\n\n').slice(0, 4000);
  sendTelegramAlert(batched);
  errorLogBuffer.clear();
}, ERROR_BATCH_INTERVAL);

// ================== API CLIENT ==================
const apiClient = axios.create({
  timeout: 10000
});

// ================== API QUEUE ==================
const apiQueue = new PQueue({
  concurrency: 2,
  interval: 1000,
  intervalCap: 10
});

// ================== CIRCUIT BREAKER ==================
let crmFailures = 0;
let crmBlockedUntil = 0;

function canCallCRM() {
  return Date.now() >= crmBlockedUntil;
}

function recordCRMFailure() {
  crmFailures++;
  if (crmFailures >= 5) {
    crmBlockedUntil = Date.now() + 2 * 60 * 1000;
    crmFailures = 0;
    logger.warn("🚫 CRM temporarily blocked");
  }
}

function recordCRMSuccess() {
  crmFailures = 0;
}

// ================== SAFE API CALL ==================
async function safeApiCall(fn) {
  if (!canCallCRM()) {
    logger.warn("Skipping CRM call – breaker open");
    return null;
  }

  try {
    const res = await apiQueue.add(fn);
    recordCRMSuccess();
    return res;
  } catch (err) {
    recordCRMFailure();
    throw err;
  }
}

// ================== WHATSAPP CLIENT ==================
const client = new Client({
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  },
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  },
  authStrategy: new LocalAuth({
    clientId: INSTANCE_ID,
    dataPath: SESSION_PATH
  })
});

client.on('browser_created', async (browser) => {
  const pages = await browser.pages();
  const page = pages[0];
  if (page) {
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
    );
  }
});

// ================== QR HANDLER ==================
client.on('qr', (qr) => {
  latestQR = qr;
  logger.info('QR Code generated');
  qrcode.generate(qr, { small: true });

  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(qr);
    }
  });
});

// ================== READY ==================
client.on('ready', () => {
  isClientReady = true;
  latestQR = null;
  systemState = SYSTEM_STATE.SYNCING;

  logger.info('WhatsApp ready – entering SYNCING mode');

  // warm-up window
  setTimeout(() => {
    systemState = SYSTEM_STATE.READY;
    logger.info('✅ System is now READY');
  }, 5 * 60 * 1000);
});

client.on('auth_failure', msg => {
  console.log('AUTH FAILURE:', msg);
});

client.on('loading_screen', (percent, message) => {
  console.log('LOADING:', percent, message);
});

client.on('disconnected', reason => {
  console.log('DISCONNECTED:', reason);
});

// ================== COMMAND ALLOWLIST ==================
const ALLOWED_COMMANDS = [
  /^REGISTER STAFF/i,
  /^UNIQUE_CODE_/i,
  /^ADD GROUP TO CRM/i
];

function isAllowedCommand(text) {
  return ALLOWED_COMMANDS.some(rgx => rgx.test(text));
}

// ================== MESSAGE HANDLER ==================
client.on('message', async (msg) => {
  try {
    const text = msg.body?.trim();
    if (!text) return;

    // 🚧 SYNC GATE
    if (systemState !== SYSTEM_STATE.READY) {
      if (!isAllowedCommand(text)) {
        logger.info(`⏳ Ignored during sync: ${text.slice(0, 40)}`);
        return;
      }
    }

    const rawFrom = msg.author || msg.from;

    // ================= STAFF REGISTRATION =================
    if (text.toUpperCase().startsWith("REGISTER STAFF")) {
      const parts = text.split("-");
      if (parts.length !== 3) {
        await msg.reply('⚠️ Use: REGISTER STAFF-phone-name');
        return;
      }

      const staffPhone = parts[1];
      const staffName = parts[2];
      const contact = await msg.getContact();
      const lid = contact.id._serialized;

      try {
        const res = await safeApiCall(() =>
          apiClient.post('https://elitegentessentials.com/api/map-staff', {
            lid, phone: staffPhone, name: staffName
          })
        );

        if (res?.data?.success) {
          await msg.reply(
            `✅ Hi ${staffName}, post this code in the group:\n\n🔑 *${res.data.code}*`
          );
        } else {
          await msg.reply(res?.data?.error || 'Registration failed');
        }
      } catch {
        await msg.reply('❌ Error processing registration.');
      }
      return;
    }

    // ================= UNIQUE CODE =================
    if (text.startsWith("UNIQUE_CODE_")) {
      try {
        const res = await safeApiCall(() =>
          apiClient.post(
            'https://elitegentessentials.com/api/map-staff-finalize',
            { code: text, group_lid: msg.from, lid: msg.author }
          )
        );

        const reply = res?.data?.success
          ? '✅ You’ve been successfully registered!'
          : '❌ Registration failed.';

        await client.sendMessage(res?.data?.sender_id || msg.from, reply);
      } catch {
        await client.sendMessage(
          msg.author || msg.from,
          '❌ Error finalizing registration.'
        );
      }
      return;
    }

    // ================= ADD GROUP =================
    if (text.toUpperCase().startsWith('ADD GROUP TO CRM -')) {
      if (!msg.from.includes('@g.us')) {
        await msg.reply('❌ Must be used in a group.');
        return;
      }

      const parts = text.split(' - ');
      if (parts.length < 3) {
        await msg.reply('⚠️ ADD GROUP TO CRM - Group Name - AgentPhone');
        return;
      }

      const groupName = parts[1].trim();
      const agentPhone = parts[2].replace(/\D/g, '');
      const groupId = msg.from;
      const sender = msg.author;

      if (!/^234\d{10}$/.test(agentPhone)) {
        await msg.reply('❌ Invalid phone: 234XXXXXXXXXX');
        return;
      }

      try {
        const res = await safeApiCall(() =>
          apiClient.post(
            'https://elitegentessentials.com/api/map-group-agent',
            { sender, group_id: groupId, group_name: groupName, agent_phone: agentPhone }
          )
        );

        await msg.reply(res?.data?.message || '✅ Agent mapped.');
      } catch {
        await msg.reply('❌ Failed to map group.');
      }
      return;
    }

  } catch (error) {
    logAndBufferError("Error in message handler", error);
  }
});

// ================== MESSAGE REACTION ==================
client.on('message_reaction', async (reaction) => {
  // ignore until fully ready
  if (systemState !== SYSTEM_STATE.READY) return;

  try {
    const msg = await client.getMessageById(reaction.msgId._serialized);
    if (!msg?.body) return;

    await safeApiCall(() =>
      apiClient.post(
        "https://elitegentessentials.com/api/checkReaction",
        { message: msg._data, reaction }
      )
    );
  } catch (err) {
    logAndBufferError("Error in message_reaction", err);
  }
});

// ================== SEND ORDER ==================
app.post("/send-order", async (req, res) => {
  if (!isClientReady) {
    return res.status(503).json({ error: "WhatsApp client not ready." });
  }

  try {
    let { channel, order, channel_type } = req.body || {};

    channel = typeof channel === "string" ? channel.trim() : "";
    order = typeof order === "string" ? order.trim() : "";
    channel_type = typeof channel_type === "string" ? channel_type.trim().toLowerCase() : "";

    if (!channel || !order) {
      return res.status(400).json({ error: "channel and order are required" });
    }

    // If it's already a WhatsApp ID, do not modify
    const isWid = channel.includes("@c.us") || channel.includes("@g.us");

    if (!isWid) {
      // If CRM passes raw phone numbers, they can only represent a DM.
      // Groups are not "numeric-only" IDs.
      if (/^\d{10,15}$/.test(channel)) {
        if (channel_type === "group") {
          return res.status(400).json({
            error: "Invalid channel: group messages require a @g.us chat id",
            hint: "Pass channel as the full group id like 1203...@g.us (not a phone number)."
          });
        }

        // default DM
        channel = `${channel}@c.us`;
      } else {
        // not numeric, not a wid => reject (prevents silent failures)
        return res.status(400).json({
          error: "Invalid channel format",
          hint: "Use a full WhatsApp chat id like 234...@c.us or 1203...@g.us"
        });
      }
    }

    // Workaround for WhatsApp Web changes that break sendSeen/markedUnread in some versions
    const result = await client.sendMessage(channel, order, { sendSeen: false });

    return res.json({ ok: true, to: channel, result });

  } catch (error) {
    logAndBufferError("Error sending order", error);
    return res.status(500).json({ error: "Failed to send order" });
  }
});


// ================== QR ENDPOINT ==================
app.get('/qr', (req, res) => {
  if (!latestQR) return res.json({ status: 'waiting' });
  res.json({ status: 'qr', qr: latestQR, instance: INSTANCE_ID });
});

// ================== STATUS ==================
app.get('/status', (req, res) => {
  res.json({ ready: isClientReady, state: systemState, instance: INSTANCE_ID });
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
