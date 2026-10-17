const { randomUUID } = require('node:crypto');
const Log = require('./notificationLog.model');
const policy = require('./deliveryRetryPolicy');

// Shared by report actions, the existing Resend button, and automatic retries.
// The durable claim has no timeout: a crashed sender may already have delivered.
async function run(logId, options, send) {
    const row = await Log.findById(logId);
    if (!row) return null;
    const reason = policy.basicLogReason(row) || (options.strict ? await policy.logReason(row) : '');
    if (reason) return { row, skipped: true, reason };
    // Association updates already claim their exact notification/channel/log
    // tuple, and check publication, consent, and recipient again before sending.
    if (row.event === 'ASSOCIATION_UPDATE') return send();
    const token = randomUUID();
    const initialAttempts = Number(row.attempts || 1);
    const claim = await Log.updateOne({ _id: row._id, 'retryClaim.token': { $exists: false },
        ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
        resentAs: { $exists: false }, mock: { $ne: true }, deliveredAt: null, readAt: null,
        $or: [{ deliveryStatus: 'failed' }, { deliveryStatus: { $exists: false }, status: 'failed' }],
    }, { $set: { retryClaim: { token, at: new Date() } } });
    if (!claim.matchedCount) return { row, skipped: true, reason: 'This delivery changed or another retry already claimed it.' };
    const owner = { _id: row._id, 'retryClaim.token': token };
    try {
        const current = await Log.findById(logId);
        const plain = current.toObject ? current.toObject() : { ...current };
        delete plain.retryClaim;
        const changed = policy.basicLogReason(plain) || (options.strict ? await policy.logReason(plain) : '');
        if (changed) {
            await Log.updateOne(owner, { $unset: { retryClaim: 1 } });
            return { row: current, skipped: true, reason: changed };
        }
        const result = await send();
        if (result?.skipped || result?.waiting) {
            await Log.updateOne(owner, { $unset: { retryClaim: 1 } });
            return result;
        }
        const stored = await Log.findById(logId);
        // Existing specialized senders create a replacement log; the original
        // must durably link to it before the claim can be released.
        const recorded = stored?.resentAs || Number(stored?.attempts || 1) > initialAttempts;
        const unknown = !recorded || result?.outcome?.outcomeUnknown
            || (!result?.outcome?.success && policy.uncertain(result?.outcome?.error));
        if (unknown) {
            await Log.updateOne(owner, { $set: { 'data.outcomeUnknown': true, 'data.autoRetryDisabled': true } });
            return { ...result, outcome: { ...result?.outcome, outcomeUnknown: true },
                reason: 'The retry outcome needs review; it will not be sent again automatically.' };
        }
        await Log.updateOne(owner, { $unset: { retryClaim: 1 } });
        return result;
    } catch (error) {
        await Log.updateOne(owner, { $set: { 'data.outcomeUnknown': true, 'data.autoRetryDisabled': true } }).catch(() => null);
        return { row, outcome: { success: false, outcomeUnknown: true, error: 'The retry outcome could not be confirmed. Review delivery history before sending again.' } };
    }
}
module.exports = { run };
