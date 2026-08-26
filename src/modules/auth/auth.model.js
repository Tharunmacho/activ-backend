const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// MemberAuth Schema - matches memberauths collection
const memberAuthSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        index: true
    },
    password: {
        type: String,
        required: true,
        select: false
    },
    isActive: {
        type: Boolean,
        default: true
    },
    lastLogin: {
        type: Date
    },
    /**
     * Password reset, stored as a SHA-256 hash of the token that was emailed.
     *
     * Hashed rather than raw for the same reason the password is: a stolen
     * database dump must not hand over working reset links. `select:false`
     * keeps both fields out of every ordinary read, so a profile response can
     * never leak a live reset token.
     */
    resetPasswordToken: {
        type: String,
        select: false,
        index: true
    },
    resetPasswordExpires: {
        type: Date,
        select: false
    }
}, {
    collection: 'auth',
    timestamps: true,
    toJSON: {
        transform: (doc, ret) => {
            delete ret.password;
            delete ret.__v;
            return ret;
        }
    }
});

// Hash password before saving
memberAuthSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();

    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (error) {
        next(error);
    }
});

// Compare password method
memberAuthSchema.methods.comparePassword = async function(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

// Update last login
memberAuthSchema.methods.updateLastLogin = async function() {
    this.lastLogin = new Date();
    await this.save();
};

const MemberAuth = mongoose.model('MemberAuth', memberAuthSchema);

module.exports = MemberAuth;