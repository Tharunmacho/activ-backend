// Creates only missing regions. Existing accounts, passwords and locations are
// never edited. Plaintext initial credentials stay in a private local export.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const config = require('../src/config');
const repository = require('../src/modules/admin/admin.repository');
const { plan, key } = require('../src/modules/admin/nationalAdminPlan');
const apply = process.argv.includes('--apply');
const outIndex = process.argv.indexOf('--out');
async function main() {
    await mongoose.connect(config.db.uri, { ...config.db.options, dbName: config.db.name });
    const existing = await repository.findAll();
    const missing = plan(existing);
    const counts = missing.reduce((all, row) => ({ ...all, [row.role]: (all[row.role] || 0) + 1 }), {});
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', existing: existing.length, missing: missing.length, counts, notificationEmail: 'member@activ.org.in' }));
    if (!apply || !missing.length) return;
    if (outIndex < 0 || !process.argv[outIndex + 1]) throw new Error('Provide --out with a private absolute CSV path.');
    const output = path.resolve(process.argv[outIndex + 1]);
    const now = new Date();
    const resume = process.argv.includes('--resume');
    const saved = resume ? new Map(fs.readFileSync(output, 'utf8').split(/\r?\n/).slice(1).map(line => { const cells = [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(m => m[1].replace(/""/g, '"')); return [cells[5], cells[6]]; })) : new Map();
    if (resume && missing.some(row => !saved.get(row.email))) throw new Error('The resume file does not contain every remaining account.');
    const accounts = missing.map(row => ({ ...row, password: saved.get(row.email) || crypto.randomBytes(18).toString('base64url'), active: true, mustResetPassword: true, createdVia: 'super_admin_ui', createdAt: now, updatedAt: now }));
    const csv = row => row.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',');
    if (!resume) fs.writeFileSync(output, [csv(['Name', 'Role', 'State', 'District', 'Block', 'Login email', 'Initial password', 'Notification email']), ...accounts.map(a => csv([a.fullName, a.role, a.state, a.district, a.block, a.email, a.password, a.notificationEmail]))].join('\r\n'), { flag: 'wx', mode: 0o600 });
    const known = new Map(existing.map(a => [key(a), a.id]));
    let created = 0;
    for (const role of ['state_admin', 'district_admin', 'block_admin']) {
        const tier = accounts.filter(a => a.role === role);
        for (let start = 0; start < tier.length; start += 64) {
            const batch = tier.slice(start, start + 64);
            const docs = await Promise.all(batch.map(async a => {
                const { password, ...doc } = a;
                const parent = role === 'block_admin' ? { ...a, role: 'district_admin' } : { ...a, role: 'state_admin' };
                return { ...doc, parentAdminId: role === 'state_admin' ? '' : known.get(key(parent)) || '', passwordHash: await bcrypt.hash(password, 10) };
            }));
            const inserted = await repository.insertMany(docs);
            inserted.forEach(a => known.set(key(a), a.id));
            created += inserted.length;
            console.log(JSON.stringify({ created, total: accounts.length, tier: role }));
        }
    }
    require('../src/modules/regions/region.service').invalidate();
    console.log(JSON.stringify({ complete: true, created, credentialFile: output }));
}
main().then(() => process.exit(0)).catch(err => { console.error(err.message); process.exit(1); });
