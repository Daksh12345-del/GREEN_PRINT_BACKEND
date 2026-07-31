// email.js
// Sends real email via Resend (https://resend.com) when RESEND_API_KEY is
// set. If it isn't, this logs the email content to the server console
// instead of silently failing or pretending — same honesty pattern as the
// Groq AI fallback in aiEngine.js. This means "Forgot password" always
// works end-to-end even before you've set up Resend: you just read the
// reset link from the server logs instead of your inbox.

async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || "Green Print <onboarding@resend.dev>";

  if (!apiKey) {
    console.log("\n" + "=".repeat(60));
    console.log("EMAIL NOT SENT — no RESEND_API_KEY set in .env");
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(text || html);
    console.log("=".repeat(60) + "\n");
    return { sent: false, reason: "RESEND_API_KEY not set" };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ from, to, subject, html, text })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Resend API error ${response.status}: ${errText}`);
  }

  return { sent: true };
}

function passwordResetEmail({ resetUrl, userName }) {
  const subject = "Reset your Green Print password";
  const text =
    `Hi ${userName},\n\n` +
    `Someone requested a password reset for your Green Print account. ` +
    `Click the link below to set a new password — it expires in 15 minutes:\n\n` +
    `${resetUrl}\n\n` +
    `If you didn't request this, you can safely ignore this email.`;
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #1F5F45;">🌱 Green Print</h2>
      <p>Hi ${userName},</p>
      <p>Someone requested a password reset for your Green Print account.
      Click the button below to set a new password — it expires in <b>15 minutes</b>.</p>
      <p style="margin: 24px 0;">
        <a href="${resetUrl}" style="background:#1F5F45; color:#fff; padding:10px 20px;
           border-radius:6px; text-decoration:none; display:inline-block;">Reset Password</a>
      </p>
      <p style="color:#888; font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;
  return { subject, text, html };
}

module.exports = { sendEmail, passwordResetEmail };
