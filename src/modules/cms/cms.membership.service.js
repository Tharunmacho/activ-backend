const { Membership, SINGLETON_KEY } = require('./cms.models');

/**
 * ============================================================================
 * THE MEMBERSHIP PROSPECTUS
 * ============================================================================
 *
 * One document, shaped exactly like the table it replaced — see the note on
 * `membershipSchema`. Every field appears in the schema, in `clean` on the way
 * in and in `to` on the way out, and the three are kept beside each other
 * here, because Mongoose strict mode drops a path the schema does not name and
 * returns `success: true` while doing it.
 */

const str = (value) => String(value ?? '').trim();
const long = (value, max = 20000) => String(value ?? '').trim().slice(0, max);
const num = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback = false) => {
    if (value === undefined || value === null || value === '') return fallback;
    return value === true || value === 'true' || value === 1 || value === '1';
};

const asArray = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim().startsWith('[')) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
};

/**
 * A list of plain lines.
 *
 * Blank entries are dropped: the editor's list starts each new row empty, and
 * an empty paragraph renders as a gap nobody can see the cause of.
 */
const lines = (value) => asArray(value).map(str).filter(Boolean);

/**
 * An absent key means UNTOUCHED.
 *
 * The prospectus is edited a section at a time, and a save from the journey
 * card must not blank the fifteen advantages it does not render.
 */
const pick = (payload, key, clean) => (
    Object.prototype.hasOwnProperty.call(payload, key) ? { [key]: clean(payload[key]) } : {}
);

/** Sorted by `displayOrder`, with the index as a stable tiebreak. */
const ordered = (rows = []) => (rows || [])
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (num(a.row.displayOrder) - num(b.row.displayOrder)) || (a.index - b.index))
    .map((entry) => entry.row);

const cleanAdvantage = (input = {}, index = 0) => ({
    slug: str(input.slug),
    number: str(input.number),
    icon: str(input.icon) || 'award',
    title: str(input.title),
    subtitle: str(input.subtitle),
    body: lines(input.body),
    listLead: str(input.listLead),
    bullets: lines(input.bullets),
    closing: long(input.closing, 2000),
    after: lines(input.after),
    // The row's position in the array — see the note on the write path.
    displayOrder: index,
    isHidden: bool(input.isHidden),
});

const toAdvantage = (doc = {}) => ({
    slug: doc.slug || '',
    number: doc.number || '',
    icon: doc.icon || 'award',
    title: doc.title || '',
    subtitle: doc.subtitle || '',
    body: doc.body || [],
    listLead: doc.listLead || '',
    bullets: doc.bullets || [],
    closing: doc.closing || '',
    after: doc.after || [],
    displayOrder: Number(doc.displayOrder || 0),
    isHidden: doc.isHidden === true,
});

const cleanStep = (input = {}, index = 0) => ({
    step: str(input.step),
    icon: str(input.icon) || 'circle-check',
    title: str(input.title),
    text: long(input.text, 2000),
    // The row's position in the array — see the note on the write path.
    displayOrder: index,
    isHidden: bool(input.isHidden),
});

const toStep = (doc = {}) => ({
    step: doc.step || '',
    icon: doc.icon || 'circle-check',
    title: doc.title || '',
    text: doc.text || '',
    displayOrder: Number(doc.displayOrder || 0),
    isHidden: doc.isHidden === true,
});

const cleanBlurb = (input = {}) => ({
    heading: str(input.heading),
    subtitle: str(input.subtitle),
    lead: long(input.lead, 2000),
    bullets: lines(input.bullets),
});

const toBlurb = (doc = {}) => ({
    heading: doc.heading || '',
    subtitle: doc.subtitle || '',
    lead: doc.lead || '',
    bullets: doc.bullets || [],
});

/* The icon and the placement travel with every named field — see
   `cleanFields` in `cms.contentHelpers.js`, which this mirrors. This file
   keeps its own copy of every cleaner rather than importing across services;
   the shape is asserted by the CMS tests on both sides. */
const cleanExtraFields = (value) => asArray(value)
    .map((row) => ({
        label: str(row && row.label),
        value: str(row && row.value),
        icon: str(row && row.icon) || 'info',
        placement: str(row && row.placement) === 'content' ? 'content' : 'card',
    }))
    .filter((row) => row.label || row.value);

/**
 * What the editor did to each card on the Membership screen.
 *
 * `cleanSections` in `cms.service.js` is the same rule; this file keeps its
 * own copy of every cleaner it uses rather than importing across services,
 * and the shape is asserted by the CMS tests on both sides.
 */
const cleanSections = (value) => {
    const seen = new Set();
    return asArray(value)
        .map((row) => ({
            key: str(row && row.key).slice(0, 80),
            hidden: (row && row.hidden) === true || (row && row.hidden) === 'true',
            fields: cleanExtraFields(row && row.fields),
        }))
        .filter((row) => {
            if (!row.key || seen.has(row.key)) return false;
            seen.add(row.key);
            // A card nobody touched carries no information, so it stores no row.
            return row.hidden || row.fields.length > 0;
        })
        .slice(0, 60);
};

