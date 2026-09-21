const crypto = require('crypto');
const nodemailer = require('nodemailer');

// Generate 6-digit OTP
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

// Create email transporter
function createMailTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// Send Email OTP
async function sendEmailOTP(email, otp, name) {
  const transporter = createMailTransporter();

  const html = `
    <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:16px;border:1px solid #e8e8ed;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;background:#25D366;border-radius:12px;margin-bottom:12px;">
          <span style="color:#fff;font-size:24px;font-weight:bold;">W</span>
        </div>
        <h2 style="margin:0;color:#1d1d1f;font-size:22px;">WhatsApp Suite</h2>
        <p style="color:#86868b;font-size:13px;margin:4px 0 0;">by AcquiHire Tech</p>
      </div>
      <p style="color:#1d1d1f;font-size:15px;line-height:1.5;">Hi ${name || 'there'},</p>
      <p style="color:#6e6e73;font-size:14px;line-height:1.6;">Use the verification code below to complete your action. This code expires in ${process.env.OTP_EXPIRY_MINUTES || 10} minutes.</p>
      <div style="text-align:center;margin:28px 0;">
        <div style="display:inline-block;background:#f5f5f7;padding:16px 32px;border-radius:12px;letter-spacing:8px;font-size:32px;font-weight:800;color:#1d1d1f;font-family:'JetBrains Mono',monospace;">${otp}</div>
      </div>
      <p style="color:#86868b;font-size:12px;text-align:center;">If you didn't request this, please ignore this email.</p>
      <hr style="border:none;border-top:1px solid #e8e8ed;margin:24px 0;">
      <p style="color:#a1a1a6;font-size:11px;text-align:center;">WhatsApp Suite by AcquiHire Tech</p>
    </div>
  `;

  await transporter.sendMail({
    from: `"${process.env.FROM_NAME}" <${process.env.FROM_EMAIL}>`,
    to: email,
    subject: `${otp} is your verification code — WhatsApp Suite`,
    html,
  });
}

// Send WhatsApp OTP via Meta Cloud API
async function sendWhatsAppOTP(phone, otp) {
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
  const accessToken = process.env.WA_ACCESS_TOKEN;
  const isProd = process.env.NODE_ENV === 'production';

  if (!phoneNumberId || !accessToken) {
    if (isProd) {
      // Fail closed: never silently skip + log OTPs in production.
      throw new Error('WhatsApp OTP not configured (WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN missing).');
    }
    // Development only: surface the code to the local console for testing.
    console.warn('[DEV ONLY] WhatsApp OTP credentials missing — code printed for local testing.');
    console.log(`[DEV] WhatsApp OTP for ${phone}: ${otp}`);
    return;
  }

  const graphVersion = process.env.WA_GRAPH_VERSION || 'v23.0';
  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;

  // Clean phone number (remove spaces, dashes)
  const cleanPhone = phone.replace(/[\s\-\(\)]/g, '');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'template',
        template: {
          name: process.env.WA_OTP_TEMPLATE || 'otp_verification',
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters: [{ type: 'text', text: otp }],
            },
            {
              type: 'button',
              sub_type: 'url',
              index: '0',
              parameters: [{ type: 'text', text: otp }],
            },
          ],
        },
      }),
    });

    if (!response.ok) {
      // Log only a redacted summary — never the token or full error body.
      console.error('WhatsApp OTP send failed with HTTP status:', response.status);
      throw new Error('WhatsApp message send failed.');
    }
  } catch (err) {
    // Re-throw so callers know delivery failed; never log the OTP.
    console.error('WhatsApp OTP delivery error:', err.message);
    throw err;
  }
}

module.exports = { generateOTP, sendEmailOTP, sendWhatsAppOTP };
