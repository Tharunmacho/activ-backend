const { EventsSettings, SINGLETON_KEY } = require('../cms/cms.models');
const Event = require('./event.model');
const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');

/**
 * Event categories — Medical, Awareness, Export, Coffee Meet.
 *
 * =========================================================================
 * ONE LIST. THE MANAGED CATEGORIES AND THE PUBLIC FILTER CHIPS ARE THE SAME
 * ROWS, AND THAT IS THE WHOLE DESIGN.
 * =========================================================================
 *
 * These live in `cms.EventsSettings.categories`, where the filter chips above
 * the public `/events` grid have always lived. The obvious alternative — a new
 * `event_categories` collection for the admin screen — was rejected: the chips
 * are matched against `Event.category` by label, so two lists would be two
 * spellings of the same idea, and adding "Coffee Meet" in one place would give
 * the association a category the public grid could not filter by, with nothing
 * on either screen to say the other existed.
 *
 * The region architecture makes exactly this argument about admin-typed region
 * names, and for the same reason: a free-text label matched by string equality
 * cannot afford a second source.
 *
 * ----------------------------------------------------------- renaming is real
 *
 * `Event.category` stores the LABEL, not an id — the schema says so, and it is
 * what lets an event carry a category the chip list has not caught up with.
 * That makes a rename a two-part write: the chip, and every event wearing the
 * old label. Renaming only the chip would leave those events matching no chip
 * at all, so they would vanish from every filter on the public page while still
 * being published — the worst shape of bug, because the events are all still
 * there and nothing reports anything.
 *
 * `renameCategory` therefore re-stamps the events, and reports how many it
 * touched so the screen can say so.
 *
 * --------------------------------- unmanaged labels are shown, not hidden
 *
 * An event may carry a label no chip lists: one written before this screen
 * existed, one imported, or one whose chip was deleted. `listCategories`
 * returns those as rows too, flagged `managed: false`, with the count of events
 * using them and a one-click "add to the list".
 *
 * Hiding them would make the admin screen a list of SOME of the categories in
 * use, which is the least useful thing a list of categories could be — the
 * editor deletes a chip, twelve events keep the label, and the screen shows
 * eleven categories and no trace of the twelfth.
 */

/** The standard list the association works from. Offered, never forced. */
const STANDARD_CATEGORIES = Object.freeze([
    'Medical', 'Food Processing', 'Women', 'Internal', 'ZOOM', 'Awareness',
    'Tea party', 'Coffee Meet', 'Fashion', 'Club House', 'VDP', 'Export', 'District'
]);

const str = (value) => String(value === null || value === undefined ? '' : value).trim();

/** Regex-safe: a category the editor typed is free text and may hold anything. */
const escapeRx = (value) => str(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Two labels the same category?
 *
 * Case- and whitespace-insensitive, because "Coffee Meet", "coffee meet" and
 * "Coffee  Meet" are one category to everybody except a string comparison —
 * and a duplicate chip is not cosmetic. `Event.category` is matched by label,
 * so two spellings split one category's events across two filters, each showing
 * half of them. The admin region tree carries this same note about
 * `buildGeoFilter`, and it is the same failure.
 */
const matchKey = (value) => str(value).toLowerCase().replace(/\s+/g, ' ');
const sameLabel = (a, b) => matchKey(a) === matchKey(b);

/**
 * Which kind of event a category may be offered for.
 *
 * Anything unrecognised is `both`, which is the widest answer and therefore the
 * safe one: a category wrongly widened is offered where it need not be, while a
 * category wrongly narrowed disappears from a form with nothing to say why.
 */
const cleanMode = (value) => {
    const mode = str(value).toLowerCase();
    return (mode === 'online' || mode === 'offline') ? mode : 'both';
};

/** A label that can be stored, matched and read. */
const cleanLabel = (value) => {
    const label = str(value).replace(/\s+/g, ' ').slice(0, 60);
    if (!label) throw ApiError.badRequest('A category name is required');
    return label;
};

/** Read the chip array alone. The rest of the singleton is not this module's. */
const readCategories = async() => {
    const doc = await EventsSettings.findOne({ key: SINGLETON_KEY })
        .select('categories').lean().catch(() => null);
    return (doc && Array.isArray(doc.categories)) ? doc.categories : [];
};

/**
 * Write the chip array alone — `$set: { categories }`, never the whole document.
 *
 * `writeSingleton` in `cms.service` rebuilds the entire events-settings
 * document from its payload, which is right for the CMS form that renders every
 * field and catastrophic here: this screen renders the categories and nothing
 * else, so saving through that path would blank the heading, the hero, the
 * stats and the banner copy of the public events page every time somebody
 * renamed a chip.
 */
const writeCategories = async(categories, user = {}) => {
    const actor = str(user.email || user.fullName || user.id || 'super admin');
    const doc = await EventsSettings.findOneAndUpdate(
        { key: SINGLETON_KEY },
        { $set: { categories, key: SINGLETON_KEY, editedBy: { name: actor, at: new Date() } } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    ).select('categories').lean();

    return (doc && doc.categories) || [];
};

/**
 * How many events wear each label, in one pass rather than one query per chip.
 *
 * Keyed by the MATCH key, and the real spelling is kept beside the count. Two
 * events spelled "ZOOM" and "Zoom" are one category here — which is the point,
 * since they are one category to the chip that matches them — and the label
 * shown is the one an event actually carries rather than a lowercased key.
 */
const usageByLabel = async() => {
    const rows = await Event.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 } } }
    ]).catch(() => []);

    const map = new Map();
    for (const row of rows || []) {
        const key = matchKey(row._id);
        if (!key) continue;
        const existing = map.get(key);
        map.set(key, {
            label: (existing && existing.label) || str(row._id),
            count: ((existing && existing.count) || 0) + Number(row.count || 0)
        });
    }
    return map;
};