/** An empty prospectus, so a page can render before one is written. */
const EMPTY = {
    eyebrow: '', title: '', tagline: '', subtitleLead: '', subtitleRest: '', body: [],
    whyJoin: toBlurb(), whoShouldJoin: toBlurb(),
    advantages: [],
    journeyEyebrow: '', journeyHeading: '', journeySubtitle: '', journey: [],
    mattersHeading: '', mattersSubtitle: '', whyItMatters: [],
    closingHeading: '', closingHeadingHighlight: '', closingBody: [], closingNote: '',
    callHeading: '', callLines: [],
    statement: '', invitation: '',
    enquiriesHeading: '', website: '', email: '',
    ctaLabel: '', ctaHref: '',
    extraFields: [],
    sections: [],
};

const toMembership = (doc, { includeHidden = false } = {}) => {
    if (!doc) return { ...EMPTY };
    const live = (rows) => ordered(rows).filter((r) => includeHidden || !r.isHidden);

    return {
        eyebrow: doc.eyebrow || '',
        title: doc.title || '',
        tagline: doc.tagline || '',
        subtitleLead: doc.subtitleLead || '',
        subtitleRest: doc.subtitleRest || '',
        body: doc.body || [],
        whyJoin: toBlurb(doc.whyJoin),
        whoShouldJoin: toBlurb(doc.whoShouldJoin),
        advantages: live(doc.advantages).map(toAdvantage),
        journeyEyebrow: doc.journeyEyebrow || '',
        journeyHeading: doc.journeyHeading || '',
        journeySubtitle: doc.journeySubtitle || '',
        journey: live(doc.journey).map(toStep),
        mattersHeading: doc.mattersHeading || '',
        mattersSubtitle: doc.mattersSubtitle || '',
        whyItMatters: live(doc.whyItMatters).map(toStep),
        closingHeading: doc.closingHeading || '',
        closingHeadingHighlight: doc.closingHeadingHighlight || '',
        closingBody: doc.closingBody || [],
        closingNote: doc.closingNote || '',
        callHeading: doc.callHeading || '',
        callLines: doc.callLines || [],
        statement: doc.statement || '',
        invitation: doc.invitation || '',
        enquiriesHeading: doc.enquiriesHeading || '',
        website: doc.website || '',
        email: doc.email || '',
        ctaLabel: doc.ctaLabel || '',
        ctaHref: doc.ctaHref || '',
        extraFields: doc.extraFields || [],
        sections: doc.sections || [],
    };
};

const actorOf = (user = {}) => ({
    email: user.email || user.username || 'cms',
    at: new Date(),
});

module.exports = {
    async get({ includeHidden = false } = {}) {
        const doc = await Membership.findOne({ key: SINGLETON_KEY }).lean().catch(() => null);
        return toMembership(doc, { includeHidden });
    },

    async save(payload = {}, user = {}) {
        const updates = {
            ...pick(payload, 'eyebrow', str),
            ...pick(payload, 'title', str),
            ...pick(payload, 'tagline', str),
            ...pick(payload, 'subtitleLead', str),
            ...pick(payload, 'subtitleRest', str),
            ...pick(payload, 'body', lines),
            ...pick(payload, 'whyJoin', cleanBlurb),
            ...pick(payload, 'whoShouldJoin', cleanBlurb),
            /*
             * RENUMBERED FROM THE ARRAY.
             *
             * `toMembership` sorts on `displayOrder`, and the CMS reorder
             * buttons move rows without touching it — so the sort undid
             * every reorder on the way back out. The array is the order.
             */
            ...pick(payload, 'advantages', (v) => asArray(v).map((row, i) => cleanAdvantage(row, i))
                .filter((r) => r.title || r.bullets.length || r.body.length)),
            ...pick(payload, 'journeyEyebrow', str),
            ...pick(payload, 'journeyHeading', str),
            ...pick(payload, 'journeySubtitle', str),
            ...pick(payload, 'journey', (v) => asArray(v).map((row, i) => cleanStep(row, i))
                .filter((r) => r.title || r.text)),
            ...pick(payload, 'mattersHeading', str),
            ...pick(payload, 'mattersSubtitle', str),
            ...pick(payload, 'whyItMatters', (v) => asArray(v).map(cleanStep)
                .filter((r) => r.title || r.text)),
            ...pick(payload, 'closingHeading', str),
            ...pick(payload, 'closingHeadingHighlight', str),
            ...pick(payload, 'closingBody', lines),
            ...pick(payload, 'closingNote', (v) => long(v, 2000)),
            ...pick(payload, 'callHeading', str),
            ...pick(payload, 'callLines', lines),
            ...pick(payload, 'statement', (v) => long(v, 2000)),
            ...pick(payload, 'invitation', (v) => long(v, 2000)),
            ...pick(payload, 'enquiriesHeading', str),
            ...pick(payload, 'website', str),
            ...pick(payload, 'email', str),
            ...pick(payload, 'ctaLabel', str),
            ...pick(payload, 'ctaHref', str),
            ...pick(payload, 'extraFields', cleanExtraFields),
            ...pick(payload, 'sections', cleanSections),
            editedBy: actorOf(user),
        };

        const doc = await Membership.findOneAndUpdate(
            { key: SINGLETON_KEY },
            { $set: updates },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean();

        return toMembership(doc, { includeHidden: true });
    },
};
