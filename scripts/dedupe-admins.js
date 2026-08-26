#!/usr/bin/env node
/**
 * Remove duplicate admin accounts.
 *
 * "Duplicate" covers two genuinely different problems, and they are handled
 * separately because only one of them is unambiguous:
 *
 *   A. THE SAME EMAIL IN TWO COLLECTIONS. One account, stored twice — the
 *      migration copied real accounts out of the unified `admins` collection
 *      into the segregated per-tier ones and deliberately left the originals
 *      behind. Login scans every collection, so the copy is a live second
 *      credential for the same person: edit the account and only one copy
 *      changes, delete it from the UI and the other still signs in. The
 *      segregated copy is kept because that is where the rest of the platform
 *      reads and writes; the leftover is deleted.
 *
 *      An email that exists ONLY in `admins` is never touched. That collection
 *      still holds accounts predating the split, and deleting one would destroy
 *      a working login.
 *
 *   B. DIFFERENT PEOPLE ON THE SAME REGION. Three separate accounts for the
 *      Tiruvannamalai district, each with its own email. The platform supports
 *      this on purpose — co-admins share one geofenced queue — so this is not
 *      corruption, it is a staffing decision, and which account survives is a
 *      judgement the script has to make explicitly rather than by accident of
 *      iteration order:
 *
 *        1. an account that has actually been signed into (latest login wins)
 *        2. one a human created through the Super Admin UI
 *        3. one migrated from the old collection — a real pre-existing account
 *        4. one loaded from a CSV
 *        5. a generated pilot-seed placeholder
 *        6. an unstamped scaffold record
 *
 *      Ties break towards the older account.
 *
 * Every affected region is re-checked afterwards: the plan is refused outright
 * if it would leave any region with no admin at all, because a block with no
 * block admin disappears from the applicant's registration dropdown.
 *
 * Usage:
 *   node scripts/dedupe-admins.js               # dry run, changes nothing
 *   node scripts/dedupe-admins.js --confirm     # apply
 *   node scripts/dedupe-admins.js --emails-only # only case A, the safe half
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const EMAILS_ONLY = args.includes('--emails-only');

const key = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const normalizeRole = (value) => {
    const role = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (role === 'blockadmin') return 'block_admin';
    if (role === 'districtadmin') return 'district_admin';
    if (role === 'stateadmin') return 'state_admin';
    if (role === 'superadmin') return 'super_admin';
    return role;
};

/** Region lives top-level on new documents and under `meta` on older ones. */
const regionOf = (doc = {}) => {
    const meta = doc.meta || {};
    return {
        state: key(doc.state || meta.state),
        district: key(doc.district || meta.district),
        block: key(doc.block || meta.block)
    };
};

const SEGREGATED = ['blockadmins', 'districtadmins', 'stateadmins', 'superadmins'];

const RANK = {
    super_admin_ui: 2,
    migrated_from_admins: 3,
    bulk_csv: 4,
    tn_pilot_seed: 5
};

/** Lower sorts first, and first is kept. */
const priority = (row) => {
    if (row.lastLoginAt) return 1;
    return RANK[row.createdVia] || 6;
};

const better = (a, b) => {
    const pa = priority(a);
    const pb = priority(b);
    if (pa !== pb) return pa - pb;
    // Both have logged in: the more recent session is the live account.
    if (a.lastLoginAt && b.lastLoginAt) return new Date(b.lastLoginAt) - new Date(a.lastLoginAt);
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
};

const line = (row) => `${row.email} [${row.collection}${row.createdVia ? ', ' + row.createdVia : ', unstamped'}` +
    `${row.lastLoginAt ? ', signed in ' + new Date(row.lastLoginAt).toISOString().slice(0, 10) : ''}]`;

(async () => {
    console.log(`Mode: ${CONFIRM ? 'APPLY (documents will be deleted)' : 'DRY RUN (nothing will change)'}`);
    if (EMAILS_ONLY) console.log('Scope: duplicate emails only — same-region accounts left alone.\n');
    else console.log('');

    const uri = process.env.ADMINS_DB_URI || process.env.MONGODB_URI;
    if (!uri) throw new Error('No Mongo URI in the environment');

    const adminsDb = await mongoose.createConnection(uri, { dbName: 'adminsdb' }).asPromise();
    const mainDb = await mongoose.createConnection(uri).asPromise();

    const handles = [];
    SEGREGATED.forEach(name => handles.push({
        collection: name, segregated: true, handle: adminsDb.db.collection(name)
    }));
    handles.push({ collection: 'admins', segregated: false, handle: mainDb.db.collection('admins') });

    const rows = [];
    for (const source of handles) {
        const docs = await source.handle.find({}).toArray().catch(() => []);
        docs.forEach(doc => rows.push({
            _id: doc._id,
            collection: source.collection,
            segregated: source.segregated,
            handle: source.handle,
            email: key(doc.email),
            fullName: doc.fullName || doc.name || '',
            role: normalizeRole(doc.role || doc.adminType),
            ...regionOf(doc),
            createdVia: doc.createdVia || '',
            createdAt: doc.createdAt || null,
            lastLoginAt: doc.lastLoginAt || null
        }));
    }
    console.log(`Scanned ${rows.length} admin document(s) across ${handles.length} collection(s).\n`);

    const doomed = new Map(); // _id string -> { row, reason }
    const condemn = (row, reason) => {
        const id = row._id.toString();
        if (!doomed.has(id)) doomed.set(id, { row, reason });
    };

    // ---------------------------------------------------------------- case A
    console.log('='.repeat(72));
    console.log('A — the same email stored in more than one collection');
    console.log('='.repeat(72));

    const byEmail = new Map();
    rows.forEach(row => {
        if (!row.email) return;
        if (!byEmail.has(row.email)) byEmail.set(row.email, []);
        byEmail.get(row.email).push(row);
    });

    let caseA = 0;
    [...byEmail.entries()]
        .filter(([, group]) => group.length > 1)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .forEach(([email, group]) => {
            // Prefer a segregated copy; among equals fall back to the same
            // ranking used for region duplicates.
            const ordered = [...group].sort((a, b) => {
                if (a.segregated !== b.segregated) return a.segregated ? -1 : 1;
                return better(a, b);
            });
            const [keep, ...drop] = ordered;
            console.log(`\n  ${email}`);
            console.log(`    keep   ${line(keep)}`);
            drop.forEach(row => {
                console.log(`    delete ${line(row)}`);
                condemn(row, 'duplicate email');
                caseA += 1;
            });
        });
    if (caseA === 0) console.log('\n  None.');
    console.log(`\n  ${caseA} redundant copy/copies.`);

    // ---------------------------------------------------------------- case B
    let caseB = 0;
    const regionGroups = new Map();

    if (!EMAILS_ONLY) {
        console.log(`\n${'='.repeat(72)}`);
        console.log('B — different accounts covering the same region');
        console.log('='.repeat(72));

        rows.forEach(row => {
            if (doomed.has(row._id.toString())) return;
            if (!row.role) return;
            let scope;
            if (row.role === 'block_admin') scope = `${row.district}|${row.block}`;
            else if (row.role === 'district_admin') scope = row.district;
            else if (row.role === 'state_admin') scope = row.state;
            else return; // super admins are not geofenced
            if (!scope || scope === '|') return;

            const k = `${row.role}|${scope}`;
            if (!regionGroups.has(k)) regionGroups.set(k, []);
            regionGroups.get(k).push(row);
        });

        [...regionGroups.entries()]
            .filter(([, group]) => new Set(group.map(r => r.email)).size > 1)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .forEach(([k, group]) => {
                const ordered = [...group].sort(better);
                const [keep, ...drop] = ordered;
                console.log(`\n  ${k.replace(/\|/g, ' / ')}`);
                console.log(`    keep   ${line(keep)}`);
                drop.forEach(row => {
                    console.log(`    delete ${line(row)}`);
                    condemn(row, 'same region');
                    caseB += 1;
                });
            });
        if (caseB === 0) console.log('\n  None.');
        console.log(`\n  ${caseB} surplus account(s).`);
    }

    // ------------------------------------------------------------- safety net
    const survivors = rows.filter(row => !doomed.has(row._id.toString()));
    const stranded = [];
    [...regionGroups.entries()].forEach(([k, group]) => {
        const left = group.filter(row => !doomed.has(row._id.toString()));
        if (group.length > 0 && left.length === 0) stranded.push(k);
    });

    console.log(`\n${'='.repeat(72)}`);
    console.log('SUMMARY');
    console.log('='.repeat(72));
    console.log(`  scanned   ${rows.length}`);
    console.log(`  delete    ${doomed.size}  (${caseA} duplicate email, ${caseB} same region)`);
    console.log(`  remaining ${survivors.length}`);
    console.log(`  regions left unstaffed by this plan: ${stranded.length}`);

    if (stranded.length > 0) {
        console.log('\n  REFUSED — these regions would end up with no admin:');
        stranded.forEach(k => console.log('   ', k));
        process.exit(1);
    }

    if (doomed.size === 0) {
        console.log('\nNothing to do.');
        process.exit(0);
    }

    if (!CONFIRM) {
        console.log('\nDRY RUN — nothing was changed. Re-run with --confirm to apply.');
        process.exit(0);
    }

    // ---------------------------------------------------------------- apply
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const backup = path.join(dir, `admin-dedupe-${stamp}.json`);

    const payload = [];
    for (const { row, reason } of doomed.values()) {
        const doc = await row.handle.findOne({ _id: row._id }).catch(() => null);
        if (doc) payload.push({ collection: row.collection, reason, document: doc });
    }
    fs.writeFileSync(backup, JSON.stringify(payload, null, 2));
    console.log(`\nBackup of every document about to be deleted:\n  ${backup}`);

    let deleted = 0;
    for (const { row } of doomed.values()) {
        const result = await row.handle.deleteOne({ _id: row._id }).catch(() => null);
        deleted += (result && result.deletedCount) || 0;
    }

    console.log(`\nDeleted ${deleted} document(s).`);
    console.log('Region dropdowns are derived live, so they reflect this on the next request.');
    process.exit(0);
})().catch(err => {
    console.error('FAILED:', err && err.message);
    process.exit(1);
});
