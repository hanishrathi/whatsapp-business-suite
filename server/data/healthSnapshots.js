const { getDb, newId } = require('../config/database');
const { now } = require('./_map');

/*
 * Daily record of the account state Meta controls.
 *
 * Quality rating, messaging tier and ban state live on Meta's side and are
 * simply overwritten in our row whenever they change — so without this table
 * there is no way to answer "was our quality already falling before the
 * campaign?" One row per account per day; later writes in the same day
 * overwrite it, so the row holds that day's latest known state.
 */

function today() {
  return new Date().toISOString().slice(0, 10);
}

function record(account, source = 'poll') {
  if (!account || !account._id) return null;
  const db = getDb();
  const day = today();
  // Upsert: the newest reading wins for the day.
  db.prepare(`INSERT INTO account_health_snapshots (id,userId,accountId,day,quality,messagingLimit,banState,source,createdAt)
              VALUES (?,?,?,?,?,?,?,?,?)
              ON CONFLICT(accountId, day) DO UPDATE SET
                quality = excluded.quality,
                messagingLimit = excluded.messagingLimit,
                banState = excluded.banState,
                source = excluded.source`)
    .run(newId(), account.userId, account._id, day,
         account.quality || '', account.messagingLimit == null ? null : account.messagingLimit,
         account.banState || '', source, now());
  return day;
}

// Chronological history for one account, oldest first.
function historyForAccount(accountId, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return getDb().prepare(
    `SELECT day, quality, messagingLimit, banState FROM account_health_snapshots
      WHERE accountId = ? AND day >= ? ORDER BY day`).all(accountId, since);
}

/*
 * Did quality get worse over the window? Returns the direction so the UI can
 * say "falling" rather than only showing today's colour — a green rating that
 * was green last week means something different from one that just recovered.
 */
const RANK = { high: 3, medium: 2, low: 1 };
function qualityTrend(accountId, days = 14) {
  const rows = historyForAccount(accountId, days).filter(r => r.quality);
  if (rows.length < 2) return { direction: 'flat', from: null, to: null, points: rows.length };
  const first = RANK[rows[0].quality] || 0;
  const last = RANK[rows[rows.length - 1].quality] || 0;
  return {
    direction: last < first ? 'falling' : last > first ? 'rising' : 'flat',
    from: rows[0].quality, to: rows[rows.length - 1].quality, points: rows.length,
  };
}

function historyForUser(userId, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return getDb().prepare(
    `SELECT accountId, day, quality, messagingLimit, banState FROM account_health_snapshots
      WHERE userId = ? AND day >= ? ORDER BY day`).all(userId, since);
}

module.exports = { record, historyForAccount, historyForUser, qualityTrend, today };