const usageOf = (map, label) => {
    const hit = map.get(matchKey(label));
    return (hit && hit.count) || 0;
};

class EventCategoryService {
    /**
     * Every category: the managed chips in their stored order, then any label
     * an event carries that no chip lists.
     *
     * `id` is the chip subdocument's own `_id` and is the handle every write
     * below takes. An unmanaged row has no chip and therefore no id — it is
     * addressed by label, which is all that exists for it.
     */
    async listCategories() {
        const [categories, usage] = await Promise.all([readCategories(), usageByLabel()]);

        const managed = categories.map((row, index) => ({
            id: String(row._id || ''),
            label: row.label || '',
            icon: row.icon || 'calendar-days',
            // Absent on every row written before the field existed, and `both`
            // is what those rows have always meant.
            mode: cleanMode(row.mode),
            order: index,
            managed: true,
            eventCount: usageOf(usage, row.label)
        }));

        /*
         * Labels in use that no chip lists. Sorted by how many events carry
         * them, so the one worth adding to the list is the one at the top.
         */
        const unmanaged = [...usage.values()]
            .filter((hit) => !managed.some((row) => sameLabel(row.label, hit.label)))
            .map((hit) => ({
                id: '',
                label: hit.label,
                icon: 'calendar-days',
                // An unmanaged label has no row to carry a mode, so it is
                // offered for both until somebody adds it to the list.
                mode: 'both',
                order: 999,
                managed: false,
                eventCount: hit.count
            }))
            .sort((a, b) => b.eventCount - a.eventCount);

        const all = [...managed, ...unmanaged];

        return {
            categories: all,
            /** Which of the standard list is not present — what "Add standard" would add. */
            missingStandard: STANDARD_CATEGORIES.filter(
                (name) => !all.some((row) => sameLabel(row.label, name))
            ),
            standard: [...STANDARD_CATEGORIES]
        };
    }

    /** The labels alone, for a dropdown. Managed first, in the editor's order. */
    async listLabels() {
        const { categories } = await this.listCategories();
        return categories.map((row) => row.label).filter(Boolean);
    }

    async addCategory(payload = {}, user = {}) {
        const label = cleanLabel(payload.label);
        const categories = await readCategories();

        if (categories.some((row) => sameLabel(row.label, label))) {
            throw ApiError.badRequest(`"${label}" is already a category`);
        }

        categories.push({
            label,
            icon: str(payload.icon) || 'calendar-days',
            mode: cleanMode(payload.mode),
        });
        await writeCategories(categories, user);
        logger.info('Event category added', { label });

        return this.listCategories();
    }

    /**
     * Rename a chip AND every event wearing the old label.
     *
     * Both, in that order, and the event re-stamp is not optional — see the
     * note at the head of this file. The count of re-stamped events is returned
     * so the screen can say "renamed, and moved 12 events onto it" rather than
     * leaving the editor to guess whether their published programme followed.
     */
    async renameCategory(id, payload = {}, user = {}) {
        const label = cleanLabel(payload.label);
        const categories = await readCategories();
        const index = categories.findIndex((row) => String(row._id || '') === String(id));

        if (index < 0) throw ApiError.notFound('That category no longer exists');

        const previous = str(categories[index].label);

        if (categories.some((row, i) => i !== index && sameLabel(row.label, label))) {
            throw ApiError.badRequest(`"${label}" is already a category`);
        }

        categories[index].label = label;
        if (payload.icon !== undefined) categories[index].icon = str(payload.icon) || 'calendar-days';
        /*
         * Absent means UNTOUCHED, not `both`.
         *
         * A rename posts a label and nothing else, and defaulting the mode here
         * would quietly widen a category back to "both" every time somebody
         * fixed a typo in its name.
         */
        if (payload.mode !== undefined) categories[index].mode = cleanMode(payload.mode);
        await writeCategories(categories, user);

        const moved = await this.restampEvents(previous, label);

        logger.info('Event category renamed', { previous, label, moved });
        return { ...(await this.listCategories()), moved, previous };
    }

