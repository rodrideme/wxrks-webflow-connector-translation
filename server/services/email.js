/**
 * Transactional email via Mailgun's SMTP relay (nodemailer -- this is
 * this app's first email integration, and SMTP has no equivalent to a
 * simple axios POST the way Webflow/wxrks's APIs do, so unlike those
 * services this genuinely needs a real client library rather than a bare
 * HTTP call). Used only for routes/auth.js's forgot-password flow.
 *
 * Requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and EMAIL_FROM to
 * be configured.
 */

const nodemailer = require("nodemailer");

let cachedTransporter = null;

function getTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS must be configured to send email");
  }
  if (!cachedTransporter) {
    const port = Number(SMTP_PORT);
    cachedTransporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465, // 465 is implicit TLS; 587/2525/25 upgrade via STARTTLS instead
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return cachedTransporter;
}

async function sendPasswordResetEmail(to, resetUrl) {
  const from = process.env.EMAIL_FROM;
  if (!from) {
    throw new Error("EMAIL_FROM must be configured to send password reset emails");
  }
  await getTransporter().sendMail({
    from,
    to,
    subject: "Reset your password",
    html: `
      <p>Someone requested a password reset for your wxrks Sync account.</p>
      <p><a href="${resetUrl}">Reset your password</a></p>
      <p>This link expires in 1 hour and can only be used once. If you didn't request this, you can safely ignore this email.</p>
    `,
  });
}

module.exports = { sendPasswordResetEmail };
