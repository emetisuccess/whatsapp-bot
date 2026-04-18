const express = require("express");
const axios = require("axios");
const Redis = require("ioredis");
const { execFile } = require("child_process");

function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const ORCH_PORT = numberFromEnv(process.env.ORCH_PORT, 7070);
const BASE_IMAGE = process.env.WA_IMAGE || "whatsapp-service:latest";
const DOCKER_NETWORK = process.env.WA_NETWORK || "wa-net";
const INTERNAL_HTTP_PORT = numberFromEnv(process.env.INTERNAL_HTTP_PORT, 9000);
const INTERNAL_WS_PORT = numberFromEnv(process.env.INTERNAL_WS_PORT, 9090);
const INTERNAL_TIMEOUT_MS = numberFromEnv(
  process.env.INTERNAL_TIMEOUT_MS,
  15000,
);
const STATUS_POLL_INTERVAL_MS = numberFromEnv(
  process.env.STATUS_POLL_INTERVAL_MS,
  5000,
);
const STATUS_POLL_ATTEMPTS = numberFromEnv(
  process.env.STATUS_POLL_ATTEMPTS,
  24,
);
const REDIS_URL = process.env.REDIS_URL || "";
const ORCH_BODY_LIMIT = process.env.ORCH_BODY_LIMIT || "256kb";
const API_KEY = process.env.ORCH_KEY || "";
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const FORWARDED_CONTAINER_ENV_VARS = [
  "AUTH_TIMEOUT_MS",
  "READY_DELAY_MS",
  "BUILD_MARKER",
  "HTTP_BODY_LIMIT",
  "CRM_REQUEST_TIMEOUT_MS",
  "MAP_STAFF_URL",
  "MAP_STAFF_FINALIZE_URL",
  "MAP_GROUP_AGENT_URL",
  "CHECK_REACTION_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_USER_ID",
  "PUPPETEER_EXECUTABLE_PATH",
];

if (!API_KEY) {
  console.error("ORCH_KEY is not set");
  process.exit(1);
}

if (!REDIS_URL) {
  console.error("REDIS_URL is not set");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: ORCH_BODY_LIMIT }));

const redis = new Redis(REDIS_URL);
const startupPollers = new Map();
let server;
let isShuttingDown = false;

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection in orchestrator:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception in orchestrator:", error);
});

redis.on("error", (error) => {
  console.error("Redis error:", error);
});

redis
  .ping()
  .then(() => console.log("Redis connected"))
  .catch((error) => console.error("Redis failed", error));

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const result = {
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim(),
        };

        if (error) {
          error.stdout = result.stdout;
          error.stderr = result.stderr;
          reject(error);
          return;
        }

        resolve(result);
      },
    );
  });
}

function safeContainerName(instanceId) {
  return `wa_${instanceId}`;
}

function safeVolumeName(instanceId) {
  return `wa_sessions_${instanceId}`;
}

function internalUrl(instanceId, path) {
  const name = safeContainerName(instanceId);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `http://${name}:${INTERNAL_HTTP_PORT}${suffix}`;
}

function isValidInstanceId(instanceId) {
  return INSTANCE_ID_PATTERN.test(instanceId);
}

function getToken(req) {
  const auth = req.headers.authorization;
  if (auth) return auth.replace(/^Bearer\s+/i, "").trim();
  return req.headers["x-api-key"] || null;
}

function getForwardedEnvArgs() {
  const args = [];

  for (const envName of FORWARDED_CONTAINER_ENV_VARS) {
    const envValue = process.env[envName];
    if (!envValue) continue;
    args.push("-e", `${envName}=${envValue}`);
  }

  return args;
}

function stopStartupPoll(instanceId) {
  const handle = startupPollers.get(instanceId);
  if (handle) {
    clearTimeout(handle);
    startupPollers.delete(instanceId);
  }
}

