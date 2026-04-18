const express = require("express");
const axios = require("axios");
const Redis = require("ioredis");
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
const INTERNAL_TIMEOUT_MS = Number(process.env.INTERNAL_TIMEOUT_MS || 15000);

if (!process.env.ORCH_KEY) {
  console.error("❌ ORCH_KEY is not set");
  process.exit(1);
}
const API_KEY = process.env.ORCH_KEY;

// ==========================
// REDIS
// ==========================
const redis = new Redis(process.env.REDIS_URL);

redis
  .ping()
  .then(() => console.log("✅ Redis connected"))
  .catch((err) => console.error("❌ Redis failed", err));

// ==========================
// HELPERS
// ==========================
function sh(cmd, cb) {
  exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    cb(err, stdout, stderr);
  });
}

function safeId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function safeContainerName(instanceId) {
  return `wa_${safeId(instanceId)}`;
}

function safeVolumeName(instanceId) {
  return `wa_sessions_${String(instanceId).replace(/[^a-zA-Z0-9_.-]/g, "")}`;
}

function internalUrl(instanceId, path) {
  const name = safeContainerName(instanceId);
  const p = path.startsWith("/") ? path : `/${path}`;
  return `http://${name}:${INTERNAL_HTTP_PORT}${p}`;
}

function getToken(req) {
  const auth = req.headers["authorization"];
  if (auth) return auth.replace("Bearer", "").trim();
  return req.headers["x-api-key"] || null;
}

// ==========================
// AUTH
// ==========================
app.use((req, res, next) => {
  const token = getToken(req);
  if (!token || token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
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

    sh(cmd, async (err, stdout, stderr) => {
      if (err) {
        console.error("❌ Docker run failed:", err.message);
        return res.status(500).json({ error: err.message, stderr });
      }

      const containerId = stdout.trim();

      // ✅ SAVE TO REDIS
      await redis.set(
        `wa:${instanceId}`,
        JSON.stringify({
          id: instanceId,
          container: name,
          containerId,
          status: "starting",
          createdAt: Date.now(),
        }),
      );

      // ==========================
      // STATUS WATCHER
      // ==========================
      const poll = setInterval(async () => {
        try {
          const r = await axios.get(internalUrl(instanceId, "/status"), {
            timeout: 5000,
          });

          const ready = r.data?.state === "ready" || r.data?.ready === true;

          const key = `wa:${instanceId}`;
          const current = JSON.parse(await redis.get(key));

          if (ready) {
            current.status = "running";
            await redis.set(key, JSON.stringify(current));
            clearInterval(poll);
          } else {
            current.status = "starting";
            await redis.set(key, JSON.stringify(current));
          }
        } catch (e) {
          // keep trying
        }
      }, 5000);

      return res.json({
        ok: true,
        container: name,
        instanceId,
        containerId,
        status: "starting",
      });
    });
  });
});

// ==========================
// DELETE CONTAINER
// ==========================
app.delete("/containers/:name", async (req, res) => {
  const name = safeId(req.params.name);

  sh(`docker rm -f ${name}`, async (err) => {
    if (err) return res.status(500).json({ error: err.message });

    // mark deleted in Redis
    const keys = await redis.keys("wa:*");

    for (const key of keys) {
      const val = JSON.parse(await redis.get(key));
      if (val.container === name) {
        val.status = "deleted";
        await redis.set(key, JSON.stringify(val));
      }
    }

    return res.json({ ok: true, deleted: name });
  });
});

// ==========================
// LIST INSTANCES
// ==========================
app.get("/instances", async (req, res) => {
  try {
    const keys = await redis.keys("wa:*");

    if (!keys.length) return res.json([]);

    const values = await Promise.all(
      keys.map(async (key) => JSON.parse(await redis.get(key))),
    );

    res.json(values);
  } catch (err) {
    console.error("❌ Failed to fetch instances:", err);
    res.status(500).json({ error: "Failed to fetch instances" });
  }
});

// ==========================
// PROXY STATUS
// ==========================
app.get("/instances/:instanceId/status", async (req, res) => {
  try {
    const r = await axios.get(internalUrl(req.params.instanceId, "/status"), {
      timeout: INTERNAL_TIMEOUT_MS,
    });
    res.json(r.data);
  } catch (e) {
    res.status(502).json({ error: "Instance unreachable" });
  }
});

// ==========================
// HEALTH
// ==========================
app.get("/status", (req, res) => {
  res.json({
    ok: true,
    orchestrator: "running",
    timestamp: new Date().toISOString(),
  });
});

// ==========================
// START
// ==========================
app.listen(ORCH_PORT, () => {
  console.log(`🚀 Orchestrator running on port ${ORCH_PORT}`);
});
