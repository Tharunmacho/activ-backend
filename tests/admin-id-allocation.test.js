// Isolated storage adapters: no database or provisioning writes.
const assert = require('assert/strict');
const db = require('../src/modules/admin/adminsDb');
const layout = require('../src/config/dataLayout');
let sequence = 0;
db.ensureReady = async () => {};
db.isReady = () => true;
db.getConnection = () => ({ db: { collection: () => ({ find: () => ({ toArray: async () => [{adminId:'SA0001'}, {adminId:'SA0042'}, {adminId:'old-format'}] }) }) } });
layout.collection = name => {
    assert.equal(name, 'adminIdCounters');
    return {
        updateOne: async (filter, patch) => { sequence = Math.max(sequence, patch.$max.seq); },
        findOneAndUpdate: async (filter, patch) => { sequence += patch.$inc.seq; return {seq:sequence}; }
    };
};
async function main() {
    const repo = require('../src/modules/admin/admin.repository');
    assert.deepEqual(await repo.allocateAdminIds('state_admin', 2), ['SA0043','SA0044'], 'allocate above historical IDs, rather than document count');
    const batches = await Promise.all(Array.from({length:8}, () => repo.allocateAdminIds('state_admin', 64)));
    const ids = batches.flat();
    assert.equal(ids.length, 512); assert.equal(new Set(ids).size, 512);
    assert.equal(ids[0], 'SA0045'); assert.equal(ids.at(-1), 'SA0556');
    console.log('Admin IDs: sparse historical numbers, batch allocation and concurrent unique IDs passed.');
}
main().then(() => process.exit(0)).catch(e => {console.error(e);process.exit(1);});
