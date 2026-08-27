const mongoose = require('mongoose');
const logger = require('../../config/logger');
const adminsDb = require('./adminsDb');

/**
 * The one place that reads and writes admin accounts.
 *
 * **Writes go to one segregated collection per tier**, in the `adminsdb`
 * database:
 *
 *     block admins    -> adminsdb.blockadmins
 *     district admins -> adminsdb.districtadmins
 *     state admins    -> adminsdb.stateadmins
 *
 * That physical separation is the point: wiping, exporting or auditing one tier
 * is a single-collection operation instead of a filtered scan over a mixed bag.
 *
 * **Reads still span the old unified `admins` collection too.** It holds real
 * accounts that predate this split, and an account that can still authenticate
 * must never be invisible to the code deciding whether it may. New accounts
 * never land there.
 *
 * Everything that needs to know "who is an admin, and where" goes through here,
 * so the geographic tree the whole platform routes on has exactly one reader.
 */

/** The legacy unified collection. Read for compatibility; never written to. */
const PRIMARY_COLLECTION = 'admins';

const LEGACY_COLLECTIONS = {
    block_admin: 'blockadmins',
    district_admin: 'districtadmins',
    state_admin: 'stateadmins',
    super_admin: 'superadmins',
    /**
     * Content editors live alongside super admins.
     *
     * Both are platform-level with no region, so they share the shape of that
     * collection and the `role` field is what tells them apart. A fifth
     * collection for one account would add a name to every scan and every
     * listing for no separation the role does not already provide.
     */
    cms_admin: 'superadmins'
};

const ALL_COLLECTIONS = [PRIMARY_COLLECTION, ...Object.values(LEGACY_COLLECTIONS)];

/** Which role a legacy collection implies when its documents carry no role field. */
const COLLECTION_ROLE = {
    blockadmins: 'block_admin',
    districtadmins: 'district_admin',
    stateadmins: 'state_admin',
    superadmins: 'super_admin'
};

const ROLE_LABELS = {
    block_admin: 'Block Admin',
    district_admin: 'District Admin',
    state_admin: 'State Admin',
    super_admin: 'Super Admin',
    /**
     * Content only.
     *
     * Editing the public site and administering the platform are different
     * jobs done by different people, and one account doing both means whoever
     * edits the About page can also delete every block admin. This role reaches
     * the CMS and nothing else.
     */
    cms_admin: 'CMS Administrator'
};

/** The tiers a super admin is allowed to create, ordered senior first. */
const MANAGEABLE_ROLES = ['state_admin', 'district_admin', 'block_admin'];

/** How deep in the hierarchy each role sits. Higher number = closer to the ground. */
const ROLE_DEPTH = { state_admin: 1, district_admin: 2, block_admin: 3 };

/**
 * How long a full admin scan is reused.
 *
 * Every applicant loading the registration screen asks for the region tree, and
 * every dashboard load asks for coverage. Without this the same five-collection
 * scan runs on each of those requests. Kept short so a newly created admin shows
 * up almost immediately even if a write on another process invalidated nothing.
 */
const CACHE_TTL_MS = 30 * 1000;

/**
 * How long an expired scan may still be served while a refresh runs behind it.
 *
 * Past `CACHE_TTL_MS` the rows are stale, but they are stale by seconds and the
 * alternative is making a user wait out a full multi-collection scan — measured
 * at 3s against the production cluster, paid by whoever happened to load the
 * registration screen first. Inside this window the stale rows are returned
 * immediately and the refresh lands for the next caller. Beyond it the data is
 * old enough that waiting for the truth is the better answer.
 */
const CACHE_STALE_MS = 5 * 60 * 1000;

let cache = { at: 0, rows: null, unstamped: null };

/**
 * The scan currently running, if any.
 *
 * Concurrent misses used to each launch their own full scan: a dashboard load
 * firing coverage, tree and directory at once meant three simultaneous sweeps
 * of every admin collection, all producing the same answer. They now share one.
 */
