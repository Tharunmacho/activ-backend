#!/usr/bin/env node
/**
 * Migrate to the segregated admin architecture, with a Tamil Nadu pilot seed.
 *
 * Five phases, in this order for a reason — the extraction has to happen before
 * the wipe, because the wipe destroys the data it reads:
 *
 *   1. EXTRACT  Pull the Tamil Nadu districts and blocks out of the legacy
 *               scaffold and write them to a JSON file.
 *   2. BACKUP   Dump every document that is about to be moved or deleted.
 *   3. MIGRATE  Copy the real accounts out of the unified `admins` collection
 *               into the segregated per-tier collections.
 *   4. WIPE     Delete the scaffold placeholders — every state, district and
 *               block in India, pre-created and never used.
 *   5. SEED     Recreate the Tamil Nadu regions as real, stamped admin accounts
 *               so the pilot's dropdowns are populated from day one.
 *
 * Nothing outside the admin collections is touched. Applications, members and
 * the audit log are not read or written.
 *
 * Usage:
 *   node scripts/migrate-to-segregated-admins.js               # dry run
 *   node scripts/migrate-to-segregated-admins.js --confirm     # apply
 *   node scripts/migrate-to-segregated-admins.js --confirm --skip-seed
 *   node scripts/migrate-to-segregated-admins.js --confirm --state "Kerala"
 *
 * After a successful run the generated pilot credentials are written to
 * `backups/pilot-credentials-<timestamp>.csv`. That file is the only copy —
 * passwords are stored as bcrypt hashes and cannot be recovered from the
 * database.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const { generatePassword } = require('../src/core/utils/password');

const TIER_COLLECTIONS = ['blockadmins', 'districtadmins', 'stateadmins', 'superadmins'];

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const SKIP_SEED = args.includes('--skip-seed');

const stateArgIndex = args.indexOf('--state');
const PILOT_STATE = stateArgIndex !== -1 ? (args[stateArgIndex + 1] || 'Tamil Nadu') : 'Tamil Nadu';

const lower = (value) => String(value || '').trim().toLowerCase();
const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const slug = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');

const ROLE_FOR_COLLECTION = {
    blockadmins: 'block_admin',
    districtadmins: 'district_admin',
    stateadmins: 'state_admin',
    superadmins: 'super_admin'
};

const COLLECTION_FOR_ROLE = {
    block_admin: 'blockadmins',
    district_admin: 'districtadmins',
    state_admin: 'stateadmins',
    super_admin: 'superadmins'
};

const normalizeRole = (value) => {
    const role = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (role === 'blockadmin' || role === 'block_admin') return 'block_admin';
    if (role === 'districtadmin' || role === 'district_admin') return 'district_admin';
    if (role === 'stateadmin' || role === 'state_admin') return 'state_admin';
    if (role === 'superadmin' || role === 'super_admin') return 'super_admin';
    return role;
};

/** Read a region off a document that may keep it top-level or under `meta`. */
const regionOf = (doc = {}) => ({
    state: clean(doc.state || (doc.meta && doc.meta.state)),
    district: clean(doc.district || (doc.meta && doc.meta.district)),
    block: clean(doc.block || (doc.meta && doc.meta.block))
});

const banner = (text) => console.log(`\n${'='.repeat(72)}\n${text}\n${'='.repeat(72)}`);

const main = async() => {
    const primaryUri = process.env.MONGODB_URI;
    if (!primaryUri) {
        console.error('MONGODB_URI is not set. Aborting.');
        process.exit(1);
    }

    const legacyUri = primaryUri.replace(/\/activ-db(\?|$)/, '/adminsdb$1');
    if (legacyUri === primaryUri) {
        console.error('Could not derive the adminsdb URI from MONGODB_URI. Aborting rather than guessing.');
        process.exit(1);
    }

    await mongoose.connect(primaryUri);
    const legacy = await mongoose.createConnection(legacyUri).asPromise();

    const primaryAdmins = mongoose.connection.db.collection('admins');
    const tier = (name) => legacy.db.collection(name);

    console.log(`\nMode: ${CONFIRM ? 'APPLY (writes will happen)' : 'DRY RUN (nothing will change)'}`);
    console.log(`Pilot state: ${PILOT_STATE}`);

    // ---------------------------------------------------------------------
    banner('PHASE 1 — Extract the pilot regions (before anything is destroyed)');

    const pilotBlockDocs = await tier('blockadmins').find({}).toArray();
    const pilotDistrictDocs = await tier('districtadmins').find({}).toArray();

    const districtsInPilot = new Map(); // districtKey -> canonical name
    const blocksInPilot = new Map();    // "district|block" -> { district, block }

    pilotDistrictDocs.forEach((doc) => {
        const region = regionOf(doc);
        if (lower(region.state) !== lower(PILOT_STATE) || !region.district) return;
        if (!districtsInPilot.has(lower(region.district))) {
            districtsInPilot.set(lower(region.district), region.district);
        }
    });

    pilotBlockDocs.forEach((doc) => {
        const region = regionOf(doc);
        if (lower(region.state) !== lower(PILOT_STATE) || !region.district || !region.block) return;
        if (!districtsInPilot.has(lower(region.district))) {
            districtsInPilot.set(lower(region.district), region.district);
        }
        const composite = `${lower(region.district)}|${lower(region.block)}`;
        if (!blocksInPilot.has(composite)) {
            blocksInPilot.set(composite, { district: region.district, block: region.block });
        }
    });

    const extraction = {
        state: PILOT_STATE,
        extractedAt: new Date().toISOString(),
        districts: [...districtsInPilot.values()].sort((a, b) => a.localeCompare(b)),
        blocks: [...blocksInPilot.values()].sort((a, b) =>
            a.district.localeCompare(b.district) || a.block.localeCompare(b.block))
    };

    console.log(`  ${extraction.districts.length} district(s) and ${extraction.blocks.length} block(s) found for ${PILOT_STATE}.`);
    console.log(`  e.g. ${extraction.blocks.slice(0, 3).map(b => `${b.block} (${b.district})`).join(', ')}`);

    const outDir = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    const extractionPath = path.join(outDir, `pilot-regions-${slug(PILOT_STATE)}-${stamp}.json`);
    if (CONFIRM) {
        fs.writeFileSync(extractionPath, JSON.stringify(extraction, null, 2), 'utf8');
        console.log(`  Written to ${extractionPath}`);
    }

    // ---------------------------------------------------------------------
    banner('PHASE 2 — Identify what moves and what goes');

    const realAdmins = await primaryAdmins.find({}).toArray();
    console.log(`  Unified 'admins' collection: ${realAdmins.length} real account(s) to migrate.`);

    const scaffold = {};
    let scaffoldTotal = 0;
    const protectedEmails = new Set(realAdmins.map(doc => lower(doc.email)).filter(Boolean));

    for (const name of TIER_COLLECTIONS) {
        const docs = await tier(name).find({}).toArray();
        // A record is scaffold when the application never stamped it. Anything
        // this app created carries `createdVia`, and anything whose email also
        // appears in the real roster is spared regardless.
        const removable = docs.filter(doc => !doc.createdVia && !protectedEmails.has(lower(doc.email)));
        scaffold[name] = removable;
        scaffoldTotal += removable.length;
        console.log(`  ${name.padEnd(16)} ${String(docs.length).padStart(5)} total | ${String(removable.length).padStart(5)} scaffold to delete | ${docs.length - removable.length} kept`);
    }

    // ---------------------------------------------------------------------
    banner('PHASE 3 — Plan the pilot seed');

    const seedPlan = [];
    if (!SKIP_SEED) {
        extraction.districts.forEach((district) => {
            seedPlan.push({
                role: 'district_admin',
                fullName: `${district} District Admin`,
                email: `district.${slug(district)}.${slug(PILOT_STATE)}@activ.com`,
                state: PILOT_STATE,
                district,
                block: ''
            });
        });
        extraction.blocks.forEach(({ district, block }) => {
            seedPlan.push({
                role: 'block_admin',
                fullName: `${block} Block Admin`,
                email: `block.${slug(block)}.${slug(district)}.${slug(PILOT_STATE)}@activ.com`,
                state: PILOT_STATE,
                district,
                block
            });
        });

        // A state admin for the pilot, unless a real one already covers it.
        const hasStateAdmin = realAdmins.some(doc =>
            normalizeRole(doc.role || doc.adminType) === 'state_admin' &&
            lower(regionOf(doc).state) === lower(PILOT_STATE));

        if (!hasStateAdmin) {
            seedPlan.unshift({
                role: 'state_admin',
                fullName: `${PILOT_STATE} State Admin`,
                email: `state.${slug(PILOT_STATE)}@activ.com`,
                state: PILOT_STATE,
                district: '',
                block: ''
            });
        }
    }

    // A seeded account whose email already belongs to a real admin is dropped:
    // that region is already staffed by a person, and overwriting them would be
    // the worst possible outcome of a "seed" step.
    const seedFinal = seedPlan.filter(row => !protectedEmails.has(lower(row.email)));
    const seedSkipped = seedPlan.length - seedFinal.length;

    console.log(`  ${seedFinal.length} pilot account(s) to create${seedSkipped > 0 ? `, ${seedSkipped} skipped (a real admin already holds that email)` : ''}.`);
    if (SKIP_SEED) console.log('  (--skip-seed given, nothing will be seeded)');

    // ---------------------------------------------------------------------
    banner('SUMMARY');
    console.log(`  migrate  ${String(realAdmins.length).padStart(5)} real admin(s) from 'admins' into the per-tier collections`);
    console.log(`  delete   ${String(scaffoldTotal).padStart(5)} scaffold placeholder(s)`);
    console.log(`  create   ${String(seedFinal.length).padStart(5)} ${PILOT_STATE} pilot admin(s)`);

    if (!CONFIRM) {
        console.log('\nDRY RUN — nothing was changed. Re-run with --confirm to apply.\n');
        await mongoose.disconnect();
        await legacy.close();
        return;
    }

    // ---------------------------------------------------------------------
    banner('BACKUP');

    const backupPath = path.join(outDir, `admin-migration-${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({
        migratedAt: new Date().toISOString(),
        unifiedAdmins: realAdmins,
        scaffold
    }, null, 2), 'utf8');
    console.log(`  ${backupPath}`);

    // ---------------------------------------------------------------------
    banner('APPLYING');

    // -- migrate real admins ------------------------------------------------
    let migrated = 0;
    let migrateSkipped = 0;

    for (const doc of realAdmins) {
        const role = normalizeRole(doc.role || doc.adminType);
        const name = COLLECTION_FOR_ROLE[role];
        if (!name) {
            migrateSkipped += 1;
            continue;
        }

        const region = regionOf(doc);
        const existing = await tier(name).findOne({ email: lower(doc.email) });
        if (existing) {
            migrateSkipped += 1;
            continue;
        }

        const count = await tier(name).estimatedDocumentCount().catch(() => 0);
        const prefix = { block_admin: 'BA', district_admin: 'DA', state_admin: 'SA', super_admin: 'SUPER' }[role];

        await tier(name).insertOne({
            adminId: `${prefix}${String(count + 1).padStart(4, '0')}`,
            email: lower(doc.email),
            // The unified collection called this `password`; the per-tier ones
            // call it `passwordHash`. Copying the wrong name would silently
            // produce an account with no credential.
            passwordHash: doc.password || doc.passwordHash || '',
            fullName: doc.fullName || doc.name || '',
            phoneNumber: doc.phoneNumber || doc.phone || '',
            role,
            state: region.state,
            ...(role === 'state_admin' || role === 'super_admin' ? {} : { district: region.district }),
            ...(role === 'block_admin' ? { block: region.block } : {}),
            active: doc.isActive !== false && doc.active !== false,
            createdVia: 'migrated_from_admins',
            mustResetPassword: false,
            createdAt: doc.createdAt || new Date(),
            updatedAt: new Date()
        });
        migrated += 1;
    }

    console.log(`  migrated ${migrated} account(s)${migrateSkipped > 0 ? `, ${migrateSkipped} skipped (already present or no tier)` : ''}`);

    // The unified collection is left in place, populated. Login still reads it,
    // so a migration that turns out to be wrong can simply be ignored rather
    // than restored. Emptying it is a separate, later decision.
    console.log("  left the unified 'admins' collection intact (login still reads it)");

    // -- wipe the scaffold --------------------------------------------------
    let deleted = 0;
    for (const name of TIER_COLLECTIONS) {
        const ids = (scaffold[name] || []).map(doc => doc._id);
        if (ids.length === 0) continue;
        // Chunked: a single deleteMany with ~7,000 ids exceeds the 16MB BSON
        // command limit.
        for (let i = 0; i < ids.length; i += 1000) {
            const result = await tier(name).deleteMany({ _id: { $in: ids.slice(i, i + 1000) } });
            deleted += result.deletedCount || 0;
        }
        console.log(`  ${name.padEnd(16)} scaffold removed`);
    }
    console.log(`  deleted ${deleted} placeholder(s)`);

    // -- seed the pilot -----------------------------------------------------
    const credentials = [];
    if (!SKIP_SEED && seedFinal.length > 0) {
        const byRole = new Map();
        seedFinal.forEach((row) => {
            if (!byRole.has(row.role)) byRole.set(row.role, []);
            byRole.get(row.role).push(row);
        });

        for (const [role, group] of byRole) {
            const name = COLLECTION_FOR_ROLE[role];
            const base = await tier(name).estimatedDocumentCount().catch(() => 0);
            const prefix = { block_admin: 'BA', district_admin: 'DA', state_admin: 'SA' }[role];

            const documents = [];
            for (let i = 0; i < group.length; i += 1) {
                const row = group[i];
                // A distinct password per account. One shared credential across
                // hundreds of accounts is what made the old scaffold a liability.
                const plain = generatePassword();
                documents.push({
                    adminId: `${prefix}${String(base + 1 + i).padStart(4, '0')}`,
                    email: lower(row.email),
                    passwordHash: await bcrypt.hash(plain, 10),
                    fullName: row.fullName,
                    phoneNumber: '',
                    role,
                    state: row.state,
                    ...(role === 'state_admin' ? {} : { district: row.district }),
                    ...(role === 'block_admin' ? { block: row.block } : {}),
                    active: true,
                    createdVia: 'tn_pilot_seed',
                    mustResetPassword: true,
                    createdAt: new Date(),
                    updatedAt: new Date()
                });
                credentials.push({ ...row, password: plain });
            }

            await tier(name).insertMany(documents, { ordered: false });
            console.log(`  seeded ${documents.length} ${role} account(s) into ${name}`);
        }

        const credentialsPath = path.join(outDir, `pilot-credentials-${stamp}.csv`);
        const csv = [
            'role,fullName,email,state,district,block,password',
            ...credentials.map(row => [row.role, row.fullName, row.email, row.state, row.district, row.block, row.password]
                .map(value => `"${String(value || '').replace(/"/g, '""')}"`).join(','))
        ].join('\n');
        fs.writeFileSync(credentialsPath, csv, 'utf8');
        console.log(`\n  Credentials written to ${credentialsPath}`);
        console.log('  This is the only copy — passwords are stored as bcrypt hashes.');
    }

    banner('DONE');
    console.log('  Next steps:');
    console.log('    1. Check the applicant dropdowns: GET /api/v1/regions/tree');
    console.log('    2. Remove ADMIN_DEMO_PASSWORDS from .env — the shared-password accounts are gone.');
    console.log('');

    await mongoose.disconnect();
    await legacy.close();
};

main().catch((err) => {
    console.error('\nFailed:', err && err.message);
    console.error(err && err.stack);
    process.exit(1);
});
