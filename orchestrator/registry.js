const Redis = require("ioredis");
const redis = new Redis(process.env.REDIS_URL);

// CREATE
async function create(id, containerId) {
  await redis.set(
    `wa:${id}`,
    JSON.stringify({
      id,
      containerId,
      status: "starting",
      createdAt: Date.now(),
    }),
  );
}

// UPDATE
async function updateStatus(id, status) {
  const data = await redis.get(`wa:${id}`);
  if (!data) return;

  const parsed = JSON.parse(data);
  parsed.status = status;

  await redis.set(`wa:${id}`, JSON.stringify(parsed));
}

// GET ALL
async function getAll() {
  const keys = await redis.keys("wa:*");
  const values = await Promise.all(keys.map((k) => redis.get(k)));

  return values.map((v) => JSON.parse(v));
}

module.exports = { create, updateStatus, getAll };
