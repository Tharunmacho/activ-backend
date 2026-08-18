const mongoose = require('mongoose');

// Connections Schema
const connectionSchema = new mongoose.Schema({
    senderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MemberAuth',
        required: true,
        index: true
    },
    recipientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MemberAuth',
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: ['pending', 'accepted', 'rejected', 'blocked'],
        default: 'pending',
        index: true
    },
    message: {
        type: String,
        trim: true
    },
    acceptedAt: {
        type: Date
    },
    rejectedAt: {
        type: Date
    }
}, {
    collection: 'connections',
    timestamps: true
});

// Compound indexes
connectionSchema.index({ senderId: 1, recipientId: 1 }, { unique: true });
connectionSchema.index({ recipientId: 1, status: 1 });
connectionSchema.index({ senderId: 1, status: 1 });

module.exports = mongoose.model('Connection', connectionSchema);