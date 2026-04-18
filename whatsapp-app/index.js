const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");
const fetch = require("node-fetch");
const winston = require("winston");
const axios = require("axios");
const PQueue = require("p-queue").default;
const fs = require("fs");
const path = require("path");

function positiveNumberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const INSTANCE_ID = process.env.INSTANCE_ID || "default_instance";
const SESSION_PATH = process.env.SESSION_PATH || "./sessions";
const HTTP_PORT = positiveNumberFromEnv(process.env.HTTP_PORT, 9000);
const WS_PORT = positiveNumberFromEnv(process.env.WS_PORT, 9090);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || "";
const ERROR_BATCH_INTERVAL = positiveNumberFromEnv(
  process.env.ERROR_BATCH_INTERVAL,
  10 * 60 * 1000,
);
const AUTH_TIMEOUT_MS = positiveNumberFromEnv(
  process.env.AUTH_TIMEOUT_MS,
  180000,
);
const READY_DELAY_MS = nonNegativeNumberFromEnv(process.env.READY_DELAY_MS, 0);
const CRM_REQUEST_TIMEOUT_MS = positiveNumberFromEnv(
  process.env.CRM_REQUEST_TIMEOUT_MS,
  10000,
);
const HTTP_BODY_LIMIT = process.env.HTTP_BODY_LIMIT || "256kb";
const BUILD_MARKER = process.env.BUILD_MARKER || "whatsapp-service";
const TEMPORARY_UNAVAILABLE_MESSAGE =
  "Service temporarily unavailable. Please try again shortly.";
const CRM_ENDPOINTS = {
  mapStaff: process.env.MAP_STAFF_URL || "https://www.elitely.io/api/map-staff",
  mapStaffFinalize:
    process.env.MAP_STAFF_FINALIZE_URL ||
    "https://www.elitely.io/api/map-staff-finalize",
  mapGroupAgent:
    process.env.MAP_GROUP_AGENT_URL ||
    "https://www.elitely.io/api/map-group-agent",
  checkReaction:
    process.env.CHECK_REACTION_URL ||
    "https://www.elitely.io/api/checkReaction",
};

const SESSION_DIR = path.join(SESSION_PATH, `session-${INSTANCE_ID}`);
const SYSTEM_STATE = {
  STARTING: "starting",
  SYNCING: "syncing",
  READY: "ready",
};
const ALLOWED_COMMANDS = [
  /^REGISTER STAFF/i,
  /^UNIQUE_CODE_/i,
  /^ADD GROUP TO CRM/i,
];

let systemState = SYSTEM_STATE.STARTING;
let isClientReady = false;
let latestQR = null;
let initErrorMessage = null;
let readyTimer = null;
let shutdownInProgress = false;
let lastEvent = {
  name: "startup",
  at: new Date().toISOString(),
  detail: BUILD_MARKER,
};

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

const loggerTransports = [
  new winston.transports.Console({ format: winston.format.simple() }),
];

if (process.env.ENABLE_FILE_LOGS !== "false") {
  loggerTransports.push(
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.File({ filename: "errors.log", level: "error" }),
  );
}

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: loggerTransports,
});

const app = express();
const server = http.createServer(app);
const wss =
  WS_PORT === HTTP_PORT
    ? new WebSocket.Server({ server })
    : new WebSocket.Server({ port: WS_PORT });

app.use(express.json({ limit: HTTP_BODY_LIMIT }));

console.log(`Starting WhatsApp instance: ${INSTANCE_ID}`);

const errorLogBuffer = new Set();

function recordLastEvent(name, detail = "") {
  lastEvent = {
    name,
    at: new Date().toISOString(),
    detail: String(detail || "").slice(0, 200),
  };
}

function clearReadyTimer() {
  if (!readyTimer) return;
  clearTimeout(readyTimer);
  readyTimer = null;
}

function scheduleReadyState() {
  clearReadyTimer();

  if (READY_DELAY_MS === 0) {
    systemState = SYSTEM_STATE.READY;
    logger.info("System is now READY");
    return;
  }

  logger.info(`Waiting ${READY_DELAY_MS}ms before entering READY mode`);

  readyTimer = setTimeout(() => {
    readyTimer = null;
    systemState = SYSTEM_STATE.READY;
    logger.info("System is now READY");
  }, READY_DELAY_MS);
}

function ensureDirectoryExists(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

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
          text: `WhatsApp Server (${INSTANCE_ID})\n\n${message}`,
        }),
      },
    );
  } catch (error) {
    logger.warn(`Telegram alert failed: ${error.message}`);
  }
}

