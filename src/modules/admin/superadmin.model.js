const mongoose = require('mongoose');
const dataLayout = require('../../config/dataLayout');
// Stored in activ_admins — see config/dataLayout.js.

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
    timestamps: true
});

module.exports = dataLayout.model('SuperAdmin', superAdminSchema);