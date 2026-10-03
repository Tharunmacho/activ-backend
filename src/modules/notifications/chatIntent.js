// Interpret ordinary sentences without letting a greeting hide the actual request.
// This selects a website journey; it never changes an application or a payment.
const normalize = text => String(text || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const parse = text => {
    const clean = normalize(text);
    if (!clean) return null;
    if (/\b(events?|bookings?|tickets?|programmes?|programs?|meetings?|conference)\b|நிகழ்ச்சி/.test(clean)) return 'EVENTS';
    if (/\b(forgot|forget|reset|lost|change)\b.*\b(password|pwd)\b|\b(password|pwd)\b.*\b(forgot|forget|reset|lost)\b/.test(clean)) return 'RESET';
    if (/\b(login|log in|sign in|signin|google|otp)\b/.test(clean)) return 'LOGIN';
    if (/\b(human|person|officer|admin|support|contact|complaint|helpline|help)\b|உதவி/.test(clean)) return 'HELP';
    if (/\b(not paid|haven t paid|have not paid|unpaid|payment failed|failed payment|money deducted|refund|charged twice|debited)\b/.test(clean)) return 'PAYMENT_ISSUE';
    if (/\b(already paid|i paid|have paid|payment done|payment completed|payment successful|utr|transaction reference)\b/.test(clean) || clean === 'paid') return 'PAID';
    if (/\b(fees?|cost|price|pricing|how much|plans?|tiers?)\b/.test(clean)) return 'FEES';
    if (/\b(benefits?|entitlements?|advantages?)\b/.test(clean)) return 'BENEFITS';
    if (/\b(renew|renewal|expiry|expires?|expired|validity)\b/.test(clean)) return 'RENEW';
    if (/\b(upi|direct payment|bank transfer)\b/.test(clean)) return 'UPI';
    if (/\b(pay|payment)\b|பணம்/.test(clean)) return 'PAYMENT';
    if (/\b(card|certificate|receipt|invoice)\b/.test(clean)) return 'CARD';
    if (/\b(profile|phone number|whatsapp number|change email|update email|edit details|address change)\b/.test(clean)) return 'PROFILE';
    if (/\b(forms?|personal details|business details|student details|aspirant details|declaration|documents?|upload|fill|submit|submission)\b/.test(clean)) return 'FORMS';
    if (/\b(register|registration|join|become a?\s*member|create account|new account)\b/.test(clean)) return 'REGISTER';
    if (/\b(status|application|membership|member|track|check|review|verify|verification|approved|approval|rejected|pending)\b|உறுப்பினர்/.test(clean)) return 'STATUS';
    if (/\b(about|what is activ|who are you|association|organisation|organization)\b/.test(clean)) return 'ABOUT';
    if (/^(hi|hello|hey|hai|hii+|good morning|good afternoon|good evening|vanakkam|வணக்கம்)(\s+(sir|madam|activ|team))?$/.test(clean)
        || /^(menu|start|options)$/.test(clean)) return 'MENU';
    if (/^(thank(s| you)?|thank you so much|thanks a lot|thx|ty|நன்றி)(\s+(sir|madam|team|ok))?$/.test(clean)) return 'THANKS';
    if (/^(ok(ay)?|yes|yeah|sure|fine|alright|understood|done)(\s+(sir|madam|ok|thanks|thank you))?$/.test(clean)) return 'ACK';
    if (/^(how are you|how r u|are you there|you there|good night|bye|goodbye)(\s+(sir|madam))?$/.test(clean)) return 'SOCIAL';
    if (/\b(what next|next step|what should i do|how to proceed|how do i proceed|what now|send link|which link|where to go|continue|proceed)\b/.test(clean)) return 'FOLLOWUP';
    return null;
};

const CONTEXT_COMMANDS = new Set(['STATUS', 'REGISTER', 'FORMS', 'PAYMENT', 'PAYMENT_ISSUE', 'PAID', 'UPI', 'RENEW',
    'FEES', 'BENEFITS', 'EVENTS', 'HELP', 'LOGIN', 'RESET', 'PROFILE', 'CARD', 'ABOUT']);
const resolveFollowup = (command, previous) => command === 'FOLLOWUP'
    ? (CONTEXT_COMMANDS.has(previous) ? previous : 'STATUS') : command;

module.exports = { normalize, parse, resolveFollowup, CONTEXT_COMMANDS };