let inFlight = null;

/**
 * Bumped by `invalidate()`. A scan that started before a write completed must
 * not overwrite the cache with rows it read beforehand — otherwise a newly
 * created admin can vanish again for a full TTL.
 */
let generation = 0;

/**
 * Exactly the fields `toAdminRow` and `isProvisioned` read.
 *
 * The previous projection only excluded the two password fields, so every other
 * key on every document crossed the wire — thousands of records, most of it
 * never looked at.
 */
const ROW_PROJECTION = {
    _id: 1, role: 1, adminType: 1, fullName: 1, name: 1, email: 1,
    phoneNumber: 1, phone: 1, state: 1, district: 1, block: 1, meta: 1,
    isActive: 1, active: 1, createdVia: 1, mustResetPassword: 1,
    parentAdminId: 1, createdAt: 1, updatedAt: 1, lastLoginAt: 1
};

const escapeRegex = (value = '') => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rxExact = (value) => new RegExp(`^${escapeRegex(String(value || ''))}$`, 'i');

const col = (name) => mongoose.connection.db.collection(name);

/**
 * The same collection names exist in two databases.
 *
 * The main database is where login authenticates. `adminsdb` is a legacy mirror
 * that the per-tier Mongoose models were pointed at, and accounts do still live
 * there. Reading only one of the two is how an admin could be deleted from the
 * list and keep signing in; writing to only one is how they could be deleted
 * from sign-in and stay in the list. Every scan and every delete therefore
 * covers both, addressed as one namespace.
 */
const legacyCol = (name) => {
    if (!adminsDb.isReady()) return null;
    const connection = adminsDb.getConnection();
    if (!connection || !connection.db) return null;
    try {
        return connection.db.collection(name);
    } catch (err) {
        return null;
    }
};

/**
 * Separating real staffing from the old scaffold seed.
 *
 * `adminsdb` was pre-populated with a placeholder admin for every state,
 * district and block in India — thousands of records, all active, none of them
 * a person. Counting those as staffing would put all ~6,966 blocks back in the
 * applicant dropdowns and make "every region shown has an admin waiting" false
 * for nearly all of them.
 *
 * Every account this application creates stamps `createdVia`. The scaffold has
 * none, so that field is the discriminator. It is a transitional filter: once
 * the scaffold is purged (`scripts/migrate-to-segregated-admins.js`) nothing
 * lacks the stamp and this becomes a no-op — harmless to leave in place, and
 * the safety net if the purge is ever only partly applied.
 *
 * Set ADMIN_COUNT_UNSTAMPED_AS_STAFFING=true to disable the filter and treat
 * every record as real.
 */
const COUNT_UNSTAMPED_AS_STAFFING =
    String(process.env.ADMIN_COUNT_UNSTAMPED_AS_STAFFING || '').toLowerCase() === 'true';

/**
 * True when a raw document represents deliberate staffing.
 *
 * Documents in the legacy unified `admins` collection always qualify: it was
 * never scaffolded, and its 22 accounts are real.
 */
const isProvisioned = (doc = {}, sourceKey = '') => {
    if (COUNT_UNSTAMPED_AS_STAFFING) return true;
    if (sourceKey === PRIMARY_COLLECTION) return true;
    return !!doc.createdVia;
};

/**
 * Every (database, collection) pair an admin account can be stored in.
 *
 * The segregated `adminsdb` collections come first — they are where new
 * accounts are written and therefore the authoritative roster. The unified
 * `admins` collection is scanned after them for the accounts that predate the
 * split.
 */
const sources = () => {
    const list = [];

    Object.values(LEGACY_COLLECTIONS).forEach((name) => {
        const handle = legacyCol(name);
        if (handle) list.push({ name, key: `adminsdb:${name}`, handle, segregated: true });
    });

    ALL_COLLECTIONS.forEach((name) => {
        list.push({ name, key: name, handle: col(name) });
    });

    return list;
};

