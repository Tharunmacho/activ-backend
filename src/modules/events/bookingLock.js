const crypto = require('node:crypto');
const mongoose = require('mongoose');
const ApiError = require('../../core/utils/ApiError');

// Serialize attendee checks and seat allocation across API replicas. Leases
// recover from a crashed process; no payment/provider call runs under this lock.
const schema = new mongoose.Schema({ _id: String, owner: String, expiresAt: Date }, { versionKey: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const Lock = require('../../config/dataLayout').model('EventBookingLock', schema);
async function withBookingLock(eventId, work) {
    const id = String(eventId), owner = crypto.randomUUID();
    let acquired = false;
    for (let attempt = 0; attempt < 40 && !acquired; attempt++) {
        try {
            const row = await Lock.findOneAndUpdate({ _id: id, expiresAt: { $lte: new Date() } },
                { $set: { owner, expiresAt: new Date(Date.now() + 120000) } }, { upsert: true, new: true });
            acquired = row?.owner === owner;
        } catch (error) { if (error.code !== 11000) throw error; }
        if (!acquired) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!acquired) throw ApiError.conflict('Another booking is being saved. Please try again in a moment.');
    try { return await work(); }
    finally { await Lock.deleteOne({ _id: id, owner }); }
}
module.exports = { withBookingLock, Lock };
