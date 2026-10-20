const DEFAULT_EMAIL_MAX_AGE_MINUTES = 60;

function emailMaxAgeMinutes() {
    const value = Number(process.env.ASSOCIATION_UPDATE_EMAIL_MAX_AGE_MINUTES);
    return Number.isInteger(value) && value >= 1 && value <= 1440 ? value : DEFAULT_EMAIL_MAX_AGE_MINUTES;
}

// A newly generated recipient row must not restart an old publication's clock.
// Snapshots survive broadcast-job retention; legacy rows resolve the original
// job while it is available, falling back only when that job no longer exists.
async function emailFreshness(row) {
    let original;
    if (Object.prototype.hasOwnProperty.call(row.data || {}, 'broadcastCreatedAt')) {
        original = row.data.broadcastCreatedAt;
    } else {
        const job = row.data?.broadcastKey
            ? await require('./broadcast.model').findOne({ key: row.data.broadcastKey }).select('createdAt').lean() : null;
        original = job ? job.createdAt : row.createdAt;
    }
    const timestamp = original ? new Date(original).getTime() : NaN;
    const now = Date.now();
    if (!Number.isFinite(timestamp) || timestamp > now) {
        return { reason: 'The original publication time for this update email could not be verified.' };
    }
    const broadcastCreatedAt = new Date(timestamp);
    const maxAge = emailMaxAgeMinutes();
    return { broadcastCreatedAt, reason: now - timestamp >= maxAge * 60000
        ? `This update email has expired: its ${maxAge}-minute window since original publication has elapsed.` : '' };
}

module.exports = { emailMaxAgeMinutes, emailFreshness };
