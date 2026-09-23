/*
 * Values shared by more than one data module. Kept in one place so the 24-hour
 * window and the status ordering cannot drift apart between the broadcast and
 * conversation paths.
 */

// A contact's inbound message opens a 24h customer service window, during
// which free-form (non-template) replies are allowed.
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/*
 * Delivery statuses only ever move forward, so a late 'delivered' webhook
 * cannot undo a 'read'. 'received' is the inbound resting state and 'pending'
 * the outbound one; both rank 0.
 */
const STATUS_RANK = { received: 0, pending: 0, sent: 1, delivered: 2, read: 3, failed: 9 };

/*
 * The message categories Meta bills and gates on. Everything that compares a
 * category MUST go through normaliseCategory first.
 *
 * This is not cosmetic. The marketing opt-out is enforced by comparing the
 * category against the string 'marketing'; a value of ' marketing' (or
 * 'Marketing ', or a tab) failed that comparison, so the
 * `AND marketingOptOutAt IS NULL` clause was dropped from the audience query
 * and marketing went to people who had explicitly opted out of it. Trim and
 * allowlist at every boundary, and the comparison cannot fail open.
 */
const MESSAGE_CATEGORIES = ['marketing', 'utility', 'authentication'];
const DEFAULT_CATEGORY = 'marketing';

// Returns a known category, or null when the value is not one. Never guesses.
function normaliseCategory(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return MESSAGE_CATEGORIES.includes(v) ? v : null;
}

/*
 * For read paths that must not throw. An unrecognised category falls back to
 * 'marketing' — the most restrictive option, so consent checks stay ON rather
 * than being skipped. Failing safe here means over-filtering, never
 * over-sending.
 */
function categoryOrSafeDefault(value) {
  return normaliseCategory(value) || DEFAULT_CATEGORY;
}

module.exports = {
  SERVICE_WINDOW_MS, STATUS_RANK,
  MESSAGE_CATEGORIES, DEFAULT_CATEGORY, normaliseCategory, categoryOrSafeDefault,
};
