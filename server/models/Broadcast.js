const mongoose = require('mongoose');

const broadcastSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: [true, 'Broadcast name is required'], trim: true, maxlength: 100 },
  // Which WhatsApp number sends it.
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppAccount', default: null },
  templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', default: null },
  message: { type: String, default: '', maxlength: 1024 },
  audienceTag: { type: String, default: 'all' },        // which contact tag to target
  audienceCount: { type: Number, default: 0 },
  status: { type: String, enum: ['draft', 'scheduled', 'sending', 'sent', 'failed'], default: 'draft' },
  scheduledAt: { type: Date, default: null },
  sentCount: { type: Number, default: 0 },
  deliveredCount: { type: Number, default: 0 },
  readCount: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

broadcastSchema.index({ userId: 1, isActive: 1 });

broadcastSchema.statics.countForUser = function (userId) {
  return this.countDocuments({ userId, isActive: true });
};

module.exports = mongoose.model('Broadcast', broadcastSchema);
