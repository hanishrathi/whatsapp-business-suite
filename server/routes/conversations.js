const express = require('express');
const router = express.Router();
const messages = require('../data/messages');
const contacts = require('../data/contacts');
const waAccounts = require('../data/whatsappAccounts');
const wa = require('../utils/whatsapp');
const billing = require('../utils/billing');
const { protect, requireVerified } = require('../middleware/auth');
const { logAction } = require('../utils/audit');

/*
 * Conversations — real inbound/outbound message threads.
 *
 * This is the one place free-form (non-template) sending is legal, and only
 * while the 24-hour customer service window opened by the contact's own
 * inbound message is still open. The window is checked server-side from
 * stored inbound messages on every send, so a stale UI cannot bypass it.
 */

// GET /api/conversations — one row per contact with traffic
router.get('/', protect, (req, res) => {
  try {
    const list = messages.listConversations(req.user._id);
    res.json({ success: true, conversations: list, count: list.length });
  } catch (err) {
    console.error('List conversations error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load conversations.' });
  }
});

// GET /api/conversations/:contactId — the full thread + window state
router.get('/:contactId', protect, (req, res) => {
  try {
    const contact = contacts.findByIdForUser(req.params.contactId, req.user._id);
    const thread = messages.listThread(req.user._id, req.params.contactId);
    const window = messages.serviceWindow(req.user._id, req.params.contactId);
    res.json({ success: true, messages: thread, window, contact: contact || undefined });
  } catch (err) {
    console.error('Get conversation error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load conversation.' });
  }
});

/*
 * POST /api/conversations/:contactId/reply — free-form reply.
 *
 * Refused unless the 24h window is open. Outside it, WhatsApp requires an
 * approved template, which is what broadcasts are for.
 */
router.post('/:contactId/reply', protect, requireVerified, async (req, res) => {
  try {
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ success: false, message: 'Type a message first.' });
    if (body.length > 4096) {
      return res.status(400).json({ success: false, message: 'WhatsApp text messages are limited to 4096 characters.' });
    }

    const contact = contacts.findByIdForUser(req.params.contactId, req.user._id);
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found.' });

    // An opt-out applies to replies too — if someone said stop, stop.
    if (contact.optOutAt) {
      return res.status(403).json({
        success: false,
        message: 'This contact has opted out. You cannot message them until they opt in again.',
        code: 'OPTED_OUT',
      });
    }

    // The window is the whole basis for free-form being allowed.
    const window = messages.serviceWindow(req.user._id, req.params.contactId);
    if (!window.open) {
      return res.status(403).json({
        success: false,
        message: window.lastInboundAt
          ? 'The 24-hour customer service window has closed. Send an approved template instead — free-form replies are only allowed within 24 hours of the customer\'s last message.'
          : 'This contact has never messaged you, so there is no open service window. Business-initiated messages must use an approved template.',
        code: 'WINDOW_CLOSED',
        window,
      });
    }

    const account = req.body.accountId
      ? waAccounts.findForUserWithToken(req.body.accountId, req.user._id)
      : waAccounts.firstSendableForUser(req.user._id);
    if (!account) {
      return res.status(400).json({ success: false, message: 'No Cloud API account with credentials to send from.', code: 'NO_ACCOUNT' });
    }
    if (account.channelType === 'manual') {
      return res.status(400).json({
        success: false,
        message: 'Manual channels are used from your own WhatsApp app — open the chat there to reply.',
        code: 'MANUAL_CHANNEL',
      });
    }

    const category = billing.categoryFor({ isTemplate: false });
    const result = await wa.sendText(account, contact.phone, body);

    const stored = messages.create({
      userId: req.user._id, accountId: account._id, contactId: contact._id,
      phone: contact.phone, direction: 'out', type: 'text', body,
      wamid: result.ok ? result.wamid : null,
      status: result.ok ? 'sent' : 'failed',
      error: result.ok ? null : result.error,
      errorCode: result.ok ? null : result.code,
      billingCategory: category,
      isBillable: billing.isBillable(category),
    });

    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.error, code: result.code, messageRow: stored });
    }
    logAction(req, 'conversation.reply', { targetId: contact._id });
    res.status(201).json({ success: true, message: stored, window });
  } catch (err) {
    console.error('Reply error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send reply.' });
  }
});

module.exports = router;
