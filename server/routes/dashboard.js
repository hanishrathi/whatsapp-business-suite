const express = require('express');
const router = express.Router();
const bmsgs = require('../data/broadcastMessages');
const contacts = require('../data/contacts');
const waAccounts = require('../data/whatsappAccounts');
const broadcasts = require('../data/broadcasts');
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
      },
    });
  } catch (err) {
    console.error('Dashboard stats error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load stats.' });
  }
});

module.exports = router;
