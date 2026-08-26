#!/usr/bin/env node
/**
 * Lift region fields out of `meta` and onto the document itself.
 *
 * Two document shapes coexist in the admin collections. Everything this
 * application writes puts the region at the top level:
 *
 *     { state: 'Tamil Nadu', district: 'Ariyalur', block: 'Andimadam' }
 *
 * A handful of older records instead carry it under `meta`, with the top-level
 * fields absent entirely, and spell the role `BlockAdmin` rather than
 * `block_admin`. Coverage — the thing that decides which blocks an applicant can
 * pick — reads the top-level fields, so those records staff nothing: the region
 * they name is invisible to the registration dropdown.
 *
 * That stayed hidden while each of them had a twin in the unified `admins`
 * collection carrying the same region at the top level. Deduplicating on email
 * removed the twin, the meta-only record was all that was left, and four
 * Ariyalur blocks dropped out of the dropdown.
 *
 * This copies `meta.{state,district,block}` up to the top level where the top
 * level is missing, and normalises the role. `meta` is left in place — nothing
 * reads it any more, but nothing is gained by destroying it either.
 *
 * It also stamps `createdVia` on anything still missing it. That field is the
 * discriminator between real staffing and the ~7,700-record scaffold seed, and
 * unstamped records are excluded from every count, the region tree and the
 * coverage that decides which blocks an applicant can pick. The scaffold is
 * gone, so an unstamped record left today is simply an account that predates
 * stamping — real, signed into, and wrongly invisible. Leaving it unstamped is
 * why the Super Admin screen reported 0 state admins against 1 in the database.
 *
 * `legacy_pre_migration` says exactly that: a genuine account that existed
 * before the stamp did, distinct from `migrated_from_admins`, which means the
 * migration script moved it.
 *
 * Usage:
 *   node scripts/repair-admin-region-fields.js            # dry run
 *   node scripts/repair-admin-region-fields.js --confirm  # apply
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const CONFIRM = process.argv.slice(2).includes('--confirm');

const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const normalizeRole = (value) => {
    const role = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (role === 'blockadmin') return 'block_admin';
    if (role === 'districtadmin') return 'district_admin';
    if (role === 'stateadmin') return 'state_admin';
    if (role === 'superadmin') return 'super_admin';
    return role;
};

const ROLE_FOR_COLLECTION = {
    blockadmins: 'block_admin',
    districtadmins: 'district_admin',
    stateadmins: 'state_admin',
    superadmins: 'super_admin'
};

(async () => {
    console.log(`Mode: ${CONFIRM ? 'APPLY' : 'DRY RUN (nothing will change)'}\n`);

    const uri = process.env.ADMINS_DB_URI || process.env.MONGODB_URI;
    if (!uri) throw new Error('No Mongo URI in the environment');

    const adminsDb = await mongoose.createConnection(uri, { dbName: 'adminsdb' }).asPromise();
    const mainDb = await mongoose.createConnection(uri).asPromise();

    const sources = [
        ...['blockadmins', 'districtadmins', 'stateadmins', 'superadmins']
            .map(name => ({ name, handle: adminsDb.db.collection(name) })),
        { name: 'admins', handle: mainDb.db.collection('admins') }
    ];

    const repairs = [];

    for (const source of sources) {
        const docs = await source.handle.find({}).toArray().catch(() => []);
        docs.forEach((doc) => {
            const meta = doc.meta || {};
            const $set = {};

            ['state', 'district', 'block'].forEach((field) => {
                const top = clean(doc[field]);
                const fromMeta = clean(meta[field]);
                if (!top && fromMeta) $set[field] = fromMeta;
            });

            const role = normalizeRole(doc.role || doc.adminType);
            const expected = ROLE_FOR_COLLECTION[source.name] || role;
            if (role && role !== clean(doc.role)) $set.role = role;
            else if (!role && expected) $set.role = expected;

            if (!clean(doc.createdVia)) $set.createdVia = 'legacy_pre_migration';

            if (Object.keys($set).length === 0) return;
            repairs.push({ source, _id: doc._id, email: doc.email, $set });
        });
    }

    if (repairs.length === 0) {
        console.log('Every admin document already carries its region at the top level.');
        process.exit(0);
    }

    repairs.forEach((r) => {
        console.log(`  ${String(r.email || r._id).padEnd(52)} [${r.source.name}]`);
        console.log(`      ${JSON.stringify(r.$set)}`);
    });
    console.log(`\n${repairs.length} document(s) to repair.`);

    if (!CONFIRM) {
        console.log('\nDRY RUN — nothing was changed. Re-run with --confirm to apply.');
        process.exit(0);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const backup = path.join(dir, `admin-region-repair-${stamp}.json`);

    const before = [];
    for (const r of repairs) {
        const doc = await r.source.handle.findOne({ _id: r._id }).catch(() => null);
        if (doc) before.push({ collection: r.source.name, document: doc });
    }
    fs.writeFileSync(backup, JSON.stringify(before, null, 2));
    console.log(`\nBackup written to\n  ${backup}`);

    let updated = 0;
    for (const r of repairs) {
        const result = await r.source.handle.updateOne({ _id: r._id }, { $set: r.$set }).catch(() => null);
        updated += (result && result.modifiedCount) || 0;
    }

    console.log(`\nRepaired ${updated} document(s).`);
    process.exit(0);
})().catch((err) => {
    console.error('FAILED:', err && err.message);
    process.exit(1);
});
