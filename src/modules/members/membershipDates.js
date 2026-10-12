const IST_OFFSET = 330 * 60 * 1000;
const parts = value => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const local = new Date(date.getTime() + IST_OFFSET);
    return [local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()];
};
const indiaDayKey = value => {
    const day = parts(value);
    if (!day) return '';
    return `${day[0]}${String(day[1] + 1).padStart(2, '0')}${String(day[2]).padStart(2, '0')}`;
};
// Expiry is exclusive: membership bought on 12 Oct covers through 11 Oct next year.
const expiryBoundary = value => {
    const day = parts(value);
    return day ? new Date(Date.UTC(...day) - IST_OFFSET) : null;
};
const annualExpiry = value => {
    const day = parts(value);
    return day ? new Date(Date.UTC(day[0] + 1, day[1], day[2]) - IST_OFFSET) : null;
};
const lastValidDay = value => {
    const end = value && expiryBoundary(value);
    return end ? new Date(end.getTime() - 1) : null;
};
module.exports = { indiaDayKey, expiryBoundary, annualExpiry, lastValidDay };
