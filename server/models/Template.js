const mongoose = require('mongoose');

const templateSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: [true, 'Template name is required'], trim: true, maxlength: 80 },
  category: { type: String, enum: ['marketing', 'utility', 'authentication'], default: 'marketing' },
  language: { type: String, default: 'en' },
  body: { type: String, required: [true, 'Template body is required'], maxlength: 1024 },
  // WhatsApp template approval status.
  status: { type: String, enum: ['draft', 'pending', 'approved', 'rejected'], default: 'draft' },
  // Number of {{n}} variables detected in the body.
  variableCount: { type: Number, default: 0 },
  timesUsed: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

templateSchema.index({ userId: 1, isActive: 1 });

// Auto-count {{1}} {{2}} ... placeholders from the body before saving.
templateSchema.pre('save', function (next) {
  const matches = (this.body || '').match(/\{\{\s*\d+\s*\}\}/g);
  this.variableCount = matches ? new Set(matches).size : 0;
  next();
});

templateSchema.statics.countForUser = function (userId) {
  return this.countDocuments({ userId, isActive: true });
};

module.exports = mongoose.model('Template', templateSchema);
