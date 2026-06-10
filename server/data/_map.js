/*
 * Shared helpers to convert between SQLite rows (ints/text) and JS objects
 * (booleans, Date objects, parsed JSON) so the rest of the app sees the same
 * shapes it did with Mongoose.
 */

function toBool(v) { return v === 1 || v === true; }
function fromBool(v) { return v ? 1 : 0; }
function toDate(v) { return v == null ? null : new Date(v); }
function fromDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const d = new Date(v);
  return isNaN(d) ? null : d.getTime();
}
function toJson(v, fallback) { try { return v == null ? fallback : JSON.parse(v); } catch { return fallback; } }
function fromJson(v) { return JSON.stringify(v == null ? null : v); }

const now = () => Date.now();

// Build an UPDATE statement for a subset of columns. Returns { sql, values }.
function buildUpdate(table, id, fields) {
  const cols = Object.keys(fields);
  const set = cols.map(c => `${c} = ?`).join(', ');
  const values = cols.map(c => fields[c]);
  return {
    sql: `UPDATE ${table} SET ${set}, updatedAt = ? WHERE id = ?`,
    values: [...values, now(), id],
  };
}

module.exports = { toBool, fromBool, toDate, fromDate, toJson, fromJson, now, buildUpdate };
