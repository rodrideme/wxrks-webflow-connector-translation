/**
 * Transactional email via Mailgun's HTTP API -- a plain axios POST, same
 * lightweight-integration style as webflow.js/wxrks.js (no SDK dependency
 * for what's just one HTTP call; superseded an earlier SMTP/nodemailer
 * version once Mailgun's API key became available instead). Used for
 * routes/auth.js's forgot-password flow and routes/team.js's invite
 * emails -- this app sends no other email today.
 *
 * Requires MAILGUN_API_KEY, MAILGUN_DOMAIN, and EMAIL_FROM to be
 * configured. The logo referenced below (client/public/email-assets/
 * wxrks-logo.png) must exist as a real file for it to render -- most
 * email clients (Outlook especially) don't render SVG reliably, so this
 * is a separate raster asset from the app's own wxrks-logo.svg.
 */

const axios = require("axios");

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !domain || !from) {
    throw new Error("MAILGUN_API_KEY, MAILGUN_DOMAIN, and EMAIL_FROM must be configured to send email");
  }

  await axios.post(
    `https://api.mailgun.net/v3/${domain}/messages`,
    new URLSearchParams({ from, to, subject, html }),
    { auth: { username: "api", password: apiKey } }
  );
}

/**
 * The shared visual shell for every transactional email this app sends --
 * table-based, inline-styled, explicit bgcolor on every section (never
 * relying on transparency/inherited color, which is what causes surprises
 * in email clients' dark-mode re-coloring). Colors are this app's own
 * real design tokens (client/src/index.css's light-mode set, inlined
 * directly since email clients can't reliably evaluate CSS custom
 * properties). The footer content/structure (tagline + social icons) is
 * reused from a real wxrks marketing email's footer, minus its
 * campaign-specific tracked links.
 */
