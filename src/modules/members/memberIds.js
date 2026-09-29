const { membershipNumberFor, applicationRefFor } = require('./memberNumber');

/**
 * The two ids a member quotes — exactly as the website prints them.
 *
 * The activation email derived the Member ID on its own (`_id.slice(-8)`), so
 * the email and the dashboard showed two different Member IDs for one member.
 * Both now come from `memberNumber.js`, the dashboard's source. The application
 * reference is the member's latest application (`ACTIV-APP-YYYY-XXXXXX`).
 * Never throws: an email is never held up by a lookup.
 */
const idsFor = async (member = {}) => {
    const memberId = member && member._id ? membershipNumberFor(member) : '';
    let applicationRef = '';
    try {
        const Application = require('../applications/application.model');
        const app = await Application.findOne({ $or: [{ userId: member._id }, { email: member.email }] })
            .sort({ updatedAt: -1 }).lean();
        if (app) applicationRef = applicationRefFor(app);
    } catch { /* optional */ }
    return { memberId, applicationRef };
};

module.exports = { idsFor };