function logAndBufferError(label, error) {
  const message = `${label}:\n${error?.stack || error?.message || error}`;
  logger.error(message);
  errorLogBuffer.add(message);
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
      logger.warn(`Removed stale Chromium lock: ${fileName}`);
    } catch (error) {
      logAndBufferError(
        `Failed removing stale Chromium lock ${fileName}`,
        error,
      );
    }
  }
}

function resolveBrowserExecutablePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
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

function isAllowedCommand(text) {
  return ALLOWED_COMMANDS.some((pattern) => pattern.test(text));
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
    `Reply sent to ${getChatLabel(msg)}: ${truncateForLog(responseText)}`,
  );
  return result;
}

async function sendMessageWithLog(chatId, responseText, options) {
  const result = await client.sendMessage(chatId, responseText, options);
  logger.info(`Message sent to ${chatId}: ${truncateForLog(responseText)}`);
  return result;
}

setInterval(() => {
  if (!errorLogBuffer.size) return;

  const batched = Array.from(errorLogBuffer).join("\n\n").slice(0, 4000);
  sendTelegramAlert(batched);
  errorLogBuffer.clear();
}, ERROR_BATCH_INTERVAL);

const apiClient = axios.create({
  timeout: CRM_REQUEST_TIMEOUT_MS,
});

const apiQueue = new PQueue({
  concurrency: 2,
  interval: 1000,
  intervalCap: 10,
});

let crmFailures = 0;
let crmBlockedUntil = 0;

function canCallCRM() {
  return Date.now() >= crmBlockedUntil;
}

function recordCRMFailure() {
  crmFailures += 1;

  if (crmFailures >= 5) {
    crmBlockedUntil = Date.now() + 2 * 60 * 1000;
    crmFailures = 0;
    logger.warn("CRM temporarily blocked");
  }
}

function recordCRMSuccess() {
  crmFailures = 0;
}

async function safeApiCall(fn) {
  if (!canCallCRM()) {
    logger.warn("Skipping CRM call because the circuit breaker is open");
    return null;
  }

  try {
    const response = await apiQueue.add(fn);
    recordCRMSuccess();
    return response;
  } catch (error) {
    recordCRMFailure();
    throw error;
  }
}

const browserExecutablePath = resolveBrowserExecutablePath();

if (browserExecutablePath) {
  logger.info(`Using browser executable: ${browserExecutablePath}`);
} else {
  logger.warn(
    "No browser executable detected. Set PUPPETEER_EXECUTABLE_PATH or install Chrome/Chromium.",
  );
}

const client = new Client({
  authTimeoutMs: AUTH_TIMEOUT_MS,
  puppeteer: {
    headless: true,
    ...(browserExecutablePath ? { executablePath: browserExecutablePath } : {}),
    timeout: AUTH_TIMEOUT_MS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-features=site-per-process",
      "--no-zygote",
      "--single-process",
    ],
  },
  authStrategy: new LocalAuth({
    clientId: INSTANCE_ID,
    dataPath: SESSION_PATH,
  }),
});

wss.on("error", (error) => {
  logAndBufferError("WebSocket server error", error);
});

client.on("qr", (qr) => {
  latestQR = qr;
  initErrorMessage = null;
  recordLastEvent("qr", INSTANCE_ID);
  logger.info(`QR code generated for ${INSTANCE_ID}`);
  qrcode.generate(qr, { small: true });

  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(qr);
    }
  });
});

client.on("authenticated", () => {
  initErrorMessage = null;
  recordLastEvent("authenticated", INSTANCE_ID);
  logger.info("Authenticated successfully");
});

client.on("change_state", (state) => {
  recordLastEvent("change_state", state);
  logger.info(`WhatsApp state changed: ${state}`);
});

client.on("auth_failure", (message) => {
  initErrorMessage = `Authentication failure: ${message}`;
  recordLastEvent("auth_failure", message);
  clearReadyTimer();
  isClientReady = false;
  systemState = SYSTEM_STATE.STARTING;
  logger.error(`Authentication failure: ${message}`);
  errorLogBuffer.add(`Auth failure: ${message}`);
});

client.on("loading_screen", (percent, message) => {
  recordLastEvent("loading_screen", `${percent}% ${message}`);
  logger.info(`Loading: ${percent}% - ${message}`);
});

client.on("ready", () => {
  isClientReady = true;
  latestQR = null;
  initErrorMessage = null;
  systemState = SYSTEM_STATE.SYNCING;
  recordLastEvent("ready", INSTANCE_ID);
  logger.info("WhatsApp ready, entering SYNCING mode");
  scheduleReadyState();
});

client.on("disconnected", (reason) => {
  recordLastEvent("disconnected", reason);
  logger.warn(`Client disconnected: ${reason}`);
  clearReadyTimer();
  isClientReady = false;
  systemState = SYSTEM_STATE.STARTING;
});

