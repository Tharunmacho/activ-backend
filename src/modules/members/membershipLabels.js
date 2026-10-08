const LIFETIME_MEMBERSHIP = 'Lifetime Membership';

/** Keep stored plan keys stable; render historic receipts and current plans with the public name. */
function displayPlanName(name, ...identities) {
    const value = String(name || '').trim();
    if (identities.some(key => String(key || '').trim().toLowerCase() === 'platinum')
        || /^platinum\b/i.test(value) || /^lifetime membership(?: plan)?$/i.test(value)) {
        return LIFETIME_MEMBERSHIP;
    }
    return value;
}

module.exports = { LIFETIME_MEMBERSHIP, displayPlanName };
