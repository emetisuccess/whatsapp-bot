const express = require('express');
const { exec } = require('child_process');

const app = express();
app.use(express.json());

// ==============================
// SECURITY
// ==============================
const API_KEY = process.env.ORCH_KEY;

if (!API_KEY) {
  console.error('❌ ORCH_KEY is NOT set. Exiting.');
  process.exit(1);
}

const IMAGE = 'whatsapp-service';

// ==============================
// AUTH MIDDLEWARE
// ==============================
app.use((req, res, next) => {
  const key =
    req.headers['x-api-key'] ||
    req.headers['authorization'] ||
    req.headers['Authorization'];

  if (!key) {
    console.log('❌ No API key header received');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cleanKey = key.startsWith('Bearer ')
    ? key.slice(7)
    : key;

  if (cleanKey.trim() !== API_KEY.trim()) {
    console.log('❌ Invalid API key:', cleanKey);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
});

// ==============================
// CREATE CONTAINER
// ==============================
app.post('/containers', (req, res) => {
  const { instanceId } = req.body;

  if (!instanceId) {
    return res.status(400).json({ error: 'instanceId required' });
  }

  const name = `wa_${instanceId}`;

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
      ${IMAGE}
  `;

  exec(cmd, (err) => {
    if (err) {
      console.error('❌ Docker run failed:', err.message);
      return res.status(500).json({ error: err.message });
    }

    // wait for container networking
    setTimeout(() => {
      exec(
        `docker inspect ${name} --format='{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}} {{(index (index .NetworkSettings.Ports "9090/tcp") 0).HostPort}}'`,
        (e, out) => {
          if (e) {
            console.error('❌ Docker inspect failed:', e.message);
            return res.status(500).json({ error: e.message });
          }

          const [httpPort, wsPort] = out.trim().split(' ');

          res.json({
            container: name,
            httpPort,
            wsPort
          });
        }
      );
    }, 2000);
  });
});

// ==============================
// DELETE CONTAINER
// ==============================
app.delete('/containers/:name', (req, res) => {
  const name = req.params.name;

  exec(`docker stop ${name} && docker rm ${name}`, (err) => {
    if (err) {
      console.error('❌ Failed to delete container:', err.message);
      return res.status(500).json({ error: err.message });
    }

    res.json({ ok: true });
  });
});

// ==============================
// HEALTH
// ==============================
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ==============================
app.listen(7070, () => {
  console.log('🚀 Orchestrator running on port 7070');
});
