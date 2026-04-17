// ================== ENV CONFIG ==================
const INSTANCE_ID = process.env.INSTANCE_ID || "default_instance";
const SESSION_PATH = process.env.SESSION_PATH || "./sessions";
const HTTP_PORT = process.env.HTTP_PORT || 9000;
const WS_PORT = process.env.WS_PORT || 9090;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || "";
const ERROR_BATCH_INTERVAL = 10 * 60 * 1000;
const AUTH_TIMEOUT_MS = Number(process.env.AUTH_TIMEOUT_MS || 180000);
const BUILD_MARKER = "ping-debug-v3";

// ================== IMPORTS ==================
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");
const fetch = require("node-fetch");
const winston = require("winston");
const axios = require("axios");
const PQueue = require("p-queue").default;
const fs = require("fs"); // <-- IMPORTANT: moved to top
const path = require("path");

const SESSION_DIR = path.join(SESSION_PATH, `session-${INSTANCE_ID}`);

// ================== CRASH SAFETY ==================
process.on("unhandledRejection", (err) => {
  console.error("❌ Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
});

// ================== SYSTEM STATE ==================
const SYSTEM_STATE = {
  STARTING: "starting",
  SYNCING: "syncing",
  READY: "ready",
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
let lastEvent = {
  name: "startup",
  at: new Date().toISOString(),
  detail: BUILD_MARKER,
};

// ================== LOGGING ==================
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.simple() }),
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.File({ filename: "errors.log", level: "error" }),
  ],
});

// ================== TELEGRAM ALERTS ==================
const errorLogBuffer = new Set();

async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_USER_ID) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_USER_ID,
          text: `🚨 *WhatsApp Server (${INSTANCE_ID})* 🚨\n\n${message}`,
          parse_mode: "Markdown",
        }),
      },
    );
  } catch (err) {
    logger.warn("⚠️ Telegram alert failed:", err.message);
  }
}

function logAndBufferError(label, error) {
  const msg = `❌ ${label}:\n${error?.stack || error?.message || error}`;
  logger.error(msg);
  errorLogBuffer.add(msg);
}

function recordLastEvent(name, detail = "") {
  lastEvent = {
    name,
    at: new Date().toISOString(),
    detail: String(detail || "").slice(0, 200),
  };
}

function clearStaleChromiumLocks(sessionDir) {
  const lockFiles = [
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
    "DevToolsActivePort",
  ];

  for (const fileName of lockFiles) {
    const filePath = path.join(sessionDir, fileName);
    if (!fs.existsSync(filePath)) continue;

    try {
      fs.rmSync(filePath, { force: true });
      logger.warn(`🧹 Removed stale Chromium lock: ${fileName}`);
    } catch (error) {
      logAndBufferError(
        `Failed removing stale Chromium lock ${fileName}`,
        error,
      );
    }
  }
}

function truncateForLog(text, maxLength = 120) {
  if (typeof text !== "string") return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function getChatLabel(msg) {
  return msg.author || msg.from || "unknown-chat";
}

function getMessageMeta(msg) {
  return {
    chatId: msg.from || "unknown-chat",
    sender: msg.author || msg.from || "unknown-sender",
    fromMe: Boolean(msg.fromMe),
    isGroup: typeof msg.from === "string" && msg.from.endsWith("@g.us"),
    type: msg.type || "unknown",
    hasAuthor: Boolean(msg.author),
  };
}

function logIncomingMessage(eventName, msg, text) {
  const meta = getMessageMeta(msg);
  logger.info(
    `${eventName} chat=${meta.chatId} sender=${meta.sender} fromMe=${meta.fromMe} isGroup=${meta.isGroup} type=${meta.type} hasAuthor=${meta.hasAuthor} text=${truncateForLog(text)}`,
  );
}

async function resolveChatId(msg) {
  if (msg.fromMe && msg.to && msg.to !== "status@broadcast") {
    return msg.to;
  }

  if (msg.from && msg.from !== "status@broadcast") return msg.from;
  if (msg.to) return msg.to;

  const chat = await msg.getChat();
  return chat?.id?._serialized || null;
}

async function replyWithLog(msg, responseText) {
  const result = await msg.reply(responseText);
  logger.info(
    `↩️ Reply sent to ${getChatLabel(msg)}: ${truncateForLog(responseText)}`,
  );
  return result;
}

async function sendMessageWithLog(chatId, responseText, options) {
  const result = await client.sendMessage(chatId, responseText, options);
  logger.info(`📤 Message sent to ${chatId}: ${truncateForLog(responseText)}`);
  return result;
}

setInterval(() => {
  if (!errorLogBuffer.size) return;
  const batched = Array.from(errorLogBuffer).join("\n\n").slice(0, 4000);
  sendTelegramAlert(batched);
  errorLogBuffer.clear();
}, ERROR_BATCH_INTERVAL);

// ================== API CLIENT ==================
const apiClient = axios.create({
  timeout: 10000,
});

// ================== API QUEUE ==================
const apiQueue = new PQueue({
  concurrency: 2,
  interval: 1000,
  intervalCap: 10,
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
  authTimeoutMs: AUTH_TIMEOUT_MS,
  puppeteer: {
    timeout: AUTH_TIMEOUT_MS,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
  authStrategy: new LocalAuth({
    clientId: INSTANCE_ID,
    dataPath: SESSION_PATH,
  }),
});

// (Optional) You can remove browser_created entirely – the library sets a good user agent
// client.on('browser_created', async (browser) => { ... });

// ================== QR HANDLER ==================
client.on("qr", (qr) => {
  latestQR = qr;
  recordLastEvent("qr", INSTANCE_ID);
  logger.info(`📲 QR Code generated for ${INSTANCE_ID}`);
  qrcode.generate(qr, { small: true });

  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(qr);
    }
  });
});

