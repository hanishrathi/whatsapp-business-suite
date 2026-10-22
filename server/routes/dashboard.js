const express = require('express');
const router = express.Router();
const bmsgs = require('../data/broadcastMessages');
const contacts = require('../data/contacts');
const waAccounts = require('../data/whatsappAccounts');
const broadcasts = require('../data/broadcasts');
const billing = require('../utils/billing');
const { protect } = require('../middleware/auth');

// GET /api/dashboard/stats — everything the dashboard shows, from real data.
router.get('/stats', protect, (req, res) => {
  try {
    const userId = req.user._id;
    const stats = bmsgs.statsForUser(userId);
    res.json({
      success: true,
      stats: {
        ...stats,
        totalContacts: contacts.countForUser(userId),
        totalBroadcasts: broadcasts.countForUser(userId),
        accountsConnected: waAccounts.countActiveForUser(userId),
        // Real figures replacing the old placeholder tiles.
        templatePerformance: bmsgs.templatePerformanceForUser(userId),
        consent: bmsgs.consentStatsForUser(userId),
        spend: spendFor(userId),
      },
    });
  } catch (err) {
    console.error('Dashboard stats error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load stats.' });
  }
});

/*
 * Estimated WhatsApp spend for the current month, on DELIVERED messages only
 * (Meta does not charge for messages merely sent). Free-form service replies
 * became billable on 2026-10-01 after each business phone number's first
 * 1,000 a month, so the allowance is applied per number.
 *
 * `unconfirmed` counts messages Meta has accepted but not yet reported as
 * delivered. They are left out of the estimate; if it never goes down, the
 * delivery webhook is not set up and the estimate will read low.
 */
function spendFor(userId) {
  const counts = bmsgs.billingCountsForUser(userId);
  const estimate = billing.estimate(counts, {
    serviceByAccount: bmsgs.serviceCountsByAccountForUser(userId),
  });
  return {
    counts,
    ...estimate,
    unconfirmed: bmsgs.unconfirmedCountForUser(userId),
    serviceBillingActive: billing.serviceBillingActive(),
    daysUntilServiceBilling: billing.daysUntilServiceBilling(),
    serviceFreeAllowance: billing.SERVICE_FREE_ALLOWANCE,
  };
}

module.exports = router;
