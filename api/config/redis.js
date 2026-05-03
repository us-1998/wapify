// config/redis.js
const { createClient } = require('redis');
const logger = require('./logger');

const client = createClient({ url: process.env.REDIS_URL });

client.on('error', (err) => logger.error('Redis error:', err));
client.on('connect', () => logger.info('Redis connected'));

(async () => { await client.connect(); })();

module.exports = client;