// ================== AUTHENTICATION EVENTS ==================
client.on("authenticated", () => {
  recordLastEvent("authenticated", INSTANCE_ID);
  logger.info("✅ Authenticated successfully");
});

client.on("change_state", (state) => {
  recordLastEvent("change_state", state);
  logger.info(`🔄 WhatsApp state changed: ${state}`);
});

client.on("auth_failure", (msg) => {
  recordLastEvent("auth_failure", msg);
  logger.error("❌ Authentication failure:", msg);
  errorLogBuffer.add(`Auth failure: ${msg}`);
});

// ================== LOADING SCREEN ==================
client.on("loading_screen", (percent, message) => {
  recordLastEvent("loading_screen", `${percent}% ${message}`);
  logger.info(`⏳ Loading: ${percent}% - ${message}`);
});

// ================== READY ==================
client.on("ready", () => {
  isClientReady = true;
  latestQR = null;
  systemState = SYSTEM_STATE.SYNCING;
  recordLastEvent("ready", INSTANCE_ID);

  logger.info("🎉 WhatsApp ready – entering SYNCING mode");

  // Warm-up window before allowing commands
  setTimeout(
    () => {
      systemState = SYSTEM_STATE.READY;
      logger.info("✅ System is now READY");
    },
    // 5 * 60 * 1000,
    10,
  );
});

// ================== DISCONNECTED ==================
client.on("disconnected", (reason) => {
  recordLastEvent("disconnected", reason);
  logger.warn("⚠️ Client disconnected:", reason);
  isClientReady = false;
  systemState = SYSTEM_STATE.STARTING;
  // Optionally reinitialize after a delay:
  // setTimeout(() => client.initialize(), 10000);
});

client.on("remote_session_saved", () => {
  recordLastEvent("remote_session_saved", INSTANCE_ID);
  logger.info("💾 WhatsApp session saved");
});

// ================== COMMAND ALLOWLIST ==================
const ALLOWED_COMMANDS = [
  /^REGISTER STAFF/i,
  /^UNIQUE_CODE_/i,
  /^ADD GROUP TO CRM/i,
];

function isAllowedCommand(text) {
  return ALLOWED_COMMANDS.some((rgx) => rgx.test(text));
}

// ================== MESSAGE HANDLER ==================
client.on("message", async (msg) => {
  const text = msg.body?.trim();
  if (!text) return;

  recordLastEvent("message", text);
  logIncomingMessage("📩 message", msg, text);

  if (text.toUpperCase() === "PING") {
    await replyWithLog(msg, "PONG");
    return;
  }

  try {
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
        await replyWithLog(msg, "⚠️ Use: REGISTER STAFF-phone-name");
        return;
      }

      const staffPhone = parts[1];
      const staffName = parts[2];
      const contact = await msg.getContact();
      const lid = contact.id._serialized;

      try {
        const res = await safeApiCall(() =>
          apiClient.post("https://www.elitely.io/api/map-staff", {
            lid,
            phone: staffPhone,
            name: staffName,
          }),
        );

        if (res?.data?.success) {
          await replyWithLog(
            msg,
            `✅ Hi ${staffName}, post this code in the group:\n\n🔑 *${res.data.code}*`,
          );
        } else {
          await replyWithLog(msg, res?.data?.error || "Registration failed");
        }
      } catch {
        await replyWithLog(msg, "❌ Error processing registration.");
      }
      return;
    }

    // ================= UNIQUE CODE =================
    if (text.startsWith("UNIQUE_CODE_")) {
      try {
        const res = await safeApiCall(() =>
          apiClient.post("https://www.elitely.io/api/map-staff-finalize", {
            code: text,
            group_lid: msg.from,
            lid: msg.author,
          }),
        );

        const reply = res?.data?.success
          ? "✅ You’ve been successfully registered!"
          : "❌ Registration failed.";

        await sendMessageWithLog(res?.data?.sender_id || msg.from, reply);
      } catch {
        await sendMessageWithLog(
          msg.author || msg.from,
          "❌ Error finalizing registration.",
        );
      }
      return;
    }

    // ================= ADD GROUP =================
    if (text.toUpperCase().startsWith("ADD GROUP TO CRM -")) {
      if (!msg.from.includes("@g.us")) {
        await replyWithLog(msg, "❌ Must be used in a group.");
        return;
      }

      const parts = text.split(" - ");
      if (parts.length < 3) {
        await replyWithLog(
          msg,
          "⚠️ ADD GROUP TO CRM - Group Name - AgentPhone",
        );
        return;
      }

      const groupName = parts[1].trim();
      const agentPhone = parts[2].replace(/\D/g, "");
      const groupId = msg.from;
      const sender = msg.author;

      if (!/^234\d{10}$/.test(agentPhone)) {
        await replyWithLog(msg, "❌ Invalid phone: 234XXXXXXXXXX");
        return;
      }

      try {
        const res = await safeApiCall(() =>
          apiClient.post("https://www.elitely.io/api/map-group-agent", {
            sender,
            group_id: groupId,
            group_name: groupName,
            agent_phone: agentPhone,
          }),
        );

        await replyWithLog(msg, res?.data?.message || "✅ Agent mapped.");
      } catch {
        await replyWithLog(msg, "❌ Failed to map group.");
      }
      return;
    }
  } catch (error) {
    logAndBufferError("Error in message handler", error);
  }
});

