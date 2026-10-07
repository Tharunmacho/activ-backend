// Restore ONLY an orphaned, active profile whose exact ID/email matches the
// migration backup. Default is read-only. Does not reset an existing password.
const fs = require('fs');
const path = require('path');
const { MongoClient, BSON: { EJSON } } = require('mongodb');
const env = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '../.env')));
const layout = require('../src/config/dataLayout');
const email = String(process.argv.find(arg => arg.startsWith('--email=')) || '').slice(8).trim().toLowerCase();
const apply = process.argv.includes('--apply');
if (!email) throw new Error('Supply --email=address; add --apply after reviewing the dry run.');
const backupDir = path.join(__dirname, '../backups/migration-2026-10-01T06-39-44-842Z');
const read = name => {
  const text = fs.readFileSync(path.join(backupDir, name), 'utf8').trim();
  return text.startsWith('[') ? EJSON.parse(text) : text.split(/\r?\n/).map(line => EJSON.parse(line));
};
const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 12000 });
const coll = name => { const [area, collection] = layout.MODELS[name]; return client.db(layout.dbName(area)).collection(collection); };
async function main() {
  await client.connect();
  const member = await coll('MemberDetails').findOne({ email });
  if (!member || member.deletedAt || member.isActive === false) throw new Error('No active profile eligible for recovery.');
  const existing = await coll('MemberAuth').findOne({ email });
  if (existing) { console.log('Login record already exists; nothing changed.'); return; }
  const profile = read('dokploy__activ-db__users.ejson').find(row => row.email === email);
  const auth = read('dokploy__activ-db__auth.ejson').find(row => row.email === email);
  if (!profile || String(profile._id) !== String(member._id) || !auth || auth.isActive === false || !/^\$2[aby]\$\d{2}\$/.test(auth.password || '')) throw new Error('Backup identity or password-hash validation failed.');
  if (await coll('MemberAuth').findOne({ _id: auth._id })) throw new Error('Backup credential ID belongs to another current login; manual review required.');
  console.log('Verified exact profile ID/email, active account, missing login, and valid backup password hash.');
  if (!apply) { console.log('Dry run: one login record can be restored; no changes made.'); return; }
  const result = await coll('MemberAuth').updateOne({ email }, { $setOnInsert: {
    _id: auth._id, email, password: auth.password, isActive: true,
    createdAt: auth.createdAt || new Date(), updatedAt: new Date(),
  } }, { upsert: true });
  const restored = await coll('MemberAuth').findOne({ email });
  if (!restored || restored.password !== auth.password) throw new Error('Recovery verification failed.');
  console.log(JSON.stringify({ restored: result.upsertedCount === 1, originalPasswordHashPreserved: true, existingMemberProfilePreserved: true }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => client.close());