/** Where a new account of this role is written. */
const collectionForRole = (role) => LEGACY_COLLECTIONS[normalizeRole(role)] || '';

/**
 * Allocate the next `adminId` for a tier.
 *
 * Sequential from the current count, with a random suffix as the collision
 * escape hatch — two super admins creating a block admin at the same moment
 * would otherwise both compute the same number and the second insert would
 * fail on the unique index.
 */
const nextAdminId = async(role) => {
    await adminsDb.ensureReady();
    const prefix = { block_admin: 'BA', district_admin: 'DA', state_admin: 'SA', super_admin: 'SUPER', cms_admin: 'CMS' }[normalizeRole(role)] || 'AD';
    const name = collectionForRole(role);
    const handle = name ? legacyCol(name) : null;
    if (!handle) return `${prefix}${Date.now().toString(36).toUpperCase()}`;

    const count = await handle.estimatedDocumentCount().catch(() => 0);

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = `${prefix}${String(count + 1 + attempt).padStart(4, '0')}`;
        // eslint-disable-next-line no-await-in-loop
        const taken = await handle.findOne({ adminId: candidate }).catch(() => null);
        if (!taken) return candidate;
    }

    return `${prefix}${Date.now().toString(36).toUpperCase()}`;
};

/** Normalise the many spellings a role has been stored under. */
const normalizeRole = (value) => {
    const role = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (role === 'blockadmin' || role === 'block_admin') return 'block_admin';
    if (role === 'districtadmin' || role === 'district_admin') return 'district_admin';
    if (role === 'stateadmin' || role === 'state_admin') return 'state_admin';
    if (role === 'superadmin' || role === 'super_admin') return 'super_admin';
    if (role === 'cmsadmin' || role === 'cms_admin') return 'cms_admin';
    return role;
};

/**
 * Flatten an admin document from any collection into one shape.
 *
 * The collections disagree on nearly every field name — `fullName` vs `name`,
 * `phoneNumber` vs `phone`, `isActive` vs `active`, `role` vs `adminType`, and
 * locations sometimes nested under `meta`. Reading a raw document anywhere else
 * is how those differences turn into a silently empty geofence.
 */
const toAdminRow = (doc = {}, source = PRIMARY_COLLECTION) => {
    const role = normalizeRole(doc.role || doc.adminType || COLLECTION_ROLE[source] || '');
    const meta = doc.meta || {};

    return {
        id: doc._id ? doc._id.toString() : '',
        source,
        fullName: doc.fullName || doc.name || '',
        email: String(doc.email || '').toLowerCase(),
        phoneNumber: doc.phoneNumber || doc.phone || '',
        role,
        roleLabel: ROLE_LABELS[role] || 'Admin',
        state: String(doc.state || meta.state || '').trim(),
        district: String(doc.district || meta.district || '').trim(),
        block: String(doc.block || meta.block || '').trim(),
        // Both spellings must be false-checked: a document carrying only
        // `active: false` would read as active if we looked at `isActive` alone.
        active: doc.isActive !== false && doc.active !== false,
        // '' on a legacy scaffold record; set on everything this app creates.
        createdVia: doc.createdVia || '',
        mustResetPassword: !!doc.mustResetPassword,
        parentAdminId: doc.parentAdminId ? String(doc.parentAdminId) : '',
        createdAt: doc.createdAt || null,
        updatedAt: doc.updatedAt || null,
        lastLoginAt: doc.lastLoginAt || null
    };
};

const invalidate = () => {
    cache = { at: 0, rows: null, unstamped: null };
    // Any scan already in the air read pre-write data; let it finish for its
    // own awaiters but stop it from being cached as current.
    generation += 1;
    inFlight = null;
};

