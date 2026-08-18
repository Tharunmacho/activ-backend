const mongoose = require('mongoose');
const config = require('../../config');

// Create separate connection for adminsdb
const adminsDbConnection = mongoose.createConnection(
    config.mongodb.uri.replace('/activ-db', '/adminsdb'), {
        useNewUrlParser: true,
        useUnifiedTopology: true
    }
);

// BlockAdmin Schema
const blockAdminSchema = new mongoose.Schema({
    adminId: {
        type: String,
        required: true,
        unique: true,
        match: /^BA\d{4}$/,
        index: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    passwordHash: {
        type: String,
        required: true,
        select: false
    },
    fullName: {
        type: String,
        required: true,
        trim: true
    },
    phoneNumber: {
        type: String,
        trim: true
    },
    role: {
        type: String,
        default: 'block_admin'
    },
    state: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    district: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    block: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    active: {
        type: Boolean,
        default: true,
        index: true
    },
    lastLoginAt: {
        type: Date
    }
}, {
    collection: 'blockadmins',
    timestamps: true
});

// Indexes
blockAdminSchema.index({ state: 1, district: 1, block: 1 });
blockAdminSchema.index({ active: 1, block: 1 });

module.exports = adminsDbConnection.model('BlockAdmin', blockAdminSchema);