/**
 * Option A Orchestrator
 * - CRM talks ONLY to this orchestrator on :7070
 * - Orchestrator creates WhatsApp containers on an internal docker network (wa-net)
 * - NO host port publishing for WhatsApp containers (no -p 0:9000 etc)
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
const BASE_IMAGE = process.env.WA_IMAGE || "whatsapp-service";
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
  exec(cmd, (err, stdout, stderr) => cb(err, stdout, stderr));
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

function getTokenFromReq(req) {
  // Accept either:
  // 1) Authorization: Bearer <key>
  // 2) x-api-key: <key>
  const auth = req.headers["authorization"];
  if (auth && typeof auth === "string") {
    return auth.replace("Bearer", "").trim();
  }
  const x = req.headers["x-api-key"];
  if (x && typeof x === "string") return x.trim();
  return null;
}

function safeContainerName(instanceId) {
  // we will name containers: wa_<instanceId>
  // instanceId must be simple so it doesn't break shell commands
  const cleaned = String(instanceId).replace(/[^a-zA-Z0-9_-]/g, "");
  return `wa_${cleaned}`;
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

  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

// ==========================
// HEALTH
// ==========================
app.get("/", (req, res) => {
  res.json({ ok: true, service: "wa-orchestrator", network: DOCKER_NETWORK });
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

  ensureNetwork((netErr) => {
    if (netErr) {
      console.error("❌ Failed to ensure network:", netErr.message);
      return res.status(500).json({ error: netErr.message });
    }

    // Remove any old container first, then run new one (avoid race)
    sh(`docker rm -f ${name} >/dev/null 2>&1 || true`, () => {
      const cmd = `
docker run -d \
  --restart unless-stopped \
  --name ${name} \
  --network ${DOCKER_NETWORK} \
  -e INSTANCE_ID=${instanceId} \
  -e HTTP_PORT=9000 \
  -e WS_PORT=9090 \
  -e SESSION_PATH=/sessions \
  -v wa_sessions_${instanceId}:/sessions \
  ${BASE_IMAGE}
`.trim();

      sh(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error("❌ Docker run failed:", err.message);
          console.error("STDERR:", stderr);
          return res.status(500).json({ error: err.message });
        }

        return res.json({
          ok: true,
          container: name,
          instanceId,
          note: "No host ports published. Use /instances/:instanceId/* endpoints on orchestrator.",
        });
      });
    });
  });
});

// ==========================
// DELETE CONTAINER (SAFE)
// ==========================
app.delete("/containers/:name", (req, res) => {
  const name = String(req.params.name || "").replace(/[^a-zA-Z0-9_-]/g, "");
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
    const r = await axios.post(internalUrl(instanceId, "/send-order"), req.body, {
      timeout: INTERNAL_TIMEOUT_MS,
    });
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

// ==========================
// START SERVER
// ==========================
app.listen(ORCH_PORT, () => {
  console.log(`🚀 Orchestrator running on port ${ORCH_PORT} (network: ${DOCKER_NETWORK})`);
});
