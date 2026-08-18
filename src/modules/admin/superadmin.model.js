const mongoose = require('mongoose');
const config = require('../../config');

// Create separate connection for adminsdb
const adminsDbConnection = mongoose.createConnection(
    config.mongodb.uri.replace('/activ-db', '/adminsdb'), {
        useNewUrlParser: true,
        useUnifiedTopology: true
    }
);

// SuperAdmin Schema
const superAdminSchema = new mongoose.Schema({
    adminId: {
        type: String,
        required: true,
        unique: true,
        match: /^SUPER\d{3}$/,
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
        default: 'super_admin'
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
    collection: 'superadmins',
    timestamps: true
});

module.exports = adminsDbConnection.model('SuperAdmin', superAdminSchema);