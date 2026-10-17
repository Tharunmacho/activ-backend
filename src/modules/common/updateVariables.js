const TOKEN = /(?<!\{)\{\s*([a-z][a-z0-9_]{0,39})\s*\}(?!\})/gi;
const clean = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
const formatDate = value => value && Number.isFinite(new Date(value).getTime())
    ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(value)) : '';
const BUILTINS = [
    ['name', 'Member name', 'Profile name; otherwise ACTIVian.'],
    ['title', 'Title (Mr / Ms / Dr)', 'Enter a shared value or a value for each member. Never inferred.'],
    ['company_name', 'Company name', 'Membership application company, then the earliest active company.'],
    ['date', 'Publication date', 'The date this update is published, in India time.'],
    ['renewal_date', 'Membership expiry / renewal date', 'Recorded expiry date; blank for lifetime or missing expiry.'],
    ['fee', 'Fee (enter value)', 'Enter the amount relevant to this message. No price is guessed.'],
    ['renewal_fee', 'Renewal fee (enter value)', 'Enter the current quoted renewal fee yourself.'],
    ['last_paid_fee', 'Last membership payment', 'Amount on the latest paid membership receipt; not a renewal quote.'],
    ['membership_number', 'Membership number', 'The membership number on record.'],
    ['email', 'Email', 'Member profile email.'], ['phone', 'Phone', 'Member profile phone.'],
    ['state', 'State', 'Member profile state.'], ['district', 'District', 'Member profile district.'],
    ['block', 'Block', 'Member profile block.'], ['city', 'City', 'Member profile city.'],
    ['country', 'Country', 'Member profile country.'], ['place', 'Place', 'Member profile place.'],
    ['member_since', 'Membership activation date', 'Recorded membership activation date.'],
].map(([key, label, detail]) => ({ key, label, detail }));
const builtinKeys = new Set(BUILTINS.map(row => row.key));
function variableValues(update = {}, recipient = {}) {
    const values = Object.assign(Object.create(null), {
        name: clean(recipient.fullName).replace(/\s+/g, ' ').slice(0, 160), title: '',
        company_name: clean(recipient.companyName), date: formatDate(update.publishedAt),
        renewal_date: recipient.membershipType === 'lifetime' || recipient.isLifetime ? '' : formatDate(recipient.membershipExpiresAt),
        fee: '', renewal_fee: '', last_paid_fee: clean(recipient.lastPaidFee),
        membership_number: clean(recipient.membershipNumber), email: clean(recipient.email), phone: clean(recipient.phoneNumber),
        state: clean(recipient.state), district: clean(recipient.district), block: clean(recipient.block),
        city: clean(recipient.city), country: clean(recipient.country), place: clean(recipient.place),
        member_since: formatDate(recipient.membershipActivatedAt),
    });
    const id = String(recipient._id || recipient.id || '');
    for (const variable of update.variables || []) {
        const key = String(variable.key || '').toLowerCase();
        const override = id && (variable.overrides || []).find(row => String(row.memberId) === id);
        values[key] = clean(override?.value) || values[key] || clean(variable.defaultValue);
    }
    values.name ||= 'ACTIVian';
    return values;
}
function missingVariables(update, recipient) {
    const values = variableValues(update, recipient);
    const text = ['title', 'summary', 'body', 'bannerAlt', 'attachmentLabel'].map(key => update[key] || '').join('\n');
    return [...new Set([...text.matchAll(TOKEN)].map(match => match[1].toLowerCase()))].filter(key => !values[key]);
}
module.exports = { TOKEN, variableValues, missingVariables, BUILTINS, builtinKeys };
