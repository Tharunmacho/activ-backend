const mongoose = require('mongoose');

// MemberDeclaration Schema — collection 'additional form for declaration 4'.
//
// That collection carries a UNIQUE index on `userId`, and 16 of its 17 rows key
// off `userId`. The schema previously declared only `memberId`, so every
// document this model wrote left `userId` null — and because a unique index
// permits exactly one null, the second write ever attempted failed with E11000.
// Both fields are now declared and populated: `userId` satisfies the real index,
// `memberId` keeps existing lookups in member.controller.js working.
const memberDeclarationSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MemberAuth',
        required: true,
        unique: true
    },
    memberId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MemberDetails',
        required: true,
        index: true
    },
    sisterConcerns: {
        type: Number,
        default: 0,
        min: 0
    },
    companyNames: [{
        type: String,
        trim: true
    }],
    agreeToDeclaration: {
        type: Boolean,
        required: true,
        default: false
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
        index: true
    },
    reviewNotes: {
        type: String,
        trim: true
    },
    reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        refPath: 'reviewerModel'
    },
    reviewerModel: {
        type: String,
        enum: ['BlockAdmin', 'DistrictAdmin', 'StateAdmin']
    },
    reviewedAt: {
        type: Date
    }
}, {
    collection: 'additional form for declaration 4',
    timestamps: true
});

module.exports = mongoose.model('MemberDeclaration', memberDeclarationSchema);