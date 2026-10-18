const Policy = require('./appUpdate.model');
const ApiError = require('../../core/utils/ApiError');
const PACKAGE_NAME = 'in.activ.membership';
const PLAY_URL = `https://play.google.com/store/apps/details?id=${PACKAGE_NAME}`;
const DEFAULT_MESSAGE = 'Please update ACTIV to continue.';

function project(row = {}) {
    return { enabled: row.enabled !== false, requireLatestAvailable: row.requireLatestAvailable !== false, minimumVersionCode: row.minimumVersionCode || 1,
        message: row.message || DEFAULT_MESSAGE, packageName: PACKAGE_NAME, playUrl: PLAY_URL, updatedAt: row.updatedAt || null };
}
function validate(payload = {}) {
    if (typeof payload.enabled !== 'boolean') throw ApiError.badRequest('Choose whether required updates are enabled.');
    if (typeof payload.requireLatestAvailable !== 'boolean') throw ApiError.badRequest('Choose whether every available Play update is required.');
    const code = payload.minimumVersionCode;
    if (!Number.isInteger(code) || code < 1 || code > 2100000000) throw ApiError.badRequest('Enter a positive Android version code.');
    if (payload.message !== undefined && typeof payload.message !== 'string') throw ApiError.badRequest('The update message must be text.');
    const message = (payload.message || '').trim() || DEFAULT_MESSAGE;
    if (message.length > 500) throw ApiError.badRequest('Keep the update message within 500 characters.');
    if (payload.enabled && payload.productionAvailableConfirmed !== true) {
        throw ApiError.badRequest('Confirm that this version is available in Google Play production before requiring it.');
    }
    return { enabled: payload.enabled, requireLatestAvailable: payload.requireLatestAvailable, minimumVersionCode: code, message };
}
async function read() {
    // Existing policy-aware app builds must also use automatic Play updates.
    // A retired admin switch or version threshold must not disable this path
    // or demand a release Play cannot offer to the current device/account.
    // This public read neither depends on nor changes the saved admin record.
    return project();
}
async function readSaved() {
    // Preserve the legacy admin API for clients that still show its controls.
    return project(await Policy.findById('android').lean() || {});
}
async function save(payload, actor = {}) {
    const data = validate(payload);
    const row = await Policy.findByIdAndUpdate('android', { $set: { ...data,
        productionAvailableConfirmedAt: data.enabled ? new Date() : null,
        updatedBy: String(actor.userId || actor.id || actor.email || ''),
    } }, { upsert: true, new: true, runValidators: true }).lean();
    await require('../audit/audit.service').record({ action: 'app_update_policy.saved', category: 'admin',
        summary: data.enabled ? data.requireLatestAvailable ? 'Every newer available Google Play release is required' : `Required Android updates enabled below version code ${data.minimumVersionCode}` : 'Required Android updates disabled',
        actorEmail: actor.email || '', actorRole: actor.role || '', targetId: 'android', targetLabel: 'Android update policy',
        metadata: { enabled: data.enabled, requireLatestAvailable: data.requireLatestAvailable, minimumVersionCode: data.minimumVersionCode } });
    return project(row);
}
module.exports = { read, readSaved, save, validate, project, PACKAGE_NAME, PLAY_URL };
