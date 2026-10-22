const { categoryOrSafeDefault } = require('../data/_constants');
/*
 * WhatsApp message billing.
 *
 * Meta's model, as published on its pricing page (checked 22 Oct 2026):
 *   - Billing is per DELIVERED message. Meta does not charge for messages that
 *     were only sent, and never for messages from users to the business.
 *   - Each message has one category and incurs at most one charge: templates
 *     are marketing, utility or authentication; a free-form reply inside the
 *     24-hour customer service window is 'service'.
 *   - 1 Jul 2025: per-message pricing for templates replaced conversation-based
 *     pricing.
 *   - 1 Oct 2026: service messages (and utility messages sent inside an open
 *     window) became billable. Service messages are charged at the recipient
 *     market's utility/authentication rate, with no volume tiers.
 *   - Each business phone number has ONE free tier of 1,000 delivered service
 *     messages per calendar month. It does not roll over.
 *   - The recipient's country calling code decides which market rate applies.
 *   - Rate cards are published in 16 currencies (INR included). An account's
 *     billing currency is fixed when it is created. Meta may change rates only
 *     on the first day of a quarter (Jan, Apr, Jul, Oct).
 *   - Messages inside a free entry point window (e.g. from a click-to-WhatsApp
 *     ad) are not charged.
 *
 * This module classifies each message and estimates spend so the cost is
 * visible before the bill arrives. It is an ESTIMATE:
 *   - it uses ONE rate per category for every recipient, where Meta prices by
 *     recipient country, so mixed-country audiences will differ from the invoice;
 *   - it cannot see free entry point windows, so it can over-count;
 *   - "this month" is the server's calendar month, Meta's is the messaging
 *     account's timezone.
 * Set WA_RATE_* (and WA_RATE_CURRENCY) from your own rate card. Meta's INR and
 * other currency CSVs are on https://developers.facebook.com/documentation/
 * business-messaging/whatsapp/pricing
 */

// The date the service-message charge began.
const SERVICE_BILLING_START = Date.parse('2026-10-01T00:00:00Z');

// Free delivered service messages per business phone number per calendar month.
const SERVICE_FREE_ALLOWANCE = parseInt(process.env.WA_SERVICE_FREE_ALLOWANCE || '1000', 10);

// The currency the rates below are written in. Must match the rate card you
// copied them from, and your account's billing currency.
const DEFAULT_CURRENCY = 'USD';
function currency() {
  const c = String(process.env.WA_RATE_CURRENCY || DEFAULT_CURRENCY).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : DEFAULT_CURRENCY;
}

/*
 * Indicative per-message rates, in currency(). The built-in defaults are US
 * dollars and are placeholders, not Meta's rates for any particular market.
 */
const DEFAULT_RATES = { marketing: 0.0099, utility: 0.0040, authentication: 0.0035 };

function rates() {
  const utility = parseFloat(process.env.WA_RATE_UTILITY || DEFAULT_RATES.utility);
  return {
    marketing: parseFloat(process.env.WA_RATE_MARKETING || DEFAULT_RATES.marketing),
    utility,
    authentication: parseFloat(process.env.WA_RATE_AUTHENTICATION || DEFAULT_RATES.authentication),
    // Service is charged at the utility/authentication rate (Meta publishes it equal).
    service: parseFloat(process.env.WA_RATE_SERVICE || utility),
  };
}

// True when any rate in use is a built-in placeholder rather than one you set.
function usingDefaultRates() {
  return !(process.env.WA_RATE_MARKETING && process.env.WA_RATE_UTILITY &&
           process.env.WA_RATE_AUTHENTICATION);
}

/*
 * Classify a message for billing.
 *   - a free-form reply inside the service window is 'service'
 *   - a template is billed by its own Meta category
 */
function categoryFor({ isTemplate, templateCategory }) {
  if (!isTemplate) return 'service';
  return categoryOrSafeDefault(templateCategory);
}

/*
 * Is this message billable at the moment it is sent?
 * Service messages became billable on SERVICE_BILLING_START; templates always bill.
 * (The first SERVICE_FREE_ALLOWANCE per number per month are still free; that is
 * applied in estimate(), not here.)
 */
function isBillable(category, at = Date.now()) {
  if (category === 'service') return at >= SERVICE_BILLING_START;
  return true;
}

// Has the service-message charge taken effect yet?
function serviceBillingActive(at = Date.now()) {
  return at >= SERVICE_BILLING_START;
}

function daysUntilServiceBilling(at = Date.now()) {
  return Math.ceil((SERVICE_BILLING_START - at) / (24 * 60 * 60 * 1000));
}

/*
 * Service messages that are actually charged: the part of each business phone
 * number's monthly count above its own free tier. serviceByAccount is an array
 * of delivered-service counts, one per number.
 */
function billableServiceAcrossNumbers(serviceByAccount) {
  return serviceByAccount.reduce((sum, n) => sum + Math.max(0, n - SERVICE_FREE_ALLOWANCE), 0);
}

/*
 * Estimated cost for a set of {category, count} rows of DELIVERED messages.
 *
 * The free tier is per business phone number. Pass serviceByAccount (delivered
 * service messages per number) and it is applied to each number separately. If
 * you only have a single pool, pass serviceAlreadySent instead and one free
 * tier is applied to the whole pool (the older behaviour).
 */
function estimate(counts, { serviceAlreadySent = 0, serviceByAccount = null } = {}) {
  const r = rates();
  let total = 0;
  const lines = [];
  for (const [category, count] of Object.entries(counts)) {
    if (!count) continue;
    let billableCount = count;
    if (category === 'service') {
      if (!serviceBillingActive()) billableCount = 0;
      else if (Array.isArray(serviceByAccount)) billableCount = billableServiceAcrossNumbers(serviceByAccount);
      else {
        const remainingFree = Math.max(0, SERVICE_FREE_ALLOWANCE - serviceAlreadySent);
        billableCount = Math.max(0, count - remainingFree);
      }
    }
    const rate = r[category] || 0;
    const cost = Math.round(billableCount * rate * 10000) / 10000;
    total += cost;
    lines.push({ category, count, billableCount, rate, cost });
  }
  return {
    lines,
    total: Math.round(total * 10000) / 10000,
    currency: currency(),
    usingDefaultRates: usingDefaultRates(),
  };
}

// "₹1,234.50" / "$1.23"; falls back to "CODE 1.23" if the runtime does not know the code.
function formatMoney(amount, code = currency()) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code }).format(amount);
  } catch (e) {
    return `${code} ${Number(amount).toFixed(2)}`;
  }
}

module.exports = {
  categoryFor, isBillable, estimate, rates, currency, formatMoney, usingDefaultRates,
  billableServiceAcrossNumbers,
  serviceBillingActive, daysUntilServiceBilling,
  SERVICE_BILLING_START, SERVICE_FREE_ALLOWANCE, DEFAULT_RATES,
};
