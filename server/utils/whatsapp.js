const { decrypt } = require('./crypto');

/*
 * Meta WhatsApp Cloud API client.
 * All calls need an account with phoneNumberId + accessToken (stored encrypted).
 * Errors are returned as { ok:false, error, code } — tokens are never logged.
 *
 * Graph API versions are supported for roughly two years after release, so the
 * version is configurable: bump WA_GRAPH_VERSION rather than editing code.
 * See https://developers.facebook.com/docs/graph-api/guides/versioning
 */

const GRAPH_VERSION = process.env.WA_GRAPH_VERSION || 'v23.0';
/*
 * Graph host. Override with WA_GRAPH_BASE_URL to point at Meta's sandbox, an
 * outbound proxy, or a local stub for testing — production leaves it unset.
 */
const GRAPH_HOST = (process.env.WA_GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, '');
const GRAPH_BASE = `${GRAPH_HOST}/${GRAPH_VERSION}`;

/*
 * Meta error codes we act on. Everything else is treated as a permanent
 * per-recipient failure.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
const ERROR_CODES = {
  RATE_LIMIT: 130429,        // Cloud API throughput reached — back off and retry.
  PAIR_RATE_LIMIT: 131056,   // Too many messages to this same recipient — back off.
  TOO_MANY_REQUESTS: 4,      // App-level request throttling — back off.
  REENGAGEMENT: 131047,      // 24h customer service window closed — template required.
  UNDELIVERABLE: 131026,     // Not on WhatsApp / blocked / restricted — permanent.
  ECOSYSTEM_LIMIT: 131049,   // Per-user marketing frequency cap — stop this run.
  TEMPLATE_MISSING: 132001,  // Template name/language not approved on this WABA.
  TEMPLATE_PARAM_COUNT: 132000,
  TOKEN_EXPIRED: 190,
};

// Codes where retrying the same message later is worthwhile.
const RETRYABLE = new Set([ERROR_CODES.RATE_LIMIT, ERROR_CODES.PAIR_RATE_LIMIT, ERROR_CODES.TOO_MANY_REQUESTS]);
// Codes that mean "stop the whole broadcast", not just this recipient.
const FATAL_FOR_RUN = new Set([ERROR_CODES.ECOSYSTEM_LIMIT, ERROR_CODES.TEMPLATE_MISSING, ERROR_CODES.TOKEN_EXPIRED]);

function isRetryable(code) { return RETRYABLE.has(code); }
function isFatalForRun(code) { return FATAL_FOR_RUN.has(code); }

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
      const e = data.error || {};
      return {
        ok: false,
        status: res.status,
        // Numeric Meta error code — callers branch on this, not on the message text.
        code: typeof e.code === 'number' ? e.code : null,
        subcode: typeof e.error_subcode === 'number' ? e.error_subcode : null,
        error: e.error_user_msg || e.message || `Meta API error (HTTP ${res.status})`,
      };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      code: null,
      error: 'Could not reach the WhatsApp API. Check your internet/hosting network.',
      // A network blip is worth retrying; a rejected message is not.
      networkError: true,
    };
  }
}

// Live credential check: fetches the phone number's profile from Meta.
async function testConnection(account) {
  const creds = credsFor(account);
  if (!creds) return { ok: false, error: 'Missing Phone Number ID or Access Token. Edit the account and add your Meta API credentials.' };
  const fields = 'display_phone_number,verified_name,quality_rating,messaging_limit_tier';
  const r = await graphCall(`/${creds.phoneNumberId}?fields=${fields}`, { token: creds.token });
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  return {
    ok: true,
    displayPhoneNumber: r.data.display_phone_number || '',
    verifiedName: r.data.verified_name || '',
    qualityRating: (r.data.quality_rating || '').toLowerCase(),
    messagingLimit: tierToLimit(r.data.messaging_limit_tier),
  };
}

/*
 * Meta reports the messaging limit as a tier string. It caps how many UNIQUE
 * recipients a number may start business-initiated conversations with in a
 * rolling 24 hours.
 *
 * Returns null when Meta did not report a tier. Guessing a number here is
 * worse than admitting ignorance: a low guess blocks legitimate sends, a high
 * one gives false confidence. Callers decide what to do with "unknown".
 */
function tierToLimit(tier) {
  switch (String(tier || '').toUpperCase()) {
    case 'TIER_50': return 50;
    case 'TIER_250': return 250;
    case 'TIER_1K': return 1000;
    case 'TIER_10K': return 10000;
    case 'TIER_100K': return 100000;
    case 'TIER_UNLIMITED': return Number.MAX_SAFE_INTEGER;
    default: return null;
  }
}

/*
 * E.164: 8–15 digits including country code, first digit non-zero.
 * Meta wants the number without '+', spaces or dashes.
 */
function cleanPhone(phone) {
  return String(phone || '').replace(/[^\d]/g, '');
}

function isValidE164(phone) {
  return /^[1-9]\d{7,14}$/.test(cleanPhone(phone));
}

/*
 * Send a free-form text message. ONLY valid inside an open 24-hour customer
 * service window — callers must check that first. Outside the window Meta
 * rejects this with error 131047 and repeated attempts hurt account quality.
 */
