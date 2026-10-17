const ApiError = require('../../core/utils/ApiError');
const CHANNELS = ['email', 'whatsapp', 'push'];
const none = () => ({ email: false, whatsapp: false, push: false });
const valid = value => !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === CHANNELS.length && CHANNELS.every(key => Object.hasOwn(value, key) && typeof value[key] === 'boolean');
function clean(value) {
    let input = value;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch {} }
    if (!valid(input)) throw ApiError.badRequest('Choose email, WhatsApp and push using a complete deliveryChannels object with three true/false values.');
    return Object.fromEntries(CHANNELS.map(key => [key, input[key]]));
}
function effective(update) {
    // Absence alone means a publication predating channel selection. Never add
    // resolved defaults into its content hash: existing jobs keep their key.
    if (update?.deliveryChannels === undefined) return { email: true, whatsapp: true, push: true };
    return valid(update.deliveryChannels) ? { ...update.deliveryChannels } : none();
}
const enabled = (update, channel) => CHANNELS.includes(channel) && effective(update)[channel] === true;
const disabledReason = channel => `${channel === 'whatsapp' ? 'WhatsApp' : channel === 'push' ? 'Push' : 'Email'} delivery was not selected for this update.`;
module.exports = { CHANNELS, none, valid, clean, effective, enabled, disabledReason };
