const config = require('../../config');

const categoryForEvent = (event = '') => /^EVENT_/.test(event) ? 'events' : 'membership';
const accountFor = (category = 'membership') => {
    const base = config.email;
    if (category === 'events') return base;
    const fromAddress = process.env.MEMBER_EMAIL_FROM || process.env.MEMBER_EMAIL_USER || 'member@activ.org.in';
    // Like events@, the member address uses the existing authenticated relay.
    // A separately hosted mailbox can opt into its own SMTP transport.
    const separate = process.env.MEMBER_EMAIL_TRANSPORT === 'separate';
    const user = separate ? process.env.MEMBER_EMAIL_USER || fromAddress : base.user;
    const password = separate ? process.env.MEMBER_EMAIL_PASS || '' : base.password;
    const host = separate ? process.env.MEMBER_EMAIL_HOST || base.host : base.host;
    const port = Number(separate ? process.env.MEMBER_EMAIL_PORT || base.port : base.port);
    return {
        ...base, host, port,
        secure: separate ? (process.env.MEMBER_EMAIL_SECURE ? process.env.MEMBER_EMAIL_SECURE === 'true' : port === 465) : base.secure,
        user, password, defaultFrom: fromAddress, from: `ACTIV Membership <${fromAddress}>`,
        fromName: 'ACTIV Membership', supportAddress: fromAddress, useRegionalFrom: false,
        isConfigured: !!(host && user && password),
    };
};

module.exports = { accountFor, categoryForEvent };