client.on("message_create", async (msg) => {
  const text = msg.body?.trim();
  if (!text || !msg.fromMe) return;

  recordLastEvent("message_create", text);
  logIncomingMessage("📝 message_create", msg, text);

  if (text.toUpperCase() !== "PING") return;

  try {
    const chatId = await resolveChatId(msg);
    if (!chatId) {
      logger.warn("⚠️ Could not resolve chat for self-sent PING");
      return;
    }

    logger.info(
      `🧭 Self-sent PING resolved chat=${chatId} from=${msg.from || ""} to=${msg.to || ""}`,
    );

    await sendMessageWithLog(chatId, "PONG");
  } catch (error) {
    logAndBufferError("Error handling self-sent PING", error);
  }
});

// ================== MESSAGE REACTION ==================
client.on("message_reaction", async (reaction) => {
  // ignore until fully ready
  if (systemState !== SYSTEM_STATE.READY) return;

  try {
    const msg = await client.getMessageById(reaction.msgId._serialized);
    if (!msg?.body) return;

    await safeApiCall(() =>
      apiClient.post("https://www.elitely.io/api/checkReaction", {
        message: msg._data,
        reaction,
      }),
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
    channel_type =
      typeof channel_type === "string" ? channel_type.trim().toLowerCase() : "";

    if (!channel || !order) {
      return res.status(400).json({ error: "channel and order are required" });
    }

    // If it's already a WhatsApp ID, do not modify
    const isWid = channel.includes("@c.us") || channel.includes("@g.us");

    if (!isWid) {
      // If CRM passes raw phone numbers, they can only represent a DM.
      if (/^\d{10,15}$/.test(channel)) {
        if (channel_type === "group") {
          return res.status(400).json({
            error: "Invalid channel: group messages require a @g.us chat id",
            hint: "Pass channel as the full group id like 1203...@g.us (not a phone number).",
          });
        }
        // default DM
        channel = `${channel}@c.us`;
      } else {
        return res.status(400).json({
          error: "Invalid channel format",
          hint: "Use a full WhatsApp chat id like 234...@c.us or 1203...@g.us",
        });
      }
    }

    const result = await client.sendMessage(channel, order, {
      sendSeen: false,
    });
    logger.info(`📤 Order sent to ${channel}: ${truncateForLog(order)}`);
    return res.json({ ok: true, to: channel, result });
  } catch (error) {
    logAndBufferError("Error sending order", error);
    return res.status(500).json({ error: "Failed to send order" });
  }
});

// ================== QR ENDPOINT ==================
app.get("/qr", (req, res) => {
  if (!latestQR) return res.json({ status: "waiting" });
  res.json({ status: "qr", qr: latestQR, instance: INSTANCE_ID });
});

// ================== STATUS ==================
app.get("/status", (req, res) => {
  res.json({
    ready: isClientReady,
    state: systemState,
    instance: INSTANCE_ID,
    build: BUILD_MARKER,
    hasQr: Boolean(latestQR),
    clientInfo: client.info?.wid?._serialized || null,
    lastEvent,
  });
});

// ================== HEALTH ==================
app.get("/", (req, res) => {
  res.status(200).json({ message: "success", instance: INSTANCE_ID });
});

// ================== START SERVERS ==================
server.listen(WS_PORT, () => logger.info(`WebSocket running on ${WS_PORT}`));

app.listen(HTTP_PORT, () => logger.info(`HTTP running on ${HTTP_PORT}`));

// ================== CHECK SESSION DIRECTORY ==================
if (fs.existsSync(SESSION_DIR)) {
  logger.info(`📁 Session directory exists: ${SESSION_DIR}`);
  clearStaleChromiumLocks(SESSION_DIR);
} else {
  logger.info(`📁 No existing session for ${INSTANCE_ID}`);
}

// ================== INIT ==================
client.initialize().catch((error) => {
  if (String(error).includes("auth timeout")) {
    logAndBufferError(
      "WhatsApp initialization failed",
      `auth timeout after ${AUTH_TIMEOUT_MS}ms. Scan the latest QR promptly or recreate the session.`,
    );
    return;
  }

  logAndBufferError("WhatsApp initialization failed", error);
});
