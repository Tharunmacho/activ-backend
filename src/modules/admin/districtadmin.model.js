const mongoose = require('mongoose');
const { getConnection } = require('./adminsDb');

// One shared connection to the legacy adminsdb, opened in ./adminsDb.
// Creating it per model opened four sockets to the same database.
// Falls back to the default (main-database) connection when adminsdb cannot be
// opened, so requiring a model can never throw and take the API down at boot.
const adminsDbConnection = getConnection() || mongoose;

// DistrictAdmin Schema
const districtAdminSchema = new mongoose.Schema({
    adminId: {
        type: String,
        required: true,
        unique: true,
        // Length is deliberately not pinned. Live data carries both the
        // short `DA0001` form and the seeded `DA01001001` form, and a
        // stricter pattern made every existing document unsaveable.
        match: /^DA[A-Z0-9]+$/,
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
        // Never returned by a normal query — only the login path asks for it.
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
        // Not `required`: seeded documents keep the value under `meta`,
        // and rejecting those would make them impossible to read back
        // and repair. The service layer validates before writing.
        trim: true,
        index: true
    },
    district: {
        type: String,
        // Not `required`: seeded documents keep the value under `meta`,
        // and rejecting those would make them impossible to read back
        // and repair. The service layer validates before writing.
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
    },
    /**
     * How this account came to exist: 'super_admin_ui', 'bulk_csv',
     * 'tn_pilot_seed' or 'migrated_from_admins'.
     *
     * Also the marker that separates real staffing from the legacy scaffold
     * seed, which carries no `createdVia`. See `admin.repository.js`.
     */
    createdVia: {
        type: String,
        trim: true,
        index: true
    },
    /** Informational lineage only — no hierarchy is enforced on writes. */
    parentAdminId: {
        type: String,
        trim: true
    },
    mustResetPassword: {
        type: Boolean,
        default: false
    },
    /** Legacy seeded documents keep their region under here. */
    meta: {
        type: mongoose.Schema.Types.Mixed
    }
}, {
    collection: 'districtadmins',
    timestamps: true
});

// Indexes
districtAdminSchema.index({ state: 1, district: 1 });
districtAdminSchema.index({ active: 1, district: 1 });

module.exports = adminsDbConnection.model('DistrictAdmin', districtAdminSchema);