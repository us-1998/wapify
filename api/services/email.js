const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const FROM = `"${process.env.EMAIL_FROM_NAME || 'Wapify'}" <${process.env.EMAIL_FROM}>`;

const send = async ({ to, subject, html }) => {
  if (!process.env.SMTP_HOST) { console.log(`[EMAIL] To:${to} Sub:${subject}`); return; }
  await transporter.sendMail({ from: FROM, to, subject, html });
};

module.exports = {
  sendVerification: (email, token) => send({ to: email, subject: 'Verify your Wapify email',
    html: `<p>Click to verify your email: <a href="${process.env.APP_URL}/verify-email?token=${token}">Verify Email</a></p><p>Link expires in 24 hours.</p>` }),

  sendInvite: ({ to, inviterName, orgName, roleName, tempPassword, loginUrl }) => send({ to,
    subject: `You've been invited to ${orgName} on Wapify`,
    html: `<h2>You're invited to ${orgName}!</h2><p><strong>${inviterName}</strong> invited you as <strong>${roleName}</strong>.</p><p>Login: <strong>${to}</strong><br>Temp password: <strong>${tempPassword}</strong></p><p><a href="${loginUrl}" style="background:#25D366;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block">Login to Wapify →</a></p><p>Please change your password after logging in.</p>` }),

  sendPasswordReset: (email, token) => send({ to: email, subject: 'Reset your Wapify password',
    html: `<p>Reset your password: <a href="${process.env.APP_URL}/reset-password?token=${token}">Reset Password</a></p><p>This link expires in 1 hour.</p>` }),

  sendTrialEnding: (email, firstName, daysLeft) => send({ to: email, subject: `Your Wapify trial ends in ${daysLeft} days`,
    html: `<h2>Hi ${firstName}!</h2><p>Your free trial ends in <strong>${daysLeft} days</strong>. Upgrade now to keep your automations running.</p><a href="${process.env.APP_URL}/billing" style="background:#25D366;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block">Upgrade now →</a>` }),
};
