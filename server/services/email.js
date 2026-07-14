/**
 * Transactional email via Mailgun's HTTP API -- a plain axios POST, same
 * lightweight-integration style as webflow.js/wxrks.js (no SDK dependency
 * for what's just one HTTP call; superseded an earlier SMTP/nodemailer
 * version once Mailgun's API key became available instead). This app
 * sends no other email today; used only for routes/auth.js's
 * forgot-password flow.
 *
 * Requires MAILGUN_API_KEY, MAILGUN_DOMAIN, and EMAIL_FROM to be
 * configured.
 */

const axios = require("axios");

async function sendPasswordResetEmail(to, resetUrl) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !domain || !from) {
    throw new Error("MAILGUN_API_KEY, MAILGUN_DOMAIN, and EMAIL_FROM must be configured to send email");
  }

  await axios.post(
    `https://api.mailgun.net/v3/${domain}/messages`,
    new URLSearchParams({
      from,
      to,
      subject: "Reset your password",
      html: `
        <p>Someone requested a password reset for your wxrks Sync account.</p>
        <p><a href="${resetUrl}">Reset your password</a></p>
        <p>This link expires in 1 hour and can only be used once. If you didn't request this, you can safely ignore this email.</p>
      `,
    }),
    { auth: { username: "api", password: apiKey } }
  );
}

module.exports = { sendPasswordResetEmail };
