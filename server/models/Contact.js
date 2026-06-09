const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 80 },
  phone: { type: String, required: [true, 'Phone is required'], trim: true },
  email: { type: String, trim: true, lowercase: true, default: '' },
  tags: { type: [String], default: [] },
  notes: { type: String, default: '', maxlength: 500 },
  // Optional link to which WhatsApp number owns this contact.
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppAccount', default: null },
  status: { type: String, enum: ['active', 'blocked', 'unsubscribed'], default: 'active' },
  lastContacted: { type: Date, default: null },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

// One ACTIVE contact phone per user — a deleted phone can be re-added later.
contactSchema.index(
  { userId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);
contactSchema.index({ userId: 1, isActive: 1 });

contactSchema.statics.countForUser = function (userId) {
  return this.countDocuments({ userId, isActive: true });
};

module.exports = mongoose.model('Contact', contactSchema);