    /**
     * Move every event off one label and onto another.
     *
     * Anchored and case-insensitive for the reason `buildGeoFilter` is: the
     * stored value is free text that may carry stray whitespace, and an
     * unanchored match would re-stamp "Women in Export" while renaming "Export".
     */
    async restampEvents(previous, label) {
        if (!previous || sameLabel(previous, label)) return 0;

        const result = await Event.updateMany(
            { category: new RegExp(`^\\s*${escapeRx(previous)}\\s*$`, 'i') },
            { $set: { category: label } }
        ).catch((error) => {
            /*
             * The chip moved and the events did not.
             *
             * Reported loudly rather than swallowed: the screen shows `moved: 0`
             * beside a category it knows has events, which is visible on the
             * spot, and the log says why. Silently returning 0 here would leave
             * published events matching no chip with nothing anywhere to say so.
             */
            logger.error('Category renamed but events were not re-stamped', {
                previous, label, error: error.message
            });
            return null;
        });

        return (result && result.modifiedCount) || 0;
    }

    /**
     * Adopt an unmanaged label — the "add to the list" on a row that events
     * already carry. Addressed by label, because an unmanaged row has no chip
     * and therefore no id.
     */
    async adoptCategory(payload = {}, user = {}) {
        return this.addCategory(payload, user);
    }

    /**
     * Remove a chip.
     *
     * THE EVENTS KEEP THEIR LABEL. Clearing `category` on them would be a
     * silent, unrecoverable edit to published records — an editor tidying a
     * chip list has not asked to re-categorise twelve events, and there is no
     * undo. They reappear on this screen as an unmanaged row instead, one click
     * from being listed again.
     *
     * The cost is that the public grid loses a chip those events could be
     * filtered by, which is exactly what deleting a chip means and is visible
     * from the count shown beside the delete button before it is pressed.
     */
    async deleteCategory(id, user = {}) {
        const categories = await readCategories();
        const index = categories.findIndex((row) => String(row._id || '') === String(id));
        if (index < 0) throw ApiError.notFound('That category no longer exists');

        const [removed] = categories.splice(index, 1);
        await writeCategories(categories, user);
        logger.info('Event category removed', { label: removed && removed.label });

        return this.listCategories();
    }

    /**
     * Move a chip up or down — the chips are rendered in stored order, so this
     * is the only way to decide which filters appear first on the public page.
     */
    async reorderCategory(id, direction, user = {}) {
        const categories = await readCategories();
        const index = categories.findIndex((row) => String(row._id || '') === String(id));
        if (index < 0) throw ApiError.notFound('That category no longer exists');

        const target = direction === 'up' ? index - 1 : index + 1;
        // Silently a no-op at either end rather than an error: the screen
        // disables the button there, and a race that slips past it is not worth
        // a red banner.
        if (target < 0 || target >= categories.length) return this.listCategories();

        const [moved] = categories.splice(index, 1);
        categories.splice(target, 0, moved);
        await writeCategories(categories, user);

        return this.listCategories();
    }

    /**
     * Add whichever of the standard list is missing, in one go.
     *
     * Additive only — it never removes, reorders or renames what is already
     * there. An association that has built its own list and presses this gets
     * its own list plus the standard names it did not have, which is
     * recoverable one delete at a time; the alternative, replacing the list,
     * is not.
     */
    async addStandard(user = {}) {
        const categories = await readCategories();
        const added = [];

        for (const label of STANDARD_CATEGORIES) {
            if (categories.some((row) => sameLabel(row.label, label))) continue;
            categories.push({ label, icon: 'calendar-days' });
            added.push(label);
        }

        if (added.length) {
            await writeCategories(categories, user);
            logger.info('Standard event categories added', { added });
        }

        return { ...(await this.listCategories()), added };
    }
}

module.exports = new EventCategoryService();
module.exports.STANDARD_CATEGORIES = STANDARD_CATEGORIES;
module.exports.sameLabel = sameLabel;
module.exports.matchKey = matchKey;
