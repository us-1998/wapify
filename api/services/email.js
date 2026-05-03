// services/email.js — Transactional email via Nodemailer/Brevo
const nodemailer = require('nodemailer');
const logger = require('../config/logger');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const FROM = `"${process.env.EMAIL_FROM_NAME || 'Wapify'}" <${process.env.EMAIL_FROM}>`;

const send = async ({ to, subject, html, text }) => {
  try {
    await transporter.sendMail({ from: FROM, to, subject, html, text });
    logger.info(`Email sent to ${to}: ${subject}`);
  } catch (err) {
    logger.error('Email failed:', err.message);
    throw err;
  }
};

const sendVerification = (email, token) => send({
  to: email, subject: 'Verify your Wapify email',
  html: `<p>Click to verify: <a href="${process.env.APP_URL}/auth/verify-email/${token}">Verify Email</a></p>
         <p>This link expires in 24 hours.</p>`,
});

const sendInvite = ({ to, inviterName, orgName, roleName, tempPassword, loginUrl }) => send({
  to, subject: `You've been invited to ${orgName} on Wapify`,
  html: `<h2>You're invited!</h2>
         <p><strong>${inviterName}</strong> has invited you to join <strong>${orgName}</strong> on Wapify as a <strong>${roleName}</strong>.</p>
         <p>Your temporary login:</p>
         <ul><li>Email: ${to}</li><li>Password: <code>${tempPassword}</code></li></ul>
         <p><a href="${loginUrl}" style="background:#25D366;color:white;padding:10px 20px;border-radius:8px;text-decoration:none">Login to Wapify →</a></p>
         <p>Please change your password after logging in.</p>`,
});

const sendPasswordReset = (email, token) => send({
  to: email, subject: 'Reset your Wapify password',
  html: `<p>Reset your password: <a href="${process.env.APP_URL}/auth/reset-password?token=${token}">Reset Password</a></p>
         <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>`,
});

const sendTrialEnding = (email, firstName, daysLeft) => send({
  to: email, subject: `Your Wapify trial ends in ${daysLeft} days`,
  html: `<h2>Hi ${firstName}!</h2>
         <p>Your Wapify free trial ends in <strong>${daysLeft} days</strong>.</p>
         <p>Upgrade now to keep your store connections and flows active.</p>
         <a href="${process.env.APP_URL}/billing" style="background:#25D366;color:white;padding:10px 20px;border-radius:8px;text-decoration:none">Upgrade now →</a>`,
});

module.exports = { send, sendVerification, sendInvite, sendPasswordReset, sendTrialEnding };
