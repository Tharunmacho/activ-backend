/**
 * Tidy the production database to exactly what the application uses.
 *
 *   MONGODB_URI='mongodb://…:27018/?authSource=admin&directConnection=true' node scripts/cleanup-production-db.js            # report only
 *   MONGODB_URI='…'                                                                                         node scripts/cleanup-production-db.js --confirm  # apply
 *
 * Removes, and only after re-checking each at run time:
 *
 *   1. the OLD-LAYOUT copies left by the migration — databases `activ-db` and
 *      `adminsdb`, and `activ_members.member_business_details` /
 *      `member_financial_details` (their real homes are in activ_business).
 *      Dropped only if EVERY document in them also exists at its new place
 *      (config/dataLayout.js). The known exceptions — one unreferenced gallery
 *      image of 25 Sep (saved to backups/orphan-image-2026-10-01) and the
 *      `memberauths` probe row — are allowed; anything else stops the run.
 *
 *   2. ORPHANED APPLICATION FORMS — personal / business / financial /
 *      declaration rows whose owner exists nowhere (no member, login or
 *      application). Left by accounts deleted under older builds and by test
 *      runs (2026-09-12…17). The current member delete removes these itself.
 *
 * Everything removed is first written to backups/cleanup-<timestamp>/ as EJSON
 * (the old-layout GridFS chunks excepted: they are byte-identical to
 * activ_files and already in the migration backup). Never touches `admin`,
 * `config` or `local`.
 */
const fs = require('fs');
const path = require('path');
const { MongoClient, BSON } = require('mongodb');
const layout = require('../src/config/dataLayout');

const { EJSON } = BSON;
const URI = process.env.MONGODB_URI;
const CONFIRM = process.argv.includes('--confirm');
const idKey = (id) => (id && id.toHexString ? id.toHexString() : EJSON.stringify(id));

/* Old-layout documents allowed to exist only there (see header). */
const KNOWN_OLD_ONLY = new Set(['6ab6597d78153298124a7f16', '6ab6597d78153298124a7f17']);
const JUNK_OLD_COLLECTIONS = new Set(['activ-db/memberauths']);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(__dirname, '..', 'backups', `cleanup-${stamp}`);

const backup = async(cursor, file) => {
    fs.mkdirSync(backupDir, { recursive: true });
    const out = fs.createWriteStream(path.join(backupDir, file));
    let n = 0;
    for await (const doc of cursor) { out.write(EJSON.stringify(doc, { relaxed: false }) + '\n'); n += 1; }
    await new Promise((r) => out.end(r));
    return n;
};

(async() => {
    if (!URI) { console.error('Set MONGODB_URI (the EXTERNAL connection string).'); process.exit(1); }
    const c = new MongoClient(URI, { serverSelectionTimeoutMS: 20000 });
    await c.connect();
    console.log(CONFIRM ? '\nMode: APPLY' : '\nMode: REPORT ONLY (add --confirm to apply)');
    const plan = layout.migrationPlan();
    const existingDbs = (await c.db('admin').admin().listDatabases()).databases.map((d) => d.name);
    let blocked = false;

    /* ---------------------------------------------------- 1. old-layout copies */
    console.log('\n1. Old-layout duplicates');
    const dropDbs = [];
    for (const db of ['activ-db', 'adminsdb']) {
        if (!existingDbs.includes(db)) { console.log(`   ${db}: already gone`); continue; }
        let onlyOld = 0;
        for (const { name } of await c.db(db).listCollections({}, { nameOnly: true }).toArray()) {
            if (JUNK_OLD_COLLECTIONS.has(`${db}/${name}`)) continue;
            const move = plan.find((m) => m.fromDb === db && m.fromColl === name);
            if (!move) { console.log(`   ${db}.${name}: not in the layout — treated as junk`); continue; }
            const have = new Set();
            for await (const d of c.db(move.toDb).collection(move.toColl).find({}, { projection: { _id: 1 } })) have.add(idKey(d._id));
            for await (const d of c.db(db).collection(name).find({}, { projection: { _id: 1 } })) {
                const k = idKey(d._id);
                if (!have.has(k) && !KNOWN_OLD_ONLY.has(k)) { onlyOld += 1; console.log(`   STOP: ${db}.${name} ${k} exists only in the old copy`); }
            }
        }
        if (onlyOld) { blocked = true; continue; }
        console.log(`   ${db}: every document is in the new layout — ${CONFIRM ? 'dropping' : 'would drop'}`);
        dropDbs.push(db);
    }
    const misplaced = [['member_business_details', 'activ_business', 'business_details'], ['member_financial_details', 'activ_business', 'business_financials']];
    const dropCols = [];
    for (const [name, realDb, realCol] of misplaced) {
        const exists = (await c.db('activ_members').listCollections({ name }, { nameOnly: true }).toArray()).length;
        if (!exists) { console.log(`   activ_members.${name}: already gone`); continue; }
        const have = new Set();
        for await (const d of c.db(realDb).collection(realCol).find({}, { projection: { _id: 1 } })) have.add(idKey(d._id));
        let onlyOld = 0;
        for await (const d of c.db('activ_members').collection(name).find({}, { projection: { _id: 1 } })) if (!have.has(idKey(d._id))) onlyOld += 1;
        if (onlyOld) { blocked = true; console.log(`   STOP: activ_members.${name} has ${onlyOld} document(s) not in ${realDb}.${realCol}`); continue; }
        console.log(`   activ_members.${name}: every document is in ${realDb}.${realCol} — ${CONFIRM ? 'dropping' : 'would drop'}`);
        dropCols.push(name);
    }

    /* ------------------------------------------------------- 2. orphaned forms */
    console.log('\n2. Application forms whose owner no longer exists');
    const col = (model) => { const [area, name] = layout.MODELS[model]; return c.db(layout.dbName(area)).collection(name); };
    const owners = new Set();
    for (const [model, fields] of [['MemberDetails', ['_id', 'userId']], ['MemberAuth', ['_id']], ['Application', ['_id', 'userId']]]) {
        for await (const d of col(model).find({}, { projection: Object.fromEntries(fields.map((f) => [f, 1])) })) {
            fields.forEach((f) => { if (d[f]) owners.add(String(d[f])); });
        }
    }
    const orphanPlan = [];
    for (const [model, fields] of [['PersonalInfo1', ['userId']], ['BusinessInfo', ['userId']], ['MemberFinancialInfo', ['memberId', 'userId']], ['MemberDeclaration', ['userId', 'memberId']]]) {
        const ids = [];
        for await (const d of col(model).find({})) {
            if (fields.every((f) => !d[f] || !owners.has(String(d[f])))) ids.push(d._id);
        }
        console.log(`   ${layout.MODELS[model][1]}: ${ids.length} orphaned row(s)`);
        if (ids.length) orphanPlan.push([model, ids]);
    }

    if (blocked) {
        console.log('\nSTOPPED: something exists only in an old copy. Nothing was changed — investigate before re-running.');
        await c.close(); process.exit(1);
    }

    if (!CONFIRM) {
        console.log('\nNothing was changed. Re-run with --confirm to apply.');
        await c.close(); process.exit(0);
    }

    /* ----------------------------------------------------------------- apply */
    for (const db of dropDbs) {
        for (const { name } of await c.db(db).listCollections({}, { nameOnly: true }).toArray()) {
            if (/^uploads\./.test(name)) continue; // byte-identical in activ_files + the migration backup
            await backup(c.db(db).collection(name).find({}), `${db}__${name.replace(/[^\w.-]+/g, '_')}.ejson`);
        }
        await c.db(db).dropDatabase();
        console.log(`   dropped database ${db}`);
    }
    for (const name of dropCols) {
        await backup(c.db('activ_members').collection(name).find({}), `activ_members__${name}.ejson`);
        await c.db('activ_members').collection(name).drop();
        console.log(`   dropped activ_members.${name}`);
    }
    for (const [model, ids] of orphanPlan) {
        const n = await backup(col(model).find({ _id: { $in: ids } }), `orphans__${layout.MODELS[model][1]}.ejson`);
        const r = await col(model).deleteMany({ _id: { $in: ids } });
        console.log(`   removed ${r.deletedCount} orphaned ${layout.MODELS[model][1]} row(s) (backed up ${n})`);
    }
    const left = (await c.db('admin').admin().listDatabases()).databases.map((d) => d.name).sort();
    console.log(`\nBackups: ${backupDir}`);
    console.log(`Databases now: ${left.join(', ')}`);
    await c.close();
})().catch((err) => { console.error('FAILED:', err && err.message); process.exit(1); });