async function readInstance(instanceId) {
  const raw = await redis.get(`wa:${instanceId}`);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Failed to parse Redis state for ${instanceId}:`, error);
    return null;
  }
}

async function writeInstance(instanceId, payload) {
  await redis.set(`wa:${instanceId}`, JSON.stringify(payload));
  return payload;
}

async function patchInstance(instanceId, patch) {
  const current = (await readInstance(instanceId)) || { id: instanceId };
  const next = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };

  await writeInstance(instanceId, next);
  return next;
}

async function removeContainerIfExists(containerName) {
  try {
    await runCommand("docker", ["rm", "-f", containerName]);
  } catch (error) {
    const combined = `${error.stderr || ""} ${error.message || ""}`;
    if (/No such container/i.test(combined)) return;
    throw error;
  }
}

function scheduleStartupPoll(instanceId, attempt = 1) {
  stopStartupPoll(instanceId);

  const poll = async () => {
    const current = await readInstance(instanceId);
    if (!current || current.status === "deleted") {
      stopStartupPoll(instanceId);
      return;
    }

    try {
      const response = await axios.get(internalUrl(instanceId, "/status"), {
        timeout: Math.min(INTERNAL_TIMEOUT_MS, 5000),
      });

      const ready =
        response.data?.state === "ready" || response.data?.ready === true;

      await patchInstance(instanceId, {
        status: ready ? "running" : "starting",
        lastKnownState: response.data?.state || null,
        lastStatusAt: Date.now(),
        lastError: null,
      });

      if (ready) {
        stopStartupPoll(instanceId);
        return;
      }
    } catch (error) {
      const lastAttempt = attempt >= STATUS_POLL_ATTEMPTS;

      await patchInstance(instanceId, {
        status: lastAttempt ? "unreachable" : "starting",
        lastError: String(error.message || error).slice(0, 500),
      });

      if (lastAttempt) {
        stopStartupPoll(instanceId);
        return;
      }
    }

    const handle = setTimeout(() => {
      scheduleStartupPoll(instanceId, attempt + 1);
    }, STATUS_POLL_INTERVAL_MS);

    startupPollers.set(instanceId, handle);
  };

  poll().catch((error) => {
    console.error(`Startup poll failed for ${instanceId}:`, error);
  });
}

async function markDeletedByContainerName(containerName) {
  const keys = await redis.keys("wa:*");

  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;

    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      console.error(`Failed to parse Redis value for key ${key}:`, error);
      continue;
    }

    if (value.container !== containerName) continue;

    stopStartupPoll(value.id);
    await writeInstance(value.id, {
      ...value,
      status: "deleted",
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
}

app.use((req, res, next) => {
  if (req.path === "/status") {
    next();
    return;
  }

  const token = getToken(req);
  if (!token || token !== API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
});

app.post("/containers", async (req, res) => {
  const instanceId = String(req.body?.instanceId || "").trim();

  if (!instanceId) {
    res.status(400).json({ error: "instanceId required" });
    return;
  }

  if (!isValidInstanceId(instanceId)) {
    res.status(400).json({
      error:
        "Invalid instanceId. Use 1-64 characters: letters, numbers, dot, dash, or underscore.",
    });
    return;
  }

  const containerName = safeContainerName(instanceId);
  const volumeName = safeVolumeName(instanceId);

  try {
    await removeContainerIfExists(containerName);

    const dockerArgs = [
      "run",
      "-d",
      "--init",
      "--restart",
      "unless-stopped",
      "--name",
      containerName,
      "--network",
      DOCKER_NETWORK,
      "--shm-size",
      "1g",
      "--label",
      "managed-by=wa-orchestrator",
      "--label",
      `wa.instanceId=${instanceId}`,
      "-e",
      `INSTANCE_ID=${instanceId}`,
      "-e",
      `HTTP_PORT=${INTERNAL_HTTP_PORT}`,
      "-e",
      `WS_PORT=${INTERNAL_WS_PORT}`,
      "-e",
      "SESSION_PATH=/sessions",
      "-v",
      `${volumeName}:/sessions`,
      ...getForwardedEnvArgs(),
      BASE_IMAGE,
    ];

    const result = await runCommand("docker", dockerArgs);
    const containerId = result.stdout;

    await writeInstance(instanceId, {
      id: instanceId,
      container: containerName,
      volume: volumeName,
      containerId,
      status: "starting",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastError: null,
    });

    scheduleStartupPoll(instanceId);

    res.json({
      ok: true,
      instanceId,
      container: containerName,
      containerId,
      volume: volumeName,
      status: "starting",
    });
  } catch (error) {
    console.error("Docker run failed:", error);
    res.status(500).json({
      error: error.message,
      stderr: error.stderr || null,
      stdout: error.stdout || null,
    });
  }
});

app.delete("/containers/:name", async (req, res) => {
  const containerName = String(req.params.name || "").trim();

  if (!containerName) {
    res.status(400).json({ error: "container name required" });
    return;
  }

  try {
    await removeContainerIfExists(containerName);
    await markDeletedByContainerName(containerName);

    res.json({ ok: true, deleted: containerName });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      stderr: error.stderr || null,
    });
  }
});

app.get("/instances", async (req, res) => {
  try {
    const keys = await redis.keys("wa:*");
    if (!keys.length) {
      res.json([]);
      return;
    }

    const values = await Promise.all(keys.map((key) => redis.get(key)));
    const parsed = values
      .filter(Boolean)
      .map((value) => {
        try {
          return JSON.parse(value);
        } catch (error) {
          console.error("Failed to parse instance record:", error);
          return null;
        }
      })
      .filter(Boolean);

    res.json(parsed);
  } catch (error) {
    console.error("Failed to fetch instances:", error);
    res.status(500).json({ error: "Failed to fetch instances" });
  }
});

app.get("/instances/:instanceId/qr", async (req, res) => {
  const instanceId = String(req.params.instanceId || "").trim();

  if (!isValidInstanceId(instanceId)) {
    res.status(400).json({ error: "Invalid instanceId" });
    return;
  }

  try {
    const response = await axios.get(internalUrl(instanceId, "/qr"), {
      timeout: INTERNAL_TIMEOUT_MS,
    });

    res.status(response.status).json(response.data);
  } catch (error) {
    const status = error.response?.status || 502;
    res.status(status).json({
      status: "waiting",
      error: "Failed to reach WhatsApp instance",
      detail: error.message,
      upstream: error.response?.data || null,
    });
  }
});

app.get("/instances/:instanceId/status", async (req, res) => {
  const instanceId = String(req.params.instanceId || "").trim();

  if (!isValidInstanceId(instanceId)) {
    res.status(400).json({ error: "Invalid instanceId" });
    return;
  }

  try {
    const response = await axios.get(internalUrl(instanceId, "/status"), {
      timeout: INTERNAL_TIMEOUT_MS,
    });

    res.json(response.data);
  } catch (error) {
    const status = error.response?.status || 502;
    res.status(status).json({
      error: "Instance unreachable",
      detail: error.message,
      upstream: error.response?.data || null,
    });
  }
});

app.post("/instances/:instanceId/send-order", async (req, res) => {
  const instanceId = String(req.params.instanceId || "").trim();

  if (!isValidInstanceId(instanceId)) {
    res.status(400).json({ error: "Invalid instanceId" });
    return;
  }

  try {
    const response = await axios.post(
      internalUrl(instanceId, "/send-order"),
      req.body,
      { timeout: INTERNAL_TIMEOUT_MS },
    );

    res.status(response.status).json(response.data);
  } catch (error) {
    const status = error.response?.status || 502;
    res.status(status).json({
      error: "Failed to reach WhatsApp instance",
      detail: error.message,
      upstream: error.response?.data || null,
    });
  }
});

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    orchestrator: "running",
    timestamp: new Date().toISOString(),
  });
});

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`Received ${signal}, shutting down orchestrator`);

  for (const [instanceId, handle] of startupPollers.entries()) {
    clearTimeout(handle);
    startupPollers.delete(instanceId);
  }

  const forceExitTimer = setTimeout(() => {
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  Promise.resolve()
    .then(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await redis.quit();
    })
    .catch((error) => {
      console.error("Error during orchestrator shutdown:", error);
    })
    .finally(() => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server = app.listen(ORCH_PORT, () => {
  console.log(`Orchestrator running on port ${ORCH_PORT}`);
});
