const { onlineLinkKind } = require('./whatsappFlex');

// Message wording only: the event editor and stored field names stay unchanged.
const attendanceLink = (ctx = {}) => {
    const details = ctx.eventUrl || ctx.viewUrl || '';
    if (['waitlist', 'pending', 'cancelled'].includes(ctx.bookingStatus)) {
        return { label: 'Registration status', url: details };
    }
    if (ctx.isOnline) {
        const url = ctx.joinUrl || ctx.registerUrl;
        return url
            ? { label: onlineLinkKind(url) === 'register' ? 'Online registration link' : 'Online joining link', url }
            : { label: 'Online event details', url: details };
    }
    return ctx.mapUrl
        ? { label: 'Venue directions', url: ctx.mapUrl }
        : { label: 'Venue details', url: details };
};

module.exports = { attendanceLink };
