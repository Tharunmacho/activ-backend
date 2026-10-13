// Default: list only. --apply must name the exact already-deleted member IDs.
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const config = require('../src/config');

async function main() {
    const apply = process.argv.includes('--apply');
    const ids = process.argv.slice(2).filter(arg => arg !== '--apply');
    if (apply && (!ids.length || ids.some(id => !mongoose.isValidObjectId(id)))) {
        throw new Error('Supply the exact deleted member IDs after --apply. Run without arguments to inspect them first.');
    }
    await mongoose.connect(config.db.uri);
    const Member = require('../src/modules/members/memberdetails.model');
    const filter = { deletedAt: { $ne: null }, role: { $nin: ['super_admin', 'state_admin', 'district_admin', 'block_admin', 'cms_admin', 'events_admin', 'admin'] } };
    if (ids.length) filter._id = { $in: ids.map(id => new mongoose.Types.ObjectId(id)) };
    const rows = await Member.collection.find(filter, { projection: { _id: 1, deletedAt: 1 } }).toArray();
    if (!apply) {
        console.log(JSON.stringify({ mode: 'read-only', deletedMembers: rows.map(row => ({ id: String(row._id), deletedAt: row.deletedAt })) }, null, 2));
        return;
    }
    if (rows.length !== new Set(ids).size) throw new Error('One or more supplied IDs are not deleted member records. No changes made.');
    const { purgeMember } = require('../src/modules/members/memberDeletion.service');
    for (const row of rows) {
        const result = await purgeMember(row._id);
        console.log(JSON.stringify({ id: result.id, deleted: result.deleted, removed: result.removed }));
    }
}
main().catch(error => {
    console.error(JSON.stringify({ error: error.name, message: /^Supply|^One or more/.test(error.message) ? error.message : 'Database operation failed; no completed deletion is reported for the failed record.' }));
    process.exitCode = 1;
}).finally(async () => { await mongoose.disconnect(); process.exit(process.exitCode || 0); });
