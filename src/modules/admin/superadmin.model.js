const mongoose = require('mongoose');
const { getConnection } = require('./adminsDb');

// One shared connection to the legacy adminsdb, opened in ./adminsDb.
// Creating it per model opened four sockets to the same database.
// Falls back to the default (main-database) connection when adminsdb cannot be
// opened, so requiring a model can never throw and take the API down at boot.
const adminsDbConnection = getConnection() || mongoose;

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
    profilePhoto: {
        type: String,
        default: ''
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