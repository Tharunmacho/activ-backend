const mongoose = require('mongoose');
const Application = require('./application.model');
const { normalizeStatus } = require('../common/applicationStatus');
const { currentApplications, ownerOf, legacyIds } = require('./applicationIdentity');
const ApiError = require('../../core/utils/ApiError');

// No expiring lease: every worker receives the same durable application ID.
// Mongo's built-in unique _id is the only required index, including when
// autoIndex is disabled. Existing applications need no migration/deletion.
const schema = new mongoose.Schema({ _id: String, applicationId: { type: mongoose.Schema.Types.ObjectId, required: true } }, { versionKey: false });
const Claim = require('../../config/dataLayout').model('ApplicationSubmissionClaim', schema);
const approvedError = () => ApiError.conflict('Your application is already approved. Update your profile from your dashboard.');

async function reserveApplicationId(ownerId, ownerIds = [ownerId]) {
    const key = String(ownerId);
    const ownerMap = new Map(ownerIds.map(id => [String(id), key]));
    for (let attempt = 0; attempt < 5; attempt++) {
        const applications = await Application.find({ $or: [{ userId: { $in: ownerIds } }, { userId: null, user: { $in: legacyIds(ownerIds) } }] })
            .select('_id userId user status createdAt').lean();
        if (applications.some(row => normalizeStatus(row.status) === 'Approved')) throw approvedError();
        const pending = currentApplications(applications, { ownerMap }).find(row => normalizeStatus(row.status) === 'Pending');
        let claim;
        try {
            claim = await Claim.findOneAndUpdate({ _id: key }, { $setOnInsert: { applicationId: pending?._id || new mongoose.Types.ObjectId() } }, { upsert: true, new: true });
        } catch (error) {
            if (error.code !== 11000) throw error;
            claim = await Claim.findById(key);
        }
        if (!claim) continue;
        const reserved = await Application.findById(claim.applicationId).select('_id userId user status').lean();
        if (!reserved) return claim.applicationId; // A crashed creator can resume this exact ID.
        if (!ownerIds.map(String).includes(ownerOf(reserved))) {
            throw ApiError.conflict('This application reservation does not belong to the member. Contact support.');
        }
        if (normalizeStatus(reserved.status) === 'Approved') throw approvedError();
        if (normalizeStatus(reserved.status) === 'Pending') return claim.applicationId;
        // A rejected generation is immutable history. CAS rotates once; a
        // delayed old worker still holds its old ID and cannot overwrite it.
        const nextId = pending?._id || new mongoose.Types.ObjectId();
        const changed = await Claim.updateOne({ _id: key, applicationId: claim.applicationId }, { $set: { applicationId: nextId } });
        if (changed.modifiedCount) return nextId;
    }
    throw ApiError.conflict('Your application changed during submission. Refresh its status before trying again.');
}

async function insertReservedApplication(application) {
    // Document validation runs the schema's legacy normalization hook and all
    // required/default logic. Native $setOnInsert avoids touching an existing
    // winner's fields, review state, or updatedAt on an idempotent retry.
    await application.validate();
    const snapshot = application.toObject({ depopulate: true });
    const now = new Date();
    snapshot.createdAt = snapshot.createdAt || now;
    snapshot.updatedAt = snapshot.updatedAt || now;
    snapshot.__v = snapshot.__v || 0;
    let inserted = false;
    try {
        const result = await Application.collection.updateOne({ _id: application._id }, { $setOnInsert: snapshot }, { upsert: true });
        inserted = result.upsertedCount === 1;
    } catch (error) { if (error.code !== 11000) throw error; }
    return { application: await Application.findById(application._id), inserted };
}

module.exports = { Claim, reserveApplicationId, insertReservedApplication };
