const mongoose = require('mongoose');
const dataLayout = require('../../config/dataLayout');
const bcrypt = require('../common/passwordHash');

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
        required: function() { return this.passwordLoginEnabled !== false; },
        select: false
    },
    // Missing on legacy rows. False is explicit social-only registration; a
    // real password save promotes it to true without changing provider links.
    passwordLoginEnabled: { type: Boolean },
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
    timestamps: true,
    toJSON: {
        transform: (doc, ret) => {
            delete ret.password;
            delete ret.resetPasswordToken;
            delete ret.resetPasswordExpires;
            delete ret.__v;
            return ret;
        }
    }
});

// Hash password before saving
memberAuthSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    if (!this.password && this.passwordLoginEnabled === false) return next();

    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        this.passwordLoginEnabled = true;
        next();
    } catch (error) {
        next(error);
    }
});

// Compare password method
memberAuthSchema.methods.comparePassword = async function(candidatePassword) {
    if (this.passwordLoginEnabled === false || typeof this.password !== 'string' || !this.password
        || typeof candidatePassword !== 'string' || !candidatePassword) return false;
    return await bcrypt.compare(candidatePassword, this.password).catch(() => false);
};

// Update last login
memberAuthSchema.methods.updateLastLogin = async function() {
    this.lastLogin = new Date();
    await this.save();
};

const MemberAuth = dataLayout.model('MemberAuth', memberAuthSchema);

module.exports = MemberAuth;
