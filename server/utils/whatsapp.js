const { decrypt } = require('./crypto');

/*
 * Meta WhatsApp Cloud API client.
 * All calls need an account with phoneNumberId + accessToken (stored encrypted).
 * Errors are returned as { ok:false, error } — tokens are never logged.
 */

const GRAPH_BASE = 'https://graph.facebook.com/v19.0';

// Extract usable credentials from a whatsapp_accounts row (token still encrypted).
function credsFor(account) {
  if (!account || !account.phoneNumberId || !account.accessToken) return null;
  let token;
  try { token = decrypt(account.accessToken); } catch { return null; }
  if (!token) return null;
  return { token, phoneNumberId: account.phoneNumberId };
}

async function graphCall(path, { method = 'GET', token, body } = {}) {
  try {
    const res = await fetch(`${GRAPH_BASE}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON response */ }
    if (!res.ok) {
      return { ok: false, status: res.status, error: (data.error && data.error.message) || `Meta API error (HTTP ${res.status})` };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: 'Could not reach the WhatsApp API. Check your internet/hosting network.' };
  }
}

// Live credential check: fetches the phone number's profile from Meta.
async function testConnection(account) {
  const creds = credsFor(account);
  if (!creds) return { ok: false, error: 'Missing Phone Number ID or Access Token. Edit the account and add your Meta API credentials.' };
  const r = await graphCall(`/${creds.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, { token: creds.token });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    displayPhoneNumber: r.data.display_phone_number || '',
    verifiedName: r.data.verified_name || '',
    qualityRating: (r.data.quality_rating || '').toLowerCase(),
  };
}

// Digits-only destination (Meta wants E.164 without '+', spaces or dashes).
function cleanPhone(phone) {
  return String(phone || '').replace(/[^\d]/g, '');
}

// Send a plain text message. Returns { ok, wamid } or { ok:false, error }.
async function sendText(account, to, bodyText) {
  const creds = credsFor(account);
  if (!creds) return { ok: false, error: 'Account has no API credentials.' };
  const r = await graphCall(`/${creds.phoneNumberId}/messages`, {
    method: 'POST', token: creds.token,
    body: {
      messaging_product: 'whatsapp',
      to: cleanPhone(to),
      type: 'text',
      text: { body: bodyText, preview_url: false },
    },
  });
  if (!r.ok) return { ok: false, error: r.error };
  const wamid = r.data.messages && r.data.messages[0] && r.data.messages[0].id;
  return { ok: true, wamid: wamid || null };
}

// Send an approved template message with positional body parameters.
async function sendTemplate(account, to, templateName, languageCode, params) {
  const creds = credsFor(account);
  if (!creds) return { ok: false, error: 'Account has no API credentials.' };
  const components = (params && params.length)
    ? [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }]
    : [];
  const r = await graphCall(`/${creds.phoneNumberId}/messages`, {
    method: 'POST', token: creds.token,
    body: {
      messaging_product: 'whatsapp',
      to: cleanPhone(to),
      type: 'template',
      template: { name: templateName, language: { code: languageCode || 'en' }, components },
    },
  });
  if (!r.ok) return { ok: false, error: r.error };
  const wamid = r.data.messages && r.data.messages[0] && r.data.messages[0].id;
  return { ok: true, wamid: wamid || null };
}

module.exports = { testConnection, sendText, sendTemplate, cleanPhone, credsFor };