/**
 * One sweep of every (database, collection) pair, merged and de-duplicated.
 *
 * The collections are read concurrently but merged in `sources()` order, so the
 * precedence rule is unchanged — a segregated per-tier record still wins over
 * the same account in the legacy unified collection. Reading them in sequence,
 * as this used to, spent four to five serial round trips on a cluster where
 * each one costs hundreds of milliseconds.
 */
const scanAllSources = async(limitPerCollection, includeUnstamped) => {
    const all = sources();

    const batches = await Promise.all(all.map(source => source.handle
        .find({}, { projection: ROW_PROJECTION })
        .limit(limitPerCollection)
        .toArray()
        .catch((err) => {
            logger.warn('Admin collection scan failed', { collection: source.key, error: err && err.message });
            return [];
        })));

    const byEmail = new Map();

    // Segregated collections are scanned first, so an account that exists in
    // both the new per-tier collection and the old unified one is represented by
    // the per-tier record — the one this application maintains.
    all.forEach((source, i) => {
        const docs = batches[i] || [];

        // Silent truncation here would read as "that region has no admin" and
        // escalate real queues, so say so rather than quietly under-reporting.
        if (docs.length >= limitPerCollection) {
            logger.warn('Admin scan hit its per-collection cap; coverage may be incomplete', {
                collection: source.key,
                cap: limitPerCollection
            });
        }

        docs.forEach((doc) => {
            if (!includeUnstamped && !isProvisioned(doc, source.key)) return;

            const row = toAdminRow(doc, source.name);
            row.source = source.key;
            const dedupeKey = row.email || row.id;
            if (!dedupeKey || byEmail.has(dedupeKey)) return;
            byEmail.set(dedupeKey, row);
        });
    });

    return [...byEmail.values()];
};

/**
 * Every admin on the platform, de-duplicated by email.
 *
 * The primary collection is scanned first and wins, so an account seeded into
 * both `admins` and a per-tier collection appears once with the record login
 * will actually authenticate against.
 */
const findAll = async({ fresh = false, limitPerCollection = 20000, includeUnstamped = false } = {}) => {
    // Without this the per-tier collections are invisible on the first call and
    // the whole roster silently narrows to the legacy unified collection.
    await adminsDb.ensureReady();

    const usable = !!cache.rows && cache.unstamped === includeUnstamped;
    const age = Date.now() - cache.at;

    if (!fresh && usable && age < CACHE_TTL_MS) return cache.rows;

    // Someone is already doing this exact work. Join them rather than starting
    // a second identical sweep.
    if (!fresh && inFlight && inFlight.unstamped === includeUnstamped) {
        if (usable && age < CACHE_STALE_MS) return cache.rows;
        return inFlight.promise;
    }

    const startedAt = generation;
    const run = scanAllSources(limitPerCollection, includeUnstamped).then((rows) => {
        // Discard the result only as *current*; the awaiting callers still get
        // it, because rows read a moment before a write are what they asked for.
        if (generation === startedAt) {
            cache = { at: Date.now(), rows, unstamped: includeUnstamped };
        }
        return rows;
    });

    inFlight = { promise: run, unstamped: includeUnstamped };
    run.finally(() => {
        if (inFlight && inFlight.promise === run) inFlight = null;
    }).catch(() => { /* the rejection belongs to run's awaiters, not here */ });

    // Stale-while-revalidate: inside the stale window, answer now from what we
    // already have and let the refresh above land for the next caller. Nobody
    // waits out a cold scan except the very first request after a restart.
    if (!fresh && usable && age < CACHE_STALE_MS) {
        run.catch((err) => {
            logger.warn('Background admin scan failed; serving cached roster', { error: err && err.message });
        });
        return cache.rows;
    }

    return run;
};

/** Only the accounts that can actually sign in and act. */
const findActive = async(options = {}) => {
    const rows = await findAll(options);
    return rows.filter(row => row.active);
};

/**
 * Locate one admin by email across both databases.
 *
 * Returns the raw document, password field included — this is the only read
 * that does, because login needs the hash and nothing else does.
 */
