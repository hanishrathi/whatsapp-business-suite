const express = require('express');
const router = express.Router();
const insights = require('../services/insights');
const health = require('../data/healthSnapshots');
const waAccounts = require('../data/whatsappAccounts');
const { protect } = require('../middleware/auth');

/*
 * Insights — the account-health signals, each with a plain-English account of
 * what it is and what it does to the business. See services/insights.js.
 */

// GET /api/insights?days=30
router.get('/', protect, (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    res.json({ success: true, insights: insights.build(req.user._id, { days }) });
  } catch (err) {
    console.error('Insights error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to build insights.' });
  }
});

// GET /api/insights/history — quality and tier over time, for the trend chart
router.get('/history', protect, (req, res) => {
  try {
    const days = Math.min(180, Math.max(7, parseInt(req.query.days, 10) || 30));
    const accounts = waAccounts.listForUser(req.user._id);
    const byAccount = accounts
      .filter(a => a.canAutoSend)
      .map(a => ({
        accountId: a._id, name: a.name,
        history: health.historyForAccount(a._id, days),
        trend: health.qualityTrend(a._id),
      }));
    res.json({ success: true, days, accounts: byAccount });
  } catch (err) {
    console.error('Insights history error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load history.' });
  }
});

module.exports = router;
