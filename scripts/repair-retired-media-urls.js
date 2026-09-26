#!/usr/bin/env node
/**
 * Rewrite upload URLs stored on a RETIRED backend host to the site-relative
 * `/uploads/<file>` form, in every collection of both databases.
 *
 *   node scripts/repair-retired-media-urls.js            dry run: count what would change
 *   node scripts/repair-retired-media-urls.js --confirm  write (a JSON backup of every changed document is kept)
 *
 * The file itself lives on under the same `/uploads/` name on the current API;
 * only the host baked into the saved string is dead. Relative is what every
 * reader already resolves against its own API base.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const adminsDb = require('../src/modules/admin/adminsDb');

const RETIRED = /https?:\/\/[a-z0-9.-]*\.sslip\.io(?=\/uploads\/)/gi;
const confirm = process.argv.includes('--confirm');

const fix = (value) => {
    if (typeof value === 'string') return value.replace(RETIRED, '');
    if (Array.isArray(value)) return value.map(fix);
    if (value && typeof value === 'object' && !(value instanceof Date) && !(value._bsontype)) {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = fix(v);
        return out;
    }
    return value;
};

(async() => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    const cms = await adminsDb.ensureReady();
    const dbs = [['main', mongoose.connection.db], ['cms', (cms && cms.db) || adminsDb.getConnection().db]];
    const backup = [];
    let total = 0;

    for (const [label, db] of dbs) {
        for (const { name } of await db.listCollections().toArray()) {
            if (name.startsWith('system.')) continue;
            const col = db.collection(name);
            let changed = 0;
            for await (const doc of col.find({})) {
                if (!JSON.stringify(doc).match(/\.sslip\.io\/uploads\//i)) continue;
                const { _id, ...rest } = doc;
                const next = fix(rest);
                backup.push({ db: label, collection: name, _id, before: rest });
                if (confirm) await col.replaceOne({ _id }, next);
                changed += 1;
            }
            if (changed) console.log(`  ${label}.${name}: ${changed} document(s)`);
            total += changed;
        }
    }

    if (confirm && backup.length) {
        const dir = path.join(__dirname, '..', 'backups');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `retired-media-urls-${Date.now()}.json`);
        fs.writeFileSync(file, JSON.stringify(backup));
        console.log('backup:', file);
    }
    console.log(`${total} document(s) ${confirm ? 'repaired' : 'would be repaired (dry run - add --confirm)'}`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