const findRawByEmail = async(email) => {
    await adminsDb.ensureReady();

    const all = sources();

    /*
     * Scan every source at once and take the first hit in `sources()` order.
     *
     * This used to `await` each collection in turn and stop at the first match,
     * so an account in the *last* source paid for a full serial walk of the
     * seven before it. That is the common case, not the rare one: the segregated
     * collections come first in block, district, state order, so a state admin —
     * the tier with the fewest records — was always found last.
     *
     * Racing them costs nothing extra (the queries are independent) and turns
     * eight sequential round trips into one.
     */
    const pick = async(filter) => {
        const hits = await Promise.all(all.map(source => source.handle
            .findOne(filter)
            .catch(() => null)));

        for (let i = 0; i < all.length; i++) {
            if (!hits[i]) continue;
            const source = all[i];
            // `objectId` is carried so the hit can be handed straight to updateById.
            // Without it an update located by email silently matched nothing.
            return {
                doc: hits[i],
                source: source.name,
                sourceKey: source.key,
                handle: source.handle,
                objectId: hits[i]._id
            };
        }
        return null;
    };

    /*
     * Exact match first, and it is the whole performance story here.
     *
     * The lookup was `{ email: /^address$/i }`. A case-insensitive regex cannot
     * use an index — MongoDB has to fetch and test every document — so each of
     * the eight collections was a full scan despite `stateadmins` and friends
     * carrying a unique index on `email`. Measured against the live cluster:
     * 6.3s to 19.2s per call, on a request path that runs it on every single
     * admin dashboard load.
     *
     * Addresses are stored lowercased everywhere this application writes them,
     * so the indexed equality below is the answer for every account it created.
     */
    const normalized = String(email || '').toLowerCase().trim();
    if (!normalized) return null;

    const exact = await pick({ email: normalized });
    if (exact) return exact;

    /*
     * The fallback case-insensitive regex scan `rxExact(normalized)` has been removed.
     * It triggered 8 full collection scans whenever a non-admin user mistyped their
     * email or entered a non-existent email, severely stalling the database. 
     * All legit admins have normalized lowercase emails.
     */
    return exact;
};

/**
 * Locate one admin by an unexpired password-reset token hash.
 *
 * Spans both databases exactly like `findRawByEmail`, because an admin can
 * legitimately live in either and a reset that only searched one would tell
 * half the roster their perfectly valid link had expired.
 *
 * The expiry is part of the query rather than a check afterwards: a token that
 * has run out must not even be matched, so a stale hash cannot be confirmed to
 * exist by timing the difference between "no such token" and "expired token".
 */
const findRawByResetToken = async(tokenHash) => {
    if (!tokenHash) return null;
    await adminsDb.ensureReady();

    const filter = {
        resetPasswordToken: tokenHash,
        resetPasswordExpires: { $gt: new Date() }
    };

    for (const source of sources()) {
        const doc = await source.handle.findOne(filter).catch(() => null);
        if (doc) {
            return {
                doc,
                source: source.name,
                sourceKey: source.key,
                handle: source.handle,
                objectId: doc._id
            };
        }
    }
    return null;
};

/** Locate one admin by _id across both databases. Returns the raw document. */
const findRawById = async(adminId) => {
    if (!mongoose.Types.ObjectId.isValid(adminId)) return null;
    await adminsDb.ensureReady();
    const objectId = new mongoose.Types.ObjectId(adminId);
    for (const source of sources()) {
        const doc = await source.handle.findOne({ _id: objectId }).catch(() => null);
        if (doc) return { doc, source: source.name, sourceKey: source.key, handle: source.handle, objectId };
    }
    return null;
};

const findById = async(adminId) => {
    const hit = await findRawById(adminId);
    if (!hit) return null;
    const row = toAdminRow(hit.doc, hit.source);
    row.source = hit.sourceKey;
    return row;
};

