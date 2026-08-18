const mongoose = require('mongoose');
const config = require('../../config');

// Create separate connection for adminsdb
const adminsDbConnection = mongoose.createConnection(
    config.mongodb.uri.replace('/activ-db', '/adminsdb'), {
        useNewUrlParser: true,
        useUnifiedTopology: true
    }
);

// StateAdmin Schema
const stateAdminSchema = new mongoose.Schema({
    adminId: {
        type: String,
        required: true,
        unique: true,
        match: /^SA\d{4}$/,
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
        default: 'state_admin'
    },
    state: {
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
    collection: 'stateadmins',
    timestamps: true
});

// Indexes
stateAdminSchema.index({ state: 1, active: 1 });

module.exports = adminsDbConnection.model('StateAdmin', stateAdminSchema);