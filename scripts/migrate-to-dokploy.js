/**
 * Move the production data from Atlas (old two-database layout) into the
 * Dokploy MongoDB in the NEW layout — eight databases, plain collection names,
 * exactly as config/dataLayout.js places them. NEVER DELETES.
 *
 *   SOURCE_URI=<atlas>  TARGET_URI=<dokploy external>  node scripts/migrate-to-dokploy.js plan
 *   SOURCE_URI=…        TARGET_URI=…                   node scripts/migrate-to-dokploy.js backup
 *   SOURCE_URI=…        TARGET_URI=…                   node scripts/migrate-to-dokploy.js copy --confirm [--skip-backup]
 *   SOURCE_URI=…        TARGET_URI=…                   node scripts/migrate-to-dokploy.js verify
 *   SOURCE_URI=…        TARGET_URI=…                   node scripts/migrate-to-dokploy.js sync --confirm [--skip-backup]
 *
 * plan    prints every old -> new move, and REFUSES (exit 1) if Atlas holds a
 *         collection that is neither in the layout nor on NOT_MIGRATED — so a
 *         collection can never be left behind by oversight.
 * backup  EJSON of every collection on BOTH servers -> backups/migration-<ts>/
 * copy    per move: create the target collection, create the source's indexes,
 *         insert what the target lacks, replace a target document that differs.
 *         Before the switch Atlas is the live database, so its copy wins.
 *         Ends with `verify`.
 * verify  per move: same ids, byte-identical documents (SHA-256 of the BSON),
 *         same index keys. Then lists everything on the target that is not part
 *         of the layout (for a person to remove). Exit 1 on any difference.
 * sync    the catch-up AFTER the live backend points at the target: inserts
 *         what the target lacks, replaces only when the source copy is NEWER
 *         (updatedAt) — an edit made on the target after the switch is kept.
 *
 * Credentials come only from the environment — never commit a URI.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient, BSON } = require('mongodb');
const layout = require('../src/config/dataLayout');

const { EJSON } = BSON;

const SOURCE_URI = process.env.SOURCE_URI;
const TARGET_URI = process.env.TARGET_URI;
const MODE = process.argv[2];
const CONFIRM = process.argv.includes('--confirm');
const SKIP_BACKUP = process.argv.includes('--skip-backup');

/*
 * ON ATLAS, AND DELIBERATELY NOT MIGRATED — checked against every model, every
 * raw `.collection()` call and every write path in src/ (2026-10-01):
 *   membersdb (whole database)          12 empty collections; no code reads it
 *   locations, additional forms 1 to 4,
 *   password_reset_codes, test_guizera  empty, referenced by nothing
 *   memberauths                         one `payprobe@probe.invalid` test row
 *   web users, web auth, admins         empty; legacy fallbacks never written
 */
const NOT_MIGRATED = {
    membersdb: '*',
    'activ-db': ['locations', 'additional forms 1 to 4', 'password_reset_codes', 'test_guizera',
        'memberauths', 'web users', 'web auth', 'admins'],
    adminsdb: ['admins'],
};

const SYSTEM_DBS = ['admin', 'config', 'local'];
const PLAN = layout.migrationPlan();

/* A fingerprint, not a copy — holding every document's bytes ran out of memory. */
const hash = (doc) => crypto.createHash('sha256').update(BSON.serialize(doc)).digest('base64');
const idKey = (id) => (id && id.toHexString ? id.toHexString() : EJSON.stringify(id));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const label = (m) => `${m.fromDb}.${m.fromColl}  ->  ${m.toDb}.${m.toColl}`;

const exists = async(client, db, coll) =>
    (await client.db(db).listCollections({ name: coll }, { nameOnly: true }).toArray()).length > 0;

/** Every Atlas collection is either moved or deliberately left. Anything else stops the run. */
async function checkComplete(source) {
    const moved = new Set(PLAN.map((m) => `${m.fromDb}/${m.fromColl}`));
    const unaccounted = [];
    const { databases } = await source.db('admin').admin().listDatabases();
    const NEW_LAYOUT = Object.values(layout.DATABASES);
    for (const { name: db } of databases) {
        if (SYSTEM_DBS.includes(db)) continue;
        /*
         * New-layout databases on the SOURCE are not a source. They appear when
         * the new code is started against Atlas: on boot it seeds default plans
         * and legal pages into them — defaults, not data (2026-10-01: a local
         * server did exactly this). Copying them would overwrite the real,
         * edited plans with stale defaults. Said out loud, never skipped quietly.
         */
        if (NEW_LAYOUT.includes(db)) {
            console.log(`  note: Atlas has new-layout database '${db}' (startup seeds) — not a source, not copied`);
            continue;
        }
        const skip = NOT_MIGRATED[db];
        if (skip === '*') continue;
        for (const { name } of await source.db(db).listCollections({}, { nameOnly: true }).toArray()) {
            if (moved.has(`${db}/${name}`)) continue;
            if (Array.isArray(skip) && skip.includes(name)) continue;
            unaccounted.push(`${db}.${name}`);
        }
    }
    if (unaccounted.length) {
        console.error(`\nREFUSING: Atlas has collection(s) neither in config/dataLayout.js nor on NOT_MIGRATED:\n  ${unaccounted.join('\n  ')}`);
        console.error('Add each to the layout (if the app uses it) or to NOT_MIGRATED (if it is junk), then re-run.');
        return false;
    }
    console.log('Complete: every Atlas collection is either moved by the layout or deliberately left.');
    return true;
}

async function backup(source, target) {
    const dir = path.join(__dirname, '..', 'backups', `migration-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [who, client] of [['atlas', source], ['dokploy', target]]) {
        const { databases } = await client.db('admin').admin().listDatabases();
        for (const { name: db } of databases) {
            if (SYSTEM_DBS.includes(db)) continue;
            for (const { name } of await client.db(db).listCollections({}, { nameOnly: true }).toArray()) {
                const out = fs.createWriteStream(path.join(dir, `${who}__${db}__${name.replace(/[^\w.-]+/g, '_')}.ejson`));
                let n = 0;
                for await (const doc of client.db(db).collection(name).find({}, { batchSize: 50 })) {
                    out.write(EJSON.stringify(doc, { relaxed: false }) + '\n');
                    n += 1;
                }
                await new Promise((r) => out.end(r));
                console.log(`  backup ${who} ${db}.${name}: ${n}`);
            }
        }
    }
    console.log(`Backups in ${dir}`);
}

/** Create the target collection (same options) and the source's indexes. */
async function prepare(source, target, m) {
    const [info] = await source.db(m.fromDb).listCollections({ name: m.fromColl }).toArray();
    if (!(await exists(target, m.toDb, m.toColl))) {
        await target.db(m.toDb).createCollection(m.toColl, { ...((info && info.options) || {}) });
    }
    if (!info) return 0; // a model whose collection Atlas never created: an empty, indexed home
    const indexes = (await source.db(m.fromDb).collection(m.fromColl).indexes()).filter((ix) => ix.name !== '_id_');
    if (indexes.length) {
        await target.db(m.toDb).collection(m.toColl).createIndexes(indexes.map(({ v, ns, ...spec }) => spec));
    }
    return indexes.length;
}

/* A dropped connection mid-transfer (ECONNRESET and friends) is retried, not fatal. */
const isNetworkError = (err) => /ECONNRESET|ETIMEDOUT|EPIPE|socket|network|connection.*(closed|reset)|timed out|MongoNetwork|PoolCleared|ServerSelection/i
    .test(`${err && err.name} ${err && err.message} ${err && err.code}`);

/*
 * GridFS never rewrites a chunk — a file is replaced by new chunks with new
 * ids — so an existing chunk need not be downloaded again to compare it.
 * `verify` still hashes every byte of every chunk on both sides.
 */
const IMMUTABLE = new Set(['uploads.chunks']);

async function copyOne(source, target, m, { newerOnly }) {
    const ix = await prepare(source, target, m);
    const tcol = target.db(m.toDb).collection(m.toColl);
    // One cheap query for what is already there, so a resumed run is quick.
    const present = new Set();
    for await (const d of tcol.find({}, { projection: { _id: 1 }, batchSize: 1000 })) present.add(idKey(d._id));
    let inserted = 0; let replaced = 0; let same = 0; let keptNewer = 0;
    for await (const doc of source.db(m.fromDb).collection(m.fromColl).find({}, { batchSize: 20 })) {
        if (!present.has(idKey(doc._id))) { await tcol.insertOne(doc); inserted += 1; continue; }
        if (IMMUTABLE.has(m.toColl)) { same += 1; continue; }
        const have = await tcol.findOne({ _id: doc._id });
        if (hash(have) === hash(doc)) { same += 1; continue; }
        if (newerOnly) {
            const s = doc.updatedAt ? new Date(doc.updatedAt).getTime() : 0;
            const t = have.updatedAt ? new Date(have.updatedAt).getTime() : 0;
            if (s <= t) { keptNewer += 1; continue; }
        }
        await tcol.replaceOne({ _id: doc._id }, doc);
        replaced += 1;
    }
    console.log(`  ${label(m)}: +${inserted} new, ${replaced} updated, ${same} identical`
        + (keptNewer ? `, ${keptNewer} kept (newer on target)` : '') + `, ${ix} indexes`);
}

async function copy(source, target, { newerOnly = false } = {}) {
    for (const m of PLAN) {
        for (let attempt = 1; ; attempt += 1) {
            try {
                await copyOne(source, target, m, { newerOnly });
                break;
            } catch (err) {
                if (!isNetworkError(err) || attempt >= 6) throw err;
                console.log(`  ${label(m)}: connection dropped (${err.message}); retry ${attempt}/5 in ${attempt * 10}s`);
                await new Promise((r) => setTimeout(r, attempt * 10000));
            }
        }
    }
}

async function verify(source, target) {
    let problems = 0;
    let docs = 0;
    for (const m of PLAN) {
      for (let attempt = 1; ; attempt += 1) {
       try {
        const s = new Map();
        const t = new Map();
        for await (const doc of source.db(m.fromDb).collection(m.fromColl).find({}, { batchSize: 50 })) s.set(idKey(doc._id), hash(doc));
        for await (const doc of target.db(m.toDb).collection(m.toColl).find({}, { batchSize: 50 })) t.set(idKey(doc._id), hash(doc));
        let missing = 0; let differ = 0; let extra = 0;
        for (const [k, v] of s) { if (!t.has(k)) missing += 1; else if (t.get(k) !== v) differ += 1; }
        for (const k of t.keys()) if (!s.has(k)) extra += 1;
        const keys = async(client, db, coll) => (await exists(client, db, coll)
            ? (await client.db(db).collection(coll).indexes()).map((ix) => JSON.stringify(ix.key) + (ix.unique ? '!u' : '')).sort().join('|')
            : '');
        const srcIx = await keys(source, m.fromDb, m.fromColl);
        const sameIx = !srcIx || srcIx === await keys(target, m.toDb, m.toColl);
        docs += s.size;
        const ok = !missing && !differ && !extra && sameIx;
        if (!ok) problems += 1;
        console.log(`  ${ok ? 'OK  ' : 'DIFF'} ${m.toDb}.${m.toColl}: ${s.size} docs`
            + (ok ? '' : `  missing=${missing} changed=${differ} extra=${extra} indexes=${sameIx ? 'same' : 'DIFFERENT'}`));
        break;
       } catch (err) {
        if (!isNetworkError(err) || attempt >= 6) throw err;
        console.log(`  verify ${m.toDb}.${m.toColl}: connection dropped (${err.message}); retry ${attempt}/5`);
        await new Promise((r) => setTimeout(r, attempt * 10000));
       }
      }
    }

    // Anything on the target the layout does not place.
    const placed = new Set(PLAN.map((m) => `${m.toDb}/${m.toColl}`));
    const leftovers = [];
    const { databases } = await target.db('admin').admin().listDatabases();
    for (const { name: db } of databases) {
        if (SYSTEM_DBS.includes(db)) continue;
        for (const { name } of await target.db(db).listCollections({}, { nameOnly: true }).toArray()) {
            if (!placed.has(`${db}/${name}`)) leftovers.push(`${db}.${name}`);
        }
    }

    console.log(problems
        ? `\nVERIFY FAILED: ${problems} collection(s) differ.`
        : `\nVERIFIED: ${PLAN.length} collections, ${docs} documents, byte-identical, identical indexes.`);
    if (leftovers.length) {
        console.log('\nOn the target but NOT part of the layout (not deleted by this script — remove by hand):');
        leftovers.forEach((l) => console.log(`  ${l}`));
    }
    return problems === 0;
}

(async() => {
    if (!SOURCE_URI || !TARGET_URI) { console.error('Set SOURCE_URI and TARGET_URI.'); process.exit(1); }
    if (SOURCE_URI === TARGET_URI) { console.error('SOURCE_URI and TARGET_URI are the same server.'); process.exit(1); }
    if (!['plan', 'backup', 'copy', 'verify', 'sync'].includes(MODE)) { console.error('Mode: plan | backup | copy | verify | sync'); process.exit(1); }
    if (['copy', 'sync'].includes(MODE) && !CONFIRM) { console.error(`${MODE} writes to the target. Re-run with --confirm.`); process.exit(1); }

    const source = new MongoClient(SOURCE_URI, { serverSelectionTimeoutMS: 20000 });
    const target = new MongoClient(TARGET_URI, { serverSelectionTimeoutMS: 20000 });
    await source.connect();
    await target.connect();

    let ok = await checkComplete(source);
    if (MODE === 'plan') PLAN.forEach((m) => console.log(`  ${label(m)}`));
    if (ok && ['backup', 'copy', 'sync'].includes(MODE) && !SKIP_BACKUP) await backup(source, target);
    if (ok && MODE === 'copy') { await copy(source, target); ok = await verify(source, target); }
    if (ok && MODE === 'sync') await copy(source, target, { newerOnly: true });
    if (ok && MODE === 'verify') ok = await verify(source, target);

    await source.close();
    await target.close();
    process.exit(ok ? 0 : 1);
})().catch((err) => { console.error('FAILED:', err && err.message); process.exit(1); });
