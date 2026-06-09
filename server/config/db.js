const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 10,
    });
    console.log(`MongoDB connected: ${conn.connection.host}`);

    // Reconcile indexes with the schema (drops stale ones, builds new partial
    // unique indexes). Best-effort — never crash the app over an index sync.
    syncIndexes();
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  }
};

async function syncIndexes() {
  // Require the model files so they're registered regardless of load order.
  const files = ['User', 'WhatsAppAccount', 'Contact', 'Template', 'Broadcast', 'AuditLog'];
  for (const name of files) {
    try {
      const Model = require(`../models/${name}`);
      await Model.syncIndexes();
    } catch (err) {
      console.error(`Index sync skipped for ${name}:`, err.message);
    }
  }
}

module.exports = connectDB;
