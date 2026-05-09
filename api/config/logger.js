const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === 'production'
      ? winston.format.json()
      : winston.format.combine(
          winston.format.colorize({ all: true }),
          winston.format.printf(({ level, message, timestamp, ...meta }) => {
            const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
            return `${timestamp} ${level}: ${message}${extra}`;
          })
        )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error', maxsize: 10485760, maxFiles: 3 }),
    new winston.transports.File({ filename: path.join(logsDir, 'combined.log'), maxsize: 10485760, maxFiles: 5 }),
  ],
});

module.exports = logger;