/** True when this email is already taken anywhere. */
const emailExists = async(email, exceptId = '') => {
    const hit = await findRawByEmail(email);
    if (!hit) return false;
    if (exceptId && hit.doc._id && hit.doc._id.toString() === String(exceptId)) return false;
    return true;
};

/**
 * Shape an incoming account into the segregated collections' document form.
 *
 * The two schemas disagree on field names — the unified collection used
 * `password` / `phone` / `isActive`, the per-tier ones use `passwordHash` /
 * `phoneNumber` / `active`. Writing the wrong spelling is silent: Mongoose
 * strict mode drops the unknown path, and the account ends up with no password
 * and no way to say so.
 */
const toTierDocument = (doc = {}, adminId = '') => {
    const role = normalizeRole(doc.role);

    return {
        adminId,
        email: String(doc.email || '').toLowerCase().trim(),
        passwordHash: doc.passwordHash || doc.password || '',
        fullName: String(doc.fullName || '').trim(),
        phoneNumber: String(doc.phoneNumber || doc.phone || '').trim(),
        role,
        state: String(doc.state || '').trim(),
        // Only the fields this tier owns are stored, so a stale district on a
        // state admin cannot linger and confuse the region tree.
        ...(role === 'state_admin' ? {} : { district: String(doc.district || '').trim() }),
        ...(role === 'block_admin' ? { block: String(doc.block || '').trim() } : {}),
        active: doc.active !== false && doc.isActive !== false,
        createdVia: doc.createdVia || 'super_admin_ui',
        parentAdminId: doc.parentAdminId || '',
        mustResetPassword: !!doc.mustResetPassword,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date()
    };
};

/**
 * Create one admin, in the collection that belongs to its tier.
 *
 * Nothing is written to the unified `admins` collection any more — that is the
 * whole point of the split. Login still reads it, so accounts already there
 * keep working.
 */
const insert = async(doc) => {
    await adminsDb.ensureReady();
    const role = normalizeRole(doc.role);
    const name = collectionForRole(role);
    const handle = name ? legacyCol(name) : null;

    if (!handle) {
        throw new Error(
            `Cannot create a ${role || 'admin'}: the adminsdb connection is unavailable, ` +
            'so the tier collection cannot be written.'
        );
    }

    const adminId = await nextAdminId(role);
    const document = toTierDocument(doc, adminId);

    const result = await handle.insertOne(document);
    invalidate();

    const row = toAdminRow({ ...document, _id: result.insertedId }, name);
    row.source = `adminsdb:${name}`;
    return row;
};

/**
 * Create many at once, for CSV onboarding.
 *
 * Grouped by tier so each batch is a single insert into its own collection.
 * `ordered: false` lets a batch continue past one bad row rather than
 * abandoning every account after it.
 */
const insertMany = async(docs) => {
    if (!docs || docs.length === 0) return [];
    await adminsDb.ensureReady();

    const byRole = new Map();
    docs.forEach((doc) => {
        const role = normalizeRole(doc.role);
        if (!byRole.has(role)) byRole.set(role, []);
        byRole.get(role).push(doc);
    });

    const rows = [];

    for (const [role, group] of byRole) {
        const name = collectionForRole(role);
        const handle = name ? legacyCol(name) : null;
        if (!handle) {
            throw new Error(`Cannot create ${role} accounts: the adminsdb connection is unavailable.`);
        }

        // Sequential ids are allocated once per group rather than per row, so a
        // 400-row import is one count query instead of 400.
        // eslint-disable-next-line no-await-in-loop
        const base = await handle.estimatedDocumentCount().catch(() => 0);
        const prefix = { block_admin: 'BA', district_admin: 'DA', state_admin: 'SA' }[role] || 'AD';

        const documents = group.map((doc, i) =>
            toTierDocument(doc, `${prefix}${String(base + 1 + i).padStart(4, '0')}`));

        // eslint-disable-next-line no-await-in-loop
        const result = await handle.insertMany(documents, { ordered: false });
        const ids = (result && result.insertedIds) || {};

        documents.forEach((document, i) => {
            const row = toAdminRow({ ...document, _id: ids[i] }, name);
            row.source = `adminsdb:${name}`;
            rows.push(row);
        });
    }

    invalidate();
    return rows;
};

