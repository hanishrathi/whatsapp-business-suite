/*
 * WhatsApp message billing.
 *
 * Meta's model changed twice recently, and the second change lands soon:
 *   - 1 Jul 2025: per-message pricing for template messages replaced
 *     conversation-based pricing.
 *   - 1 Oct 2026: free-form SERVICE messages sent inside the 24-hour customer
 *     service window become billable per delivered message, at the recipient
 *     market's utility/authentication rate, after a monthly free allowance per
 *     business phone number. Utility templates sent inside an open window also
 *     lose the free status they had since Nov 2024.
 *
 * This module classifies each message and estimates spend so the cost is
 * visible before the bill arrives. Rates are indicative, not authoritative —
 * Meta publishes per-market rates that change; set WA_RATE_* to your own.
 */

// The date the service-message charge begins.
const SERVICE_BILLING_START = Date.parse('2026-10-01T00:00:00Z');

// Free service messages per business phone number per calendar month.
const SERVICE_FREE_ALLOWANCE = parseInt(process.env.WA_SERVICE_FREE_ALLOWANCE || '1000', 10);

/*
 * Indicative per-message rates in USD. Override per deployment — these differ
 * by recipient market and Meta revises them.
 */
function rates() {
  return {
    marketing: parseFloat(process.env.WA_RATE_MARKETING || '0.0099'),
    utility: parseFloat(process.env.WA_RATE_UTILITY || '0.0040'),
    authentication: parseFloat(process.env.WA_RATE_AUTHENTICATION || '0.0035'),
    // Service is charged at the utility/authentication rate from Oct 2026.
    service: parseFloat(process.env.WA_RATE_SERVICE || process.env.WA_RATE_UTILITY || '0.0040'),
  };
}

/*
 * Classify a message for billing.
 *   - a free-form reply inside the service window is 'service'
 *   - a template is billed by its own Meta category
 */
function categoryFor({ isTemplate, templateCategory }) {
  if (!isTemplate) return 'service';
  const c = String(templateCategory || 'marketing').toLowerCase();
  if (c === 'utility' || c === 'authentication' || c === 'marketing') return c;
  return 'marketing';
}

/*
 * Is this message billable at the moment it is sent?
 * Service messages are free until the Oct 2026 cutover; templates always bill.
 */
function isBillable(category, at = Date.now()) {
  if (category === 'service') return at >= SERVICE_BILLING_START;
  return true;
}

// Has the Oct 2026 service-message charge taken effect yet?
function serviceBillingActive(at = Date.now()) {
  return at >= SERVICE_BILLING_START;
}

function daysUntilServiceBilling(at = Date.now()) {
  return Math.ceil((SERVICE_BILLING_START - at) / (24 * 60 * 60 * 1000));
}

/*
 * Estimated cost for a set of {category, count} rows, applying the monthly
 * free allowance to service messages only.
 */
function estimate(counts, { serviceAlreadySent = 0 } = {}) {
  const r = rates();
  let total = 0;
  const lines = [];
  for (const [category, count] of Object.entries(counts)) {
    if (!count) continue;
    let billableCount = count;
    if (category === 'service') {
      if (!serviceBillingActive()) billableCount = 0;
      else {
        // Only what exceeds the free allowance is charged.
        const remainingFree = Math.max(0, SERVICE_FREE_ALLOWANCE - serviceAlreadySent);
        billableCount = Math.max(0, count - remainingFree);
      }
    }
    const rate = r[category] || 0;
    const cost = Math.round(billableCount * rate * 10000) / 10000;
    total += cost;
    lines.push({ category, count, billableCount, rate, cost });
  }
  return { lines, total: Math.round(total * 10000) / 10000, currency: 'USD' };
}

module.exports = {
  categoryFor, isBillable, estimate, rates,
  serviceBillingActive, daysUntilServiceBilling,
  SERVICE_BILLING_START, SERVICE_FREE_ALLOWANCE,
};
