const Application = require('../applications/application.model');
const ApiError = require('../../core/utils/ApiError');
const { normalizeStatus } = require('../common/applicationStatus');
const { membershipState } = require('./membershipState');

const ownerIds = member => [...new Set([member._id, member.userId].filter(Boolean).map(String))];
const existingMembership = member => ['active', 'expired'].includes(membershipState(member).state);

// Existing memberships may renew or upgrade without submitting a new application.
// Initial admission always checks the actual owned submission before any receipt,
// profile write, approval or access grant. Client acknowledgement cannot replace it.
async function validateInitialMembership(member, { applicationId, requireApproved = false } = {}) {
    if (existingMembership(member)) return null;
    const owners = ownerIds(member);
    let application;
    if (applicationId) application = await Application.findById(applicationId);
    else {
        const rows = await Application.find({ userId: { $in: owners } }).sort({ updatedAt: -1 });
        application = rows.find(row => normalizeStatus(row.status) === 'Approved') || rows[0];
    }
    const owner = application?.userId?._id || application?.userId;
    if (!application || !owners.includes(String(owner || ''))) {
        throw ApiError.badRequest('The member must complete all required forms and submit their application first.');
    }
    const status = normalizeStatus(application.status);
    if (!['Pending', 'Approved'].includes(status) || (requireApproved && status !== 'Approved')) {
        throw ApiError.badRequest(requireApproved ? 'Approve the completed application before granting Lifetime membership.' : 'Review the completed application before confirming membership.');
    }
    await require('../applications/application.service').completeApplicationPersonal(application);
    return application;
}

module.exports = { ownerIds, existingMembership, validateInitialMembership };
