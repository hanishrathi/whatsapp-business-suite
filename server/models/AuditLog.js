const mongoose = require('mongoose');

/*
 * Append-only audit trail for sensitive actions.
 * Records WHO did WHAT, WHEN, from WHERE — for forensics and compliance.
 */
const auditLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  actorEmail: { type: String },
  action: { type: String, required: true, index: true },
  targetId: { type: mongoose.Schema.Types.ObjectId },
  ip: { type: String },
  userAgent: { type: String },
  meta: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, index: true },
});

// Records should never be modified after creation.
auditLogSchema.pre('findOneAndUpdate', function () {
  throw new Error('Audit logs are append-only and cannot be modified.');
});
auditLogSchema.pre('updateOne', function () {
  throw new Error('Audit logs are append-only and cannot be modified.');
});

module.exports = mongoose.model('AuditLog', auditLogSchema);
