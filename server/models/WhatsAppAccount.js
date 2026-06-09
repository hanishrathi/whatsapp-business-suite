const mongoose = require('mongoose');

const whatsAppAccountSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: [true, 'Account name is required'],
    trim: true,
    maxlength: [60, 'Name cannot exceed 60 characters'],
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    trim: true,
  },
  countryCode: {
    type: String,
    required: true,
    default: '+91',
  },
  category: {
    type: String,
    enum: ['sales', 'support', 'notifications', 'commerce', 'hr', 'general'],
    default: 'general',
  },
  categoryLabel: {
    type: String,
    default: 'General',
  },

  // Color identification
  color: {
    type: String,
    required: true,
    default: '#25D366',
    validate: {
      validator: v => /^#([0-9A-Fa-f]{6})$/.test(v),
      message: 'Invalid hex color code',
    },
  },
  colorClass: {
    type: String,
    default: 'green',
  },

  // WhatsApp Business API credentials
  wabaId: {
    type: String,
    default: '',
    trim: true,
  },
  phoneNumberId: {
    type: String,
    default: '',
    trim: true,
  },
  accessToken: {
    type: String,
    default: '',
    select: false,
  },

  // Status
  status: {
    type: String,
    enum: ['online', 'offline', 'connecting', 'suspended'],
    default: 'connecting',
  },
  quality: {
    type: String,
    enum: ['high', 'medium', 'low'],
    default: 'high',
  },
  qualityLabel: {
    type: String,
    default: 'High',
  },

  // Metrics
  totalMessages: { type: Number, default: 0 },
  totalContacts: { type: Number, default: 0 },
  deliveryRate: { type: String, default: '0%' },
  messagesThisMonth: { type: Number, default: 0 },

  // Verification
  isVerified: { type: Boolean, default: false },
  verifiedAt: { type: Date },

  // Soft delete
  isActive: { type: Boolean, default: true },

}, {
  timestamps: true,
});

// Compound index: user + phone unique — only among ACTIVE accounts, so a
// disconnected number can be re-added later.
whatsAppAccountSchema.index(
  { userId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);
whatsAppAccountSchema.index({ userId: 1, isActive: 1 });

// Static: count active accounts for a user
whatsAppAccountSchema.statics.countActiveForUser = function (userId) {
  return this.countDocuments({ userId, isActive: true });
};

module.exports = mongoose.model('WhatsAppAccount', whatsAppAccountSchema);
