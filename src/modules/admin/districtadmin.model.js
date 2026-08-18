const mongoose = require('mongoose');
const config = require('../../config');

// Create separate connection for adminsdb
const adminsDbConnection = mongoose.createConnection(
    config.mongodb.uri.replace('/activ-db', '/adminsdb'), {
        useNewUrlParser: true,
        useUnifiedTopology: true
    }
);

// DistrictAdmin Schema
const districtAdminSchema = new mongoose.Schema({
    adminId: {
        type: String,
        required: true,
        unique: true,
        match: /^DA\d{4}$/,
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
        default: 'district_admin'
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
    active: {
        type: Boolean,
        default: true,
        index: true
    },
    lastLoginAt: {
        type: Date
    }
}, {
    collection: 'districtadmins',
    timestamps: true
});

// Indexes
districtAdminSchema.index({ state: 1, district: 1 });
districtAdminSchema.index({ active: 1, district: 1 });

module.exports = adminsDbConnection.model('DistrictAdmin', districtAdminSchema);