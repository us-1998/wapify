// config/redis.js
const { createClient } = require('redis');
const client = createClient({ url: process.env.REDIS_URL });
client.on('error', err => console.error('Redis error:', err));
(async () => { try { await client.connect(); } catch(e) { console.warn('Redis not connected:', e.message); } })();
module.exports = client;
