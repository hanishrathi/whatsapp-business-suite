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
 * Estimated WhatsApp spend for the current month.
 *
 * Service messages (free-form replies inside the 24h window) become billable
 * on 2026-10-01, so before that date this reports them at zero but still
 * counts them — which is what makes the change visible in advance.
 */
function spendFor(userId) {
  const counts = bmsgs.billingCountsForUser(userId);
  const estimate = billing.estimate(counts, { serviceAlreadySent: 0 });
  return {
    counts,
    ...estimate,
    serviceBillingActive: billing.serviceBillingActive(),
    daysUntilServiceBilling: billing.daysUntilServiceBilling(),
    serviceFreeAllowance: billing.SERVICE_FREE_ALLOWANCE,
  };
}

module.exports = router;
