const mongoose = require('mongoose');

// Additional Form for Personal Information 1 Schema
const personalInfo1Schema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    phoneNumber: {
        type: String,
        required: true,
        trim: true
    },
    state: {
        type: String,
        required: true,
        trim: true
    },
    district: {
        type: String,
        required: true,
        trim: true
    },
    block: {
        type: String,
        required: true,
        trim: true
    },
    city: {
        type: String,
        trim: true
    },
    religion: {
        type: String,
        trim: true
    },
    socialCategory: {
        type: String,
        enum: ['Christian ST', 'Christian SC', 'ST', 'SC', 'Others', ''],
        trim: true,
        default: ''
    },
    isLocked: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true,
    collection: 'additional form for personal information 1'
});

// Index for faster queries
personalInfo1Schema.index({ userId: 1 });

// Prevent model recompilation in development
module.exports = mongoose.models.PersonalInfo1 || mongoose.model('PersonalInfo1', personalInfo1Schema);
