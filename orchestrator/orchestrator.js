/**
 * Option A Orchestrator (Corrected)
 * - CRM talks ONLY to this orchestrator on :7070
 * - Orchestrator creates WhatsApp containers on internal docker network (wa-net)
 * - NO host port publishing for WhatsApp containers
 * - Orchestrator proxies: /instances/:id/qr, /status, /send-order
 */

const express = require("express");
const axios = require("axios");
const { exec } = require("child_process");

const app = express();
app.use(express.json());

// ==========================
// CONFIG
// ==========================
const ORCH_PORT = 7070;
const BASE_IMAGE = process.env.WA_IMAGE || "whatsapp-service:latest";
const DOCKER_NETWORK = process.env.WA_NETWORK || "wa-net";
const INTERNAL_HTTP_PORT = 9000;

if (!process.env.ORCH_KEY) {
  console.error("❌ ORCH_KEY is not set in environment");
  process.exit(1);
}
const API_KEY = process.env.ORCH_KEY;

const INTERNAL_TIMEOUT_MS = Number(process.env.INTERNAL_TIMEOUT_MS || 15000);

// ==========================
// HELPERS
// ==========================
function sh(cmd, cb) {
  exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    cb(err, stdout, stderr);
  });
}

function ensureNetwork(cb) {
  sh(`docker network inspect ${DOCKER_NETWORK} >/dev/null 2>&1`, (err) => {
    if (!err) return cb(null);

    sh(`docker network create ${DOCKER_NETWORK}`, (err2) => {
      if (err2) return cb(err2);
      return cb(null);
    });
  });
}

function ensureImage(cb) {
  sh(`docker image inspect ${BASE_IMAGE} >/dev/null 2>&1`, (err) => {
    if (!err) return cb(null);

    const missingImageError = new Error(
      `Docker image '${BASE_IMAGE}' not found. Build it before creating an instance.`,
    );
    missingImageError.code = "WA_IMAGE_MISSING";
    return cb(missingImageError);
  });
}

function getTokenFromReq(req) {
  const auth = req.headers["authorization"];
  if (auth && typeof auth === "string") {
    return auth.replace("Bearer", "").trim();
  }
  const x = req.headers["x-api-key"];
  if (x && typeof x === "string") return x.trim();
  return null;
}

function safeId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function safeContainerName(instanceId) {
  const cleaned = safeId(instanceId);
  return `wa_${cleaned}`;
}

function safeVolumeName(instanceId) {
  const cleaned = String(instanceId || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  return `wa_sessions_${cleaned}`;
}

function internalUrl(instanceId, path) {
  const name = safeContainerName(instanceId);
  const p = path.startsWith("/") ? path : `/${path}`;
  return `http://${name}:${INTERNAL_HTTP_PORT}${p}`;
}

// ==========================
// AUTH MIDDLEWARE
// ==========================
app.use((req, res, next) => {
  const token = getTokenFromReq(req);
  if (!token || token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ==========================
// HEALTH
// ==========================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "wa-orchestrator",
    network: DOCKER_NETWORK,
    image: BASE_IMAGE,
  });
});

// ==========================
// CREATE CONTAINER
// ==========================
app.post("/containers", (req, res) => {
  const { instanceId } = req.body;

  if (!instanceId) {
    return res.status(400).json({ error: "instanceId required" });
  }

  const name = safeContainerName(instanceId);
  const volume = safeVolumeName(instanceId);

  ensureNetwork((netErr) => {
    if (netErr) {
      console.error("❌ Failed to ensure network:", netErr.message);
      return res.status(500).json({ error: netErr.message });
    }

    ensureImage((imageErr) => {
      if (imageErr) {
        return res.status(500).json({
          error: imageErr.message,
          image: BASE_IMAGE,
          buildCommand: `docker build -t ${BASE_IMAGE} ./whatsapp-app`,
        });
      }

      sh(`docker rm -f ${name} >/dev/null 2>&1 || true`, () => {
        const cmd = `
docker run -d \
  --restart unless-stopped \
  --name ${name} \
  --network ${DOCKER_NETWORK} \
  --shm-size=1g \
  -e INSTANCE_ID=${instanceId} \
  -e HTTP_PORT=9000 \
  -e WS_PORT=9090 \
  -e SESSION_PATH=/sessions \
  -v ${volume}:/sessions \
  ${BASE_IMAGE}
`.trim();

        sh(cmd, (err, stdout, stderr) => {
          if (err) {
            console.error("❌ Docker run failed:", err.message);
            console.error("STDERR:", stderr);
            return res.status(500).json({ error: err.message, stderr });
          }

          return res.json({
            ok: true,
            container: name,
            instanceId,
            note: "Container created with 1GB shared memory.",
          });
        });
      });
    });
  });
});

// ==========================
// DELETE CONTAINER
// ==========================
app.delete("/containers/:name", (req, res) => {
  const name = safeId(req.params.name);
  if (!name) return res.status(400).json({ error: "name required" });

  sh(`docker rm -f ${name}`, (err, stdout, stderr) => {
    if (err) {
      console.error("❌ Delete failed:", err.message);
      console.error("STDERR:", stderr);
      return res.status(500).json({ error: err.message });
    }

    return res.json({ ok: true, deleted: name });
  });
});

// ==========================
// PROXY: QR
// ==========================
app.get("/instances/:instanceId/qr", async (req, res) => {
  const { instanceId } = req.params;

  try {
    const r = await axios.get(internalUrl(instanceId, "/qr"), {
      timeout: INTERNAL_TIMEOUT_MS,
    });
    return res.status(r.status).json(r.data);
  } catch (e) {
    const status = e.response?.status || 502;
    return res.status(status).json({
      status: "waiting",
      error: "Failed to reach WhatsApp instance",
      detail: e.message,
      upstream: e.response?.data || null,
    });
  }
});

// ==========================
// PROXY: STATUS
// ==========================
app.get("/instances/:instanceId/status", async (req, res) => {
  const { instanceId } = req.params;

  try {
    const r = await axios.get(internalUrl(instanceId, "/status"), {
      timeout: INTERNAL_TIMEOUT_MS,
    });
    return res.status(r.status).json(r.data);
  } catch (e) {
    const status = e.response?.status || 502;
    return res.status(status).json({
      ready: false,
      error: "Failed to reach WhatsApp instance",
      detail: e.message,
      upstream: e.response?.data || null,
    });
  }
});

// ==========================
// PROXY: SEND-ORDER
// ==========================
app.post("/instances/:instanceId/send-order", async (req, res) => {
  const { instanceId } = req.params;

  try {
    const r = await axios.post(
      internalUrl(instanceId, "/send-order"),
      req.body,
      { timeout: INTERNAL_TIMEOUT_MS },
    );
    return res.status(r.status).json(r.data);
  } catch (e) {
    const status = e.response?.status || 502;
    return res.status(status).json({
      error: "Failed to reach WhatsApp instance",
      detail: e.message,
      upstream: e.response?.data || null,
    });
  }
});

// Get overall orchestrator status (not instance-specific)
app.get("/status", (req, res) => {
  res.json({
    ok: true,
    orchestrator: "running",
    timestamp: new Date().toISOString(),
    network: process.env.WA_NETWORK,
    image: process.env.WA_IMAGE,
  });
});

// ==========================
// START SERVER
// ==========================
app.listen(ORCH_PORT, () => {
  console.log(
    `🚀 Orchestrator running on port ${ORCH_PORT} (network: ${DOCKER_NETWORK})`,
  );
});