client.on("remote_session_saved", () => {
  recordLastEvent("remote_session_saved", INSTANCE_ID);
  logger.info("WhatsApp session saved");
});

client.on("error", (error) => {
  initErrorMessage = String(error?.message || error);
  recordLastEvent("client_error", initErrorMessage);
  logAndBufferError("WhatsApp client error", error);
});

client.on("message", async (msg) => {
  const text = msg.body?.trim();
  if (!text) return;

  recordLastEvent("message", text);
  logIncomingMessage("message", msg, text);

  if (text.toUpperCase() === "PING") {
    await replyWithLog(msg, "PONG");
    return;
  }

  try {
    if (systemState !== SYSTEM_STATE.READY && !isAllowedCommand(text)) {
      logger.info(`Ignored during sync: ${text.slice(0, 40)}`);
      return;
    }

    if (text.toUpperCase().startsWith("REGISTER STAFF")) {
      const parts = text.split("-");
      if (parts.length !== 3) {
        await replyWithLog(msg, "Use: REGISTER STAFF-phone-name");
        return;
      }

      const staffPhone = parts[1];
      const staffName = parts[2];
      const contact = await msg.getContact();
      const lid = contact.id._serialized;

      try {
        const response = await safeApiCall(() =>
          apiClient.post(CRM_ENDPOINTS.mapStaff, {
            lid,
            phone: staffPhone,
            name: staffName,
          }),
        );

        if (!response) {
          await replyWithLog(msg, TEMPORARY_UNAVAILABLE_MESSAGE);
          return;
        }

        if (response.data?.success) {
          await replyWithLog(
            msg,
            `Hi ${staffName}, post this code in the group:\n\n${response.data.code}`,
          );
        } else {
          await replyWithLog(
            msg,
            response.data?.error || "Registration failed",
          );
        }
      } catch (error) {
        logAndBufferError("Error processing staff registration", error);
        await replyWithLog(msg, "Error processing registration.");
      }

      return;
    }

    if (text.startsWith("UNIQUE_CODE_")) {
      try {
        const response = await safeApiCall(() =>
          apiClient.post(CRM_ENDPOINTS.mapStaffFinalize, {
            code: text,
            group_lid: msg.from,
            lid: msg.author,
          }),
        );

        if (!response) {
          await sendMessageWithLog(
            msg.author || msg.from,
            TEMPORARY_UNAVAILABLE_MESSAGE,
          );
          return;
        }

        const reply = response.data?.success
          ? "You have been successfully registered!"
          : "Registration failed.";

        await sendMessageWithLog(response.data?.sender_id || msg.from, reply);
      } catch (error) {
        logAndBufferError("Error finalizing staff registration", error);
        await sendMessageWithLog(
          msg.author || msg.from,
          "Error finalizing registration.",
        );
      }

      return;
    }

    if (text.toUpperCase().startsWith("ADD GROUP TO CRM -")) {
      if (!msg.from.includes("@g.us")) {
        await replyWithLog(msg, "Must be used in a group.");
        return;
      }

      const parts = text.split(" - ");
      if (parts.length < 3) {
        await replyWithLog(msg, "ADD GROUP TO CRM - Group Name - AgentPhone");
        return;
      }

      const groupName = parts[1].trim();
      const agentPhone = parts[2].replace(/\D/g, "");
      const groupId = msg.from;
      const sender = msg.author;

      if (!/^234\d{10}$/.test(agentPhone)) {
        await replyWithLog(msg, "Invalid phone: 234XXXXXXXXXX");
        return;
      }

      try {
        const response = await safeApiCall(() =>
          apiClient.post(CRM_ENDPOINTS.mapGroupAgent, {
            sender,
            group_id: groupId,
            group_name: groupName,
            agent_phone: agentPhone,
          }),
        );

        if (!response) {
          await replyWithLog(msg, TEMPORARY_UNAVAILABLE_MESSAGE);
          return;
        }

        await replyWithLog(
          msg,
          response.data?.message || "Agent mapped successfully.",
        );
      } catch (error) {
        logAndBufferError("Error mapping group to CRM", error);
        await replyWithLog(msg, "Failed to map group.");
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
  logIncomingMessage("message_create", msg, text);

  if (text.toUpperCase() !== "PING") return;

  try {
    const chatId = await resolveChatId(msg);
    if (!chatId) {
      logger.warn("Could not resolve chat for self-sent PING");
      return;
    }

    logger.info(
      `Self-sent PING resolved chat=${chatId} from=${msg.from || ""} to=${msg.to || ""}`,
    );

    await sendMessageWithLog(chatId, "PONG");
  } catch (error) {
    logAndBufferError("Error handling self-sent PING", error);
  }
});

client.on("message_reaction", async (reaction) => {
  if (systemState !== SYSTEM_STATE.READY) return;

  try {
    const msg = await client.getMessageById(reaction.msgId._serialized);
    if (!msg?.body) return;

    const response = await safeApiCall(() =>
      apiClient.post(CRM_ENDPOINTS.checkReaction, {
        message: msg._data,
        reaction,
      }),
    );

    if (!response) {
      logger.warn(
        "Skipping reaction forward because CRM is temporarily blocked",
      );
    }
  } catch (error) {
    logAndBufferError("Error in message_reaction", error);
  }
});

app.post("/send-order", async (req, res) => {
  if (!isClientReady) {
    res.status(503).json({ error: "WhatsApp client not ready." });
    return;
  }

  try {
    let { channel, order, channel_type: channelType } = req.body || {};

    channel = typeof channel === "string" ? channel.trim() : "";
    order = typeof order === "string" ? order.trim() : "";
    channelType =
      typeof channelType === "string" ? channelType.trim().toLowerCase() : "";

    if (!channel || !order) {
      res.status(400).json({ error: "channel and order are required" });
      return;
    }

    const isWid = channel.includes("@c.us") || channel.includes("@g.us");

    if (!isWid) {
      if (/^\d{10,15}$/.test(channel)) {
        if (channelType === "group") {
          res.status(400).json({
            error: "Invalid channel: group messages require a @g.us chat id",
            hint: "Pass channel as the full group id like 1203...@g.us (not a phone number).",
          });
          return;
        }

        channel = `${channel}@c.us`;
      } else {
        res.status(400).json({
          error: "Invalid channel format",
          hint: "Use a full WhatsApp chat id like 234...@c.us or 1203...@g.us",
        });
        return;
      }
    }

    const result = await sendMessageWithLog(channel, order, {
      sendSeen: false,
    });

    res.json({ ok: true, to: channel, result });
  } catch (error) {
    logAndBufferError("Error sending order", error);
    res.status(500).json({ error: "Failed to send order" });
  }
});

app.get("/qr", (req, res) => {
  if (!latestQR) {
    res.json({ status: "waiting", message: initErrorMessage });
    return;
  }

  res.json({
    status: "qr",
    qr: latestQR,
    instance: INSTANCE_ID,
    message: null,
  });
});

app.get("/status", (req, res) => {
  res.json({
    ready: isClientReady,
    state: systemState,
    instance: INSTANCE_ID,
    build: BUILD_MARKER,
    browserPath: browserExecutablePath,
    initError: initErrorMessage,
    hasQr: Boolean(latestQR),
    clientInfo: client.info?.wid?._serialized || null,
    lastEvent,
  });
});

app.get("/", (req, res) => {
  res.status(200).json({ message: "success", instance: INSTANCE_ID });
});

try {
  ensureDirectoryExists(SESSION_PATH);

  if (fs.existsSync(SESSION_DIR)) {
    logger.info(`Session directory exists: ${SESSION_DIR}`);
    clearStaleChromiumLocks(SESSION_DIR);
  } else {
    logger.info(`No existing session for ${INSTANCE_ID}`);
  }
} catch (error) {
  initErrorMessage = `Failed preparing session storage: ${error.message}`;
  logAndBufferError("Session storage setup failed", error);
}

server.listen(HTTP_PORT, () => {
  logger.info(`HTTP running on ${HTTP_PORT}`);

  if (WS_PORT === HTTP_PORT) {
    logger.info(`WebSocket sharing HTTP port ${HTTP_PORT}`);
  } else {
    logger.info(`WebSocket running on ${WS_PORT}`);
  }
});

client.initialize().catch((error) => {
  const rawError = String(error?.message || error);
  clearReadyTimer();

  if (rawError.includes("auth timeout")) {
    initErrorMessage = `auth timeout after ${AUTH_TIMEOUT_MS}ms. Scan the latest QR promptly or recreate the session.`;
    logAndBufferError("WhatsApp initialization failed", initErrorMessage);
    return;
  }

  initErrorMessage = rawError;
  logAndBufferError("WhatsApp initialization failed", error);
});

async function shutdown(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  clearReadyTimer();
  logger.info(
    `Received ${signal}, shutting down WhatsApp instance ${INSTANCE_ID}`,
  );

  const forceExitTimer = setTimeout(() => {
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  try {
    if (typeof client.destroy === "function") {
      await client.destroy();
    }
  } catch (error) {
    logAndBufferError(
      "Failed destroying WhatsApp client during shutdown",
      error,
    );
  }

  await Promise.allSettled([
    new Promise((resolve) => wss.close(() => resolve())),
    new Promise((resolve) => server.close(() => resolve())),
  ]);

  clearTimeout(forceExitTimer);
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    console.error("Shutdown failed:", error);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    console.error("Shutdown failed:", error);
    process.exit(1);
  });
});
