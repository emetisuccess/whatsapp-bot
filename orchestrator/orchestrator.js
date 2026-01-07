const express = require('express');
const { exec } = require('child_process');
const app = express();

app.use(express.json());

const API_KEY = 'CHANGE_ME_NOW';
const IMAGE = 'whatsapp-service';

// simple auth
app.use((req, res, next) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// create container
app.post('/containers', (req, res) => {
  const { instanceId } = req.body;
  if (!instanceId) return res.status(400).json({ error: 'instanceId required' });

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
    if (err) return res.status(500).json({ error: err.message });

    setTimeout(() => {
      exec(
        `docker inspect ${name} --format='{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}} {{(index (index .NetworkSettings.Ports "9090/tcp") 0).HostPort}}'`,
        (e, out) => {
          if (e) return res.status(500).json({ error: e.message });

          const [httpPort, wsPort] = out.trim().split(' ');
          res.json({ container: name, httpPort, wsPort });
        }
      );
    }, 2000);
  });
});

// delete container
app.delete('/containers/:name', (req, res) => {
  exec(`docker stop ${req.params.name} && docker rm ${req.params.name}`, err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.listen(7070, () => console.log('Orchestrator running on 7070'));
