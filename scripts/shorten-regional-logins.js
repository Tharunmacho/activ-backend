// Shorten only the generated nationwide addresses. Existing passwords and
// the established Tamil Nadu, Karnataka and Puducherry accounts are retained.
// Preview: node scripts/shorten-regional-logins.js
// Apply:   node scripts/shorten-regional-logins.js --apply --out <private.json>
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config');
const repository = require('../src/modules/admin/admin.repository');
const { shortLoginPlan } = require('../src/modules/admin/nationalAdminPlan');

async function main() {
    await mongoose.connect(config.db.uri, { ...config.db.options, dbName: config.db.name });
    const existing = await repository.findAll({ fresh: true, includeUnstamped: true });
    const changes = shortLoginPlan(existing);
    const apply = process.argv.includes('--apply');
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', changes: changes.length,
        tiers: changes.reduce((out, row) => ({ ...out, [row.role]: (out[row.role] || 0) + 1 }), {}),
        examples: ['state_admin', 'district_admin', 'block_admin'].map(role => {
            const row = changes.find(a => a.role === role && a.state === 'Kerala');
            return row && { role, state: row.state, district: row.district, block: row.block, email: row.email };
        }),
    }));
    if (!apply || !changes.length) return;
    const at = process.argv.indexOf('--out');
    if (at < 0 || !process.argv[at + 1] || !path.isAbsolute(process.argv[at + 1])) throw new Error('Provide a private absolute --out JSON path.');
    const output = process.argv[at + 1];
    const planned = new Set(changes.map(row => row.email));
    if (planned.size !== changes.length) throw new Error('The login plan contains a duplicate address');
    fs.writeFileSync(output, JSON.stringify({ createdAt: new Date().toISOString(), changes: changes.map(row => ({
        id: row.id, source: row.source, role: row.role, state: row.state, district: row.district, block: row.block,
        previousEmail: row.previousEmail, email: row.email,
    })) }, null, 2), { flag: 'wx', mode: 0o600 });
    const modified = await repository.renameImportedLogins(changes);
    const after = await repository.findAll({ fresh: true, includeUnstamped: true });
    const byId = new Map(after.map(row => [row.id, row]));
    if (changes.some(row => byId.get(row.id)?.email !== row.email)) throw new Error('Not every login was updated; the saved plan identifies any remaining rows.');
    if (after.length !== existing.length) throw new Error('Admin count changed during verification');
    const changedIds = new Set(changes.map(row => row.id));
    if (existing.some(row => !changedIds.has(row.id) && byId.get(row.id)?.email !== row.email)) throw new Error('An unrelated login changed during verification');
    require('../src/modules/regions/region.service').invalidate();
    console.log(JSON.stringify({ verified: true, modified, accounts: after.length, backup: output, remaining: shortLoginPlan(after).length }));
}
main().then(() => process.exit(0)).catch(err => { console.error(err.message); process.exit(1); });
