const ApiError = require('../../core/utils/ApiError');
const { bookingHistoryCategory } = require('./eventLifecycle');

const keys = ['history', 'category', 'language', 'mode', 'state', 'district', 'city', 'attendeeState',
    'eventFrom', 'eventTo', 'bookedFrom', 'bookedTo', 'paymentStatus', 'status', 'registrationType',
    'responseKey', 'responseValue', 'search', 'eventSearch'];
const clean = value => String(value || '').trim();
const fold = value => clean(value).toLocaleLowerCase('en-IN');
const escape = value => clean(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = value => new RegExp('^\\s*' + escape(value) + '\\s*$', 'i');
const split = value => clean(value).split(/[,/;&]+/).map(clean).filter(Boolean);
const choices = values => [...new Map(values.filter(Boolean).map(v => [fold(v), clean(v)])).values()].sort((a, b) => a.localeCompare(b));
const regionRows = event => [{ state: event?.state, district: event?.district }, ...(event?.targets || []).filter(Boolean)];

function regionOptions(events, tree) {
    const states = new Map();
    const districts = new Map();
    const add = (stateValue, districtValue) => {
        const state = clean(stateValue);
        const district = clean(districtValue);
        const stateKey = fold(state);
        if (state && !states.has(stateKey)) states.set(stateKey, state);
        const pairKey = JSON.stringify([stateKey, fold(district)]);
        if (district && !districts.has(pairKey)) {
            districts.set(pairKey, { state: states.get(stateKey) || '', name: district });
        }
    };
    // Use the same complete location directory as the event editor, including
    // custom admin regions and regions with no block administrators.
    for (const state of tree || []) {
        add(state?.name);
        for (const district of state?.districts || []) add(state?.name, district?.name);
    }
    // Retain saved targets from older/deleted events even if they no longer
    // exist in the directory. Prefer the directory's spelling for duplicates.
    for (const row of events.flatMap(regionRows)) add(row.state, row.district);
    return {
        states: [...states.values()].sort((a, b) => a.localeCompare(b)),
        districts: [...districts.values()].sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name)),
    };
}

function normalizeFilters(input = {}) {
    const out = {};
    for (const key of keys) {
        if (input[key] == null || input[key] === '') continue;
        if (typeof input[key] !== 'string' || input[key].length > 200) throw ApiError.badRequest('Invalid booking filter: ' + key);
        out[key] = input[key].trim();
    }
    const enums = { history: ['current', 'past', 'deleted'], mode: ['online', 'offline'],
        paymentStatus: ['paid', 'pending', 'not_required', 'failed'], status: ['active', 'waitlist', 'expired', 'cancelled'],
        registrationType: ['guest', 'member'] };
    for (const [key, allowed] of Object.entries(enums)) {
        if (out[key] && !allowed.includes(out[key])) throw ApiError.badRequest('Invalid booking filter: ' + key);
    }
    for (const key of ['eventFrom', 'eventTo', 'bookedFrom', 'bookedTo']) {
        if (out[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(out[key]) || !Number.isFinite(Date.parse(out[key]))
            || new Date(out[key]).toISOString().slice(0, 10) !== out[key])) throw ApiError.badRequest('Enter a valid date for ' + key);
    }
    for (const prefix of ['event', 'booked']) {
        if (out[prefix + 'From'] && out[prefix + 'To'] && out[prefix + 'From'] > out[prefix + 'To']) {
            throw ApiError.badRequest('The from date must be before the to date.');
        }
    }
    if (out.responseValue && !out.responseKey) throw ApiError.badRequest('Choose a registration question first.');
    return out;
}

