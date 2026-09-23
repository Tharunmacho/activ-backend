/**
 * FILL THE CMS BOXES THAT ARE EMPTY WHILE THE PAGE SHOWS WORDS.
 *
 * Several bands render a shipped sentence when their CMS field is blank. That
 * fallback is right and stays — an empty database must not produce a heading
 * that is a blank line — but it has a cost nobody designed for: the editor
 * reads "Reach ACTIV in your zone" on the live site, opens the card that
 * controls it, and finds an empty box. The grey text in that box is the
 * placeholder, which is the same sentence, so there is no way to tell from
 * the screen whether the words are stored, whether they saved, or whether
 * typing would overwrite something.
 *
 * It was reported exactly that way: "in the screen it is showing, why is it
 * not added in the CMS, it looks empty."
 *
 * This writes the shown wording into the blank fields, so the box says what
 * the page says. Nothing else changes: the fallbacks stay where they are, so
 * clearing a field still puts the shipped sentence back.
 *
 *   node scripts/seed-shown-defaults.js            # report
 *   node scripts/seed-shown-defaults.js --confirm  # write
 *
 * ONLY BLANK FIELDS ARE TOUCHED, and there is no --force. Every value below
 * is a default the code already prints; overwriting an editor's own wording
 * with it could only ever be a downgrade.
 */

require('dotenv').config();
const adminsDb = require('../src/modules/admin/adminsDb');

const CONFIRM = process.argv.includes('--confirm');

/**
 * Each entry: the model, the document path, and the sentence the CLIENT
 * currently draws when that path is blank. The source of each is named so the
 * two can be checked against each other when either changes.
 */
const FILLS = [
    // website/src/components/shared/AcrossIndia.tsx -> CONTACT_DEFAULTS
    ['ContactSettings', 'regionsBand.eyebrow', 'Contacts across India'],
    ['ContactSettings', 'regionsBand.heading', 'Reach ACTIV in your zone'],
    ['ContactSettings', 'regionsBand.subtitle', 'Choose your zone or state to see who to contact there.'],
    // website/src/pages/onboarding/SchemesPage.tsx -> `empty`
    ['SchemeSettings', 'emptyMessage', 'Nothing has been published here yet.'],
];

const at = (doc, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), doc);

/**
 * THE ZONE AND STATE PAGES' OWN HEADINGS.
 *
 * "State / Tamil Nadu Leaders", "Districts / District-wise Leadership",
 * "Contact / Get in Touch" — every one was a string literal in `RegionPage`
 * and `StatePage`, drawn on every one of those pages and editable from
 * nowhere. They are CMS fields now (`labels` on both schemas), and the client
 * still falls back to the same words, so an unseeded page is unchanged. This
 * fills the stored field so the CMS box is not empty beside live wording.
 *
 * THREE TABLES, because the three page types disagree about what their bands
 * are called: a zone's own bench is "Zone" over "States", a state's is
 * "State" over "Regions", and the national page is "National" over "Zones".
 * They mirror STATE_LABELS / ZONE_LABELS / NATIONAL_LABELS in
 * `website/src/services/cmsRegionsApi.ts` — if one moves, move both.
 */
const STATE_LABELS = {
    ownTierEyebrow: 'State',
    tierBelowEyebrow: 'Regions',
    tierBelowHeading: 'Region-wise Leadership',
    districtsEyebrow: 'Districts',
    districtsHeading: 'District-wise Leadership',
    contactEyebrow: 'Contact',
    contactHeading: 'Get in Touch',
};

const ZONE_LABELS = {
    ownTierEyebrow: 'Zone',
    tierBelowEyebrow: 'States',
    tierBelowHeading: 'State-wise Leadership',
    contactEyebrow: 'Contact',
    contactHeading: 'Get in Touch',
};

const NATIONAL_LABELS = {
    ...ZONE_LABELS,
    ownTierEyebrow: 'National',
    tierBelowEyebrow: 'Zones',
    tierBelowHeading: 'Zone-wise Leadership',
};

/**
 * Fill the blank headings on every zone and state page.
 *
 * Per FIELD, not per page: a page where somebody has already renamed one band
 * keeps that name and has only its untouched headings filled. Filling the
 * whole table whenever any field was blank would quietly undo their edit.
 */
const fillPageLabels = async (models, confirm) => {
    const jobs = [
        [models.RegionPage, (doc) => (String(doc.regionKey || '') === 'national'
            ? NATIONAL_LABELS : ZONE_LABELS), 'regionKey'],
        [models.StatePage, () => STATE_LABELS, 'stateName'],
    ];

    let filled = 0;
    for (const [Model, tableFor, nameKey] of jobs) {
        if (!Model) continue;
        const docs = await Model.find({}).lean();
        for (const doc of docs) {
            const table = tableFor(doc);
            const set = {};
            Object.keys(table).forEach((key) => {
                if (!String((doc.labels || {})[key] || '').trim()) {
                    set[`labels.${key}`] = table[key];
                }
            });
            if (!Object.keys(set).length) continue;
            console.log(`+  ${doc[nameKey]} <- ${Object.keys(set).length} heading(s)`);
            filled += 1;
            if (confirm) await Model.updateOne({ _id: doc._id }, { $set: set });
        }
    }
    return filled;
};

(async () => {
    /* The CMS models bind to `adminsdb` only once that connection is open. */
    await adminsDb.ensureReady();
    const models = require('../src/modules/cms/cms.models');

    const pending = [];
    for (const [modelName, path, value] of FILLS) {
        const Model = models[modelName];
        if (!Model) { console.log(`?  ${modelName} is not a model — skipped`); continue; }

        const doc = await Model.findOne({}).lean();
        if (!doc) { console.log(`-  ${modelName} has no document yet — skipped`); continue; }

        const current = at(doc, path);
        if (String(current || '').trim()) {
            console.log(`=  ${modelName}.${path} already says "${String(current).slice(0, 48)}"`);
            continue;
        }
        console.log(`+  ${modelName}.${path} <- "${value}"`);
        pending.push({ Model, _id: doc._id, path, value });
    }

    console.log('');
    const pages = await fillPageLabels(models, CONFIRM);

    if (!pending.length && !pages) { console.log('\nNothing to fill.'); process.exit(0); }
    if (!CONFIRM) {
        console.log(`\n${pending.length} field(s) and ${pages} page(s) to fill. Re-run with --confirm.`);
        process.exit(0);
    }

    for (const { Model, _id, path, value } of pending) {
        await Model.updateOne({ _id }, { $set: { [path]: value } });
    }
    console.log(`\nFilled ${pending.length} field(s) and ${pages} page(s). All still editable in the CMS.`);
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