function renderEmailShell({ heading, intro, buttonLabel, actionUrl, note, casualLine }) {
  const logoUrl = `${process.env.APP_BASE_URL || ""}/email-assets/wxrks-logo.png`;

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f5f6fb;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;background-color:#f5f6fb;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;width:600px;max-width:600px;">

        <tr>
          <td align="center" style="padding:8px 24px 24px;">
            <img src="${logoUrl}" width="250" alt="wxrks" style="display:block;width:250px;max-width:250px;height:auto;border:0;outline:none;text-decoration:none;">
          </td>
        </tr>

        <tr>
          <td bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid #dee2ee;border-radius:12px;padding:40px 40px 36px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;">
              <tr>
                <td align="center" style="font-family:helvetica,'helvetica neue',arial,sans-serif;">
                  <h1 style="Margin:0 0 12px;mso-line-height-rule:exactly;font-size:22px;line-height:30px;color:#1a1d2c;font-weight:600;">${heading}</h1>
                  <p style="Margin:0 0 28px;mso-line-height-rule:exactly;font-size:15px;line-height:23px;color:#5b6178;">${intro}</p>

                  <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;margin:0 auto 28px;">
                    <tr>
                      <td align="center" bgcolor="#02ff33" style="background-color:#02ff33;border-radius:6px;">
                        <a href="${actionUrl}" target="_blank" style="display:inline-block;padding:16px 34px;mso-line-height-rule:exactly;font-family:helvetica,'helvetica neue',arial,sans-serif;font-size:16px;font-weight:700;color:#000000;text-decoration:none;border-radius:6px;">${buttonLabel}</a>
                      </td>
                    </tr>
                  </table>

                  <p style="Margin:0;mso-line-height-rule:exactly;font-size:13px;line-height:20px;color:#8b90a6;">${note}</p>
                  <p style="Margin:20px 0 0;mso-line-height-rule:exactly;font-size:14px;line-height:21px;color:#5b6178;">${casualLine}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr><td style="height:24px;line-height:24px;font-size:1px;">&nbsp;</td></tr>
      </table>
    </td>
  </tr>
</table>

<table cellspacing="0" cellpadding="0" align="center" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;width:100%;background-color:#080808;">
  <tr>
    <td bgcolor="#080808" align="center" style="padding:0;Margin:0;background-color:#080808;">
      <table align="center" cellpadding="0" cellspacing="0" bgcolor="#080808" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;background-color:#080808;width:600px;max-width:600px;">
        <tr>
          <td align="center" style="padding:28px 25px 0;Margin:0;">
            <p style="Margin:0;mso-line-height-rule:exactly;font-family:helvetica,'helvetica neue',arial,verdana,sans-serif;line-height:27px;letter-spacing:0;font-weight:normal;color:#ffffff;font-size:18px;">Grateful to have you with us. Let&rsquo;s move forward with purpose, together.</p>
            <p style="Margin:0;mso-line-height-rule:exactly;font-family:helvetica,'helvetica neue',arial,verdana,sans-serif;line-height:27px;letter-spacing:0;font-weight:normal;color:#ffffff;font-size:18px;"><br>Let&rsquo;s make it happen,<br>let&rsquo;s make it wxrks!</p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:24px 20px 0;Margin:0;">
            <table cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;">
              <tr>
                <td valign="top" align="center" style="padding:0 10px 0 0;Margin:0;">
                  <a target="_blank" href="https://www.linkedin.com/company/wxrks/" style="mso-line-height-rule:exactly;text-decoration:underline;color:#EFEFEF;font-size:14px;">
                    <img src="https://gfqajn.stripocdn.email/content/assets/img/social-icons/logo-white/linkedin-logo-white.png" alt="In" title="Linkedin" width="32" style="display:block;font-size:14px;border:0;outline:none;text-decoration:none;margin:0;">
                  </a>
                </td>
                <td valign="top" align="center" style="padding:0 10px 0 0;Margin:0;">
                  <a target="_blank" href="https://www.youtube.com/@getwxrks" style="mso-line-height-rule:exactly;text-decoration:underline;color:#EFEFEF;font-size:14px;">
                    <img width="32" src="https://gfqajn.stripocdn.email/content/assets/img/social-icons/logo-white/youtube-logo-white.png" alt="Yt" title="Youtube" style="display:block;font-size:14px;border:0;outline:none;text-decoration:none;margin:0;">
                  </a>
                </td>
                <td valign="top" align="center" style="padding:0 10px 0 0;Margin:0;">
                  <a target="_blank" href="https://x.com/getwxrks" style="mso-line-height-rule:exactly;text-decoration:underline;color:#EFEFEF;font-size:14px;">
                    <img src="https://gfqajn.stripocdn.email/content/guids/CABINET_39af47d725439bdbc5a351efccf734fec2683eb42d08cf49c8cf1c51416ddf4e/images/xformer_twitter.png" alt="X" title="X.com" width="32" style="display:block;font-size:14px;border:0;outline:none;text-decoration:none;margin:0;">
                  </a>
                </td>
                <td valign="top" align="center" style="padding:0;Margin:0;">
                  <a target="_blank" href="https://www.instagram.com/getwxrks" style="mso-line-height-rule:exactly;text-decoration:underline;color:#EFEFEF;font-size:14px;">
                    <img alt="Ig" title="Instagram" width="32" src="https://gfqajn.stripocdn.email/content/guids/CABINET_39af47d725439bdbc5a351efccf734fec2683eb42d08cf49c8cf1c51416ddf4e/images/instagram_logo.png" style="display:block;font-size:14px;border:0;outline:none;text-decoration:none;margin:0;">
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td bgcolor="#000000" align="center" style="padding:20px 20px 24px;Margin:0;">
            <p style="Margin:0;mso-line-height-rule:exactly;font-family:arial,'helvetica neue',helvetica,sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#EFEFEF;font-size:13px;">
              <a href="https://wxrks.com" target="_blank" style="color:#EFEFEF;text-decoration:underline;">wxrks.com</a>
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

async function sendPasswordResetEmail(to, resetUrl) {
  await sendEmail({
    to,
    subject: "Reset your password",
    html: renderEmailShell({
      heading: "Reset your password",
      intro: "We got a request to reset the password for your wxrks Sync account. Click below to choose a new one.",
      buttonLabel: "Reset password",
      actionUrl: resetUrl,
      note: "This link expires in 1 hour and can only be used once. Didn't request this? You can safely ignore this email.",
      casualLine: "We know, passwords are the worst. You'll be back in before you know it.",
    }),
  });
}

async function sendTeamInviteEmail(to, inviteUrl) {
  await sendEmail({
    to,
    subject: "You've been invited to wxrks Sync",
    html: renderEmailShell({
      heading: "You're invited",
      intro: "You've been invited to join a workspace on wxrks Sync. Click below to set up your account.",
      buttonLabel: "Accept invite",
      actionUrl: inviteUrl,
      note: "This link can only be used once. If you weren't expecting this, you can safely ignore this email.",
      casualLine: "Excited to have you here -- let's get you set up in no time.",
    }),
  });
}

module.exports = { sendPasswordResetEmail, sendTeamInviteEmail };