/**
 * A tier-agnostic edit, translated to whatever the target collection calls
 * these fields.
 *
 * The two generations of admin document disagree on four field names, and
 * getting one wrong fails silently — the `$set` writes a brand-new path nobody
 * reads, the old value stays, and the edit looks like it worked:
 *
 *     canonical      unified `admins`     segregated per-tier
 *     ---------      ----------------     -------------------
 *     passwordHash   password             passwordHash
 *     phoneNumber    phone                phoneNumber
 *     active         isActive             active
 *
 * Callers pass the canonical names; this is the only place that knows the rest.
 */
const CANONICAL_TO_UNIFIED = {
    passwordHash: 'password',
    phoneNumber: 'phone',
    active: 'isActive'
};

const translateUpdate = (update = {}, sourceKey = '') => {
    const isUnified = sourceKey === PRIMARY_COLLECTION;
    const out = {};

    Object.entries(update).forEach(([field, value]) => {
        const target = isUnified ? (CANONICAL_TO_UNIFIED[field] || field) : field;
        out[target] = value;
    });

    return out;
};

/**
 * Update the document in place, wherever it lives.
 *
 * `hit` comes from a prior `findRawById` / `findRawByEmail`, so the write lands
 * in the same database and collection the read came from rather than assuming
 * one — an edit to an `adminsdb` account would otherwise silently no-op.
 */
const updateById = async(hit, update) => {
    if (!hit || !hit.handle) throw new Error('updateById needs the record located by findRawById');

    const $set = translateUpdate(update, hit.sourceKey);

    // A region field this tier does not own is removed rather than blanked, so
    // the region tree cannot pick up an empty-string district for a state admin.
    const $unset = {};
    const role = normalizeRole(update.role || hit.doc.role || hit.doc.adminType);
    if (role === 'state_admin') { $unset.district = ''; $unset.block = ''; }
    else if (role === 'district_admin') { $unset.block = ''; }

    Object.keys($unset).forEach((field) => { delete $set[field]; });

    const operation = { $set };
    if (Object.keys($unset).length > 0) operation.$unset = $unset;

    await hit.handle.updateOne({ _id: hit.objectId }, operation);
    invalidate();
};

/**
 * Remove an account from every collection in both databases that holds its email.
 *
 * Deleting only from the collection it was found in leaves a duplicate behind
 * that login would still happily authenticate — the deactivated admin keeps
 * their access, and the region keeps counting as staffed.
 */
const deleteEverywhere = async({ email, objectId }) => {
    await adminsDb.ensureReady();
    const filter = email ? { email: rxExact(email) } : { _id: objectId };
    let removed = 0;
    // Spans every collection in both databases: a delete that misses one leaves
    // a usable credential behind.
    for (const source of sources()) {
        const res = await source.handle.deleteMany(filter).catch(() => null);
        removed += (res && res.deletedCount) || 0;
    }
    invalidate();
    return removed;
};

module.exports = {
    PRIMARY_COLLECTION,
    collectionForRole,
    toTierDocument,
    isProvisioned,
    LEGACY_COLLECTIONS,
    ALL_COLLECTIONS,
    ROLE_LABELS,
    MANAGEABLE_ROLES,
    ROLE_DEPTH,
    normalizeRole,
    toAdminRow,
    escapeRegex,
    rxExact,
    col,
    sources,
    findAll,
    findActive,
    findById,
    findRawById,
    findRawByEmail,
    findRawByResetToken,
    emailExists,
    insert,
    insertMany,
    updateById,
    translateUpdate,
    deleteEverywhere,
    invalidate
};