// Date controls use Indian calendar days, irrespective of server/browser timezone.
const firstInstant = day => new Date(day + 'T00:00:00+05:30');
const afterDay = day => new Date(firstInstant(day).getTime() + 86400000);
function matchesEvent(event, filters, now = new Date(), ignoreHistory = false) {
    if (!ignoreHistory && filters.history && bookingHistoryCategory(event, now) !== filters.history) return false;
    if (filters.category && fold(event.category) !== fold(filters.category)) return false;
    if (filters.language && !split(event.language).some(v => fold(v) === fold(filters.language))) return false;
    if (filters.mode && (event.mode || (event.bookingHistoryOnly ? '' : 'offline')) !== filters.mode) return false;
    if ((filters.state || filters.district) && !regionRows(event).some(row =>
        (!filters.state || fold(row.state) === fold(filters.state)) && (!filters.district || fold(row.district) === fold(filters.district)))) return false;
    if (filters.eventSearch && ![event.title, event.venue, event.category].some(v => fold(v).includes(fold(filters.eventSearch)))) return false;
    const at = event.startAt && new Date(event.startAt);
    if (filters.eventFrom && (!at || at < firstInstant(filters.eventFrom))) return false;
    if (filters.eventTo && (!at || at >= afterDay(filters.eventTo))) return false;
    return true;
}

const responseLabels = { city: /^(?:city|town|city\s*[/&]\s*town|city name|your city)$/i,
    attendeeState: /^(?:state|state name|your state)$/i };
function bookingMatch(input = {}) {
    const filters = normalizeFilters(input);
    const query = {};
    const clauses = [];
    if (filters.paymentStatus) query['payment.status'] = filters.paymentStatus;
    if (filters.status) query.status = filters.status;
    if (filters.registrationType) query.isGuest = filters.registrationType === 'guest';
    if (filters.bookedFrom || filters.bookedTo) query.createdAt = {
        ...(filters.bookedFrom ? { $gte: firstInstant(filters.bookedFrom) } : {}),
        ...(filters.bookedTo ? { $lt: afterDay(filters.bookedTo) } : {}),
    };
    for (const key of ['city', 'attendeeState']) {
        if (filters[key]) clauses.push({ responses: { $elemMatch: { label: responseLabels[key], value: exact(filters[key]) } } });
    }
    if (filters.responseKey) clauses.push({ responses: { $elemMatch: { key: filters.responseKey,
        ...(filters.responseValue ? { value: new RegExp(escape(filters.responseValue), 'i') } : { value: { $nin: ['', null] } }) } } });
    if (filters.search) {
        const rx = new RegExp(escape(filters.search), 'i');
        clauses.push({ $or: ['bookingRef', 'bookedBy.name', 'bookedBy.email', 'bookedBy.phone', 'participants.name', 'participants.email', 'participants.phone']
            .map(key => ({ [key]: rx })) });
    }
    if (clauses.length) query.$and = clauses;
    return query;
}

async function filterOptions(events = []) {
    const [answers, tree] = await Promise.all([
        require('./eventbooking.model').aggregate([
            { $unwind: '$responses' },
            { $group: { _id: { key: '$responses.key', label: '$responses.label' },
                values: { $addToSet: { $cond: [{ $regexMatch: { input: { $ifNull: ['$responses.label', ''] }, regex: /^(city|town|city\s*[/&]\s*town|city name|your city|state|state name|your state)$/i } }, '$responses.value', ''] } } } },
        ]),
        require('../regions/region.service').getLocationTree(),
    ]);
    return {
        categories: choices(events.map(e => e.category)), languages: choices(events.flatMap(e => split(e.language))),
        ...regionOptions(events, tree),
        cities: choices(answers.filter(a => responseLabels.city.test(a._id.label)).flatMap(a => a.values)),
        attendeeStates: choices(answers.filter(a => responseLabels.attendeeState.test(a._id.label)).flatMap(a => a.values)),
        questions: [...new Map(answers.filter(a => a._id.key).map(a => [a._id.key, { key: a._id.key, label: a._id.label || a._id.key }])).values()],
    };
}

const EVENT_FIELDS = 'title startAt endAt days archivedAt status venue category language mode state district targets';
async function matchingEvents(input = {}) {
    const filters = normalizeFilters(input);
    const [events, deleted] = await Promise.all([
        require('./event.model').find({}).select(EVENT_FIELDS).lean(), require('./bookingHistory').deletedEventBookingHeaders(),
    ]);
    const now = new Date();
    return [...events, ...deleted].filter(event => matchesEvent(event, filters, now));
}
module.exports = { normalizeFilters, matchesEvent, bookingMatch, filterOptions, matchingEvents, EVENT_FIELDS };
