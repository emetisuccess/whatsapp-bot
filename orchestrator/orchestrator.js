const express = require('express');
const { exec } = require('child_process');

const app = express();
app.use(express.json());

// ==========================
// CONFIG
// ==========================
if (!process.env.ORCH_KEY) {
  console.error("❌ ORCH_KEY is not set in environment");
  process.exit(1);
}

const API_KEY = process.env.ORCH_KEY;
const BASE_IMAGE = 'whatsapp-service';

// ==========================
// AUTH MIDDLEWARE
// ==========================
app.use((req, res, next) => {
  const auth = req.headers['authorization'];

  console.log("---- AUTH TRACE ----");
  console.log("ENV KEY >>>", API_KEY);
  console.log("REQ AUTH >>>", auth);
  console.log("REQ X-API-KEY >>>", req.headers['x-api-key']);
  console.log("--------------------");

  if (!auth) {
    console.log("❌ Missing Authorization header");
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = auth.replace('Bearer ', '').trim();

  if (token !== API_KEY) {
    console.log("❌ Invalid API key:", token);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
});

// ==========================
// CREATE CONTAINER
// ==========================
app.post('/containers', (req, res) => {
  const { instanceId } = req.body;

  if (!instanceId) {
    return res.status(400).json({ error: 'instanceId required' });
  }

  const name = `wa_${instanceId}`;

  // --------------------------------
  // remove old container if exists
  // --------------------------------
  exec(`docker rm -f ${name}`, () => {});

  const cmd = `
docker run -d \
  --restart unless-stopped \
  --name ${name} \
  -e INSTANCE_ID=${instanceId} \
  -e HTTP_PORT=9000 \
  -e WS_PORT=9090 \
  -e SESSION_PATH=/sessions \
  -v wa_sessions_${instanceId}:/sessions \
  -p 0:9000 \
  -p 0:9090 \
  ${BASE_IMAGE}
`;

  exec(cmd, (err) => {
    if (err) {
      console.error("❌ Docker run failed:", err.message);
      return res.status(500).json({ error: err.message });
    }

    // wait before inspecting ports
    setTimeout(() => getPorts(name, res), 1500);
  });
});

// ==========================
// GET PORTS (RETRY SAFE)
// ==========================
function getPorts(name, res, attempt = 1) {
  exec(
    `docker inspect ${name} --format='{{json .NetworkSettings.Ports}}'`,
    (err, out) => {
      if (err) {
        if (attempt >= 6) {
          console.error("❌ Inspect failed:", err.message);
          return res.status(500).json({ error: err.message });
        }
        return setTimeout(() => getPorts(name, res, attempt + 1), 1000);
      }

      try {
        const ports = JSON.parse(out);

        if (!ports["9000/tcp"] || !ports["9090/tcp"]) {
          if (attempt >= 6) {
            return res.status(500).json({ error: "Ports not ready" });
          }
          return setTimeout(() => getPorts(name, res, attempt + 1), 1000);
        }

        const httpPort = ports["9000/tcp"][0].HostPort;
        const wsPort   = ports["9090/tcp"][0].HostPort;

        console.log(`✅ Ports assigned → HTTP:${httpPort} WS:${wsPort}`);

        return res.json({
          container: name,
          httpPort,
          wsPort
        });

      } catch (e) {
        if (attempt >= 6) {
          return res.status(500).json({ error: e.message });
        }
        return setTimeout(() => getPorts(name, res, attempt + 1), 1000);
      }
    }
  );
}

// ==========================
// DELETE CONTAINER (SAFE)
// ==========================
app.delete('/containers/:name', (req, res) => {
  const name = req.params.name;

  const cmd = `
docker rm -f ${name}
`;

  exec(cmd, (err, stdout, stderr) => {
    if (err) {
      console.error("❌ Delete failed:", err.message);
      console.error("STDERR:", stderr);
      return res.status(500).json({ error: err.message });
    }

    console.log("✅ Deleted container:", name);
    res.json({ ok: true });
  });
});

// ==========================
// HEALTH
// ==========================
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'wa-orchestrator' });
});

// ==========================
// START SERVER
// ==========================
app.listen(7070, () => {
  console.log("🚀 Orchestrator running on port 7070");
});
