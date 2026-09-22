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

module.exports = { SERVICE_WINDOW_MS, STATUS_RANK };