async function sendText(account, to, bodyText) {
  const creds = credsFor(account);
  if (!creds) return { ok: false, error: 'Account has no API credentials.' };
  if (!isValidE164(to)) return { ok: false, error: `"${to}" is not a valid international number (include the country code).` };
  const r = await graphCall(`/${creds.phoneNumberId}/messages`, {
    method: 'POST', token: creds.token,
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone(to),
      type: 'text',
      text: { body: bodyText, preview_url: false },
    },
  });
  if (!r.ok) return { ok: false, error: r.error, code: r.code, networkError: r.networkError };
  const wamid = r.data.messages && r.data.messages[0] && r.data.messages[0].id;
  return { ok: true, wamid: wamid || null };
}

/*
 * Send an approved template message.
 *
 * `components` is passed through to Meta as-is, so header/body/button
 * parameters all work. Build it with buildTemplateComponents() so the
 * parameter counts match what the approved template actually declares —
 * a mismatch is rejected with error 132000.
 */
async function sendTemplate(account, to, templateName, languageCode, components = []) {
  const creds = credsFor(account);
  if (!creds) return { ok: false, error: 'Account has no API credentials.' };
  if (!isValidE164(to)) return { ok: false, error: `"${to}" is not a valid international number (include the country code).` };
  const r = await graphCall(`/${creds.phoneNumberId}/messages`, {
    method: 'POST', token: creds.token,
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone(to),
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode || 'en' },
        ...(components.length ? { components } : {}),
      },
    },
  });
  if (!r.ok) return { ok: false, error: r.error, code: r.code, networkError: r.networkError };
  const wamid = r.data.messages && r.data.messages[0] && r.data.messages[0].id;
  return { ok: true, wamid: wamid || null };
}

/*
 * Build the `components` array for a send from the template's own definition
 * (as synced from Meta) and a map of variable values.
 *
 * `template.components` mirrors Meta's structure. We fill positional BODY and
 * HEADER text parameters only — media headers and dynamic button URLs need
 * per-message data this app doesn't model yet, and are reported as unsupported
 * rather than sent wrong.
 */
function buildTemplateComponents(template, values = {}) {
  const defs = Array.isArray(template.components) ? template.components : [];
  const out = [];

  for (const def of defs) {
    const type = String(def.type || '').toUpperCase();

    if (type === 'HEADER') {
      const format = String(def.format || 'TEXT').toUpperCase();
      if (format !== 'TEXT') continue; // media headers carry no text params
      const count = countPlaceholders(def.text);
      if (!count) continue;
      out.push({ type: 'header', parameters: positional(count, values) });
    } else if (type === 'BODY') {
      const count = countPlaceholders(def.text);
      if (!count) continue;
      out.push({ type: 'body', parameters: positional(count, values) });
    }
    // FOOTER never takes parameters. BUTTONS need per-button payloads we don't model.
  }
  return out;
}

function countPlaceholders(text) {
  const m = String(text || '').match(/\{\{\s*(\d+)\s*\}\}/g);
  if (!m) return 0;
  // The highest index wins — {{1}} {{3}} means the template declares 3 slots.
  return Math.max(...m.map(s => parseInt(s.replace(/\D/g, ''), 10)));
}

// Positional parameters 1..count, pulled from `values` keyed by index.
function positional(count, values) {
  const params = [];
  for (let i = 1; i <= count; i++) {
    params.push({ type: 'text', text: String(values[i] ?? values[String(i)] ?? '') });
  }
  return params;
}

/* ---------- template sync ---------- */

/*
 * Fetch every message template defined on a WABA. Templates are created and
 * approved in Meta Business Manager — this app mirrors them, it cannot create
 * an approved template on its own.
 */
async function listTemplates(account) {
  const creds = credsFor(account);
  if (!creds) return { ok: false, error: 'Account has no API credentials.' };
  if (!account.wabaId) return { ok: false, error: 'This account has no WhatsApp Business Account ID (WABA ID). Add it in Accounts.' };

  const all = [];
  let path = `/${account.wabaId}/message_templates?fields=name,status,category,language,components,id,rejected_reason&limit=100`;
  // Follow Meta's cursor pagination, with a hard stop so a bad cursor can't loop.
  for (let page = 0; page < 20 && path; page++) {
    const r = await graphCall(path, { token: creds.token });
    if (!r.ok) return { ok: false, error: r.error, code: r.code };
    all.push(...(r.data.data || []));
    const next = r.data.paging && r.data.paging.next;
    if (!next) break;
    // `next` is an absolute URL; reduce it back to a path for graphCall.
    const idx = next.indexOf(GRAPH_VERSION);
    path = idx === -1 ? null : next.slice(idx + GRAPH_VERSION.length);
  }
  return { ok: true, templates: all };
}

/* ---------- click-to-chat (manual / non-API channels) ---------- */

/*
 * A wa.me link opens a chat in whichever WhatsApp app the operator has — the
 * WhatsApp Business app or regular WhatsApp. This is the officially supported
 * way to reach those channels; there is no API for them.
 * https://faq.whatsapp.com/5913398998672934
 */
function clickToChatUrl(phone, text) {
  const num = cleanPhone(phone);
  const q = text ? `?text=${encodeURIComponent(text)}` : '';
  return `https://wa.me/${num}${q}`;
}

module.exports = {
  testConnection, sendText, sendTemplate, listTemplates,
  buildTemplateComponents, countPlaceholders,
  cleanPhone, isValidE164, credsFor, clickToChatUrl, tierToLimit,
  ERROR_CODES, isRetryable, isFatalForRun,
  GRAPH_VERSION,
};
