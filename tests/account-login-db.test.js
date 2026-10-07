// Real Mongo integration, isolated databases; no production records or messages.
// Usage: node tests/account-login-db.test.js --run-isolated-db
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
if (!process.argv.includes('--run-isolated-db')) throw new Error('Pass --run-isolated-db to create temporary test databases.');
const env = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '../.env')));
const mongoose = require('mongoose');
const layout = require('../src/config/dataLayout');
const prefix = `activ_test_account_${Date.now()}_`;
for (const area of Object.keys(layout.DATABASES)) layout.DATABASES[area] = prefix + area;
process.env.JWT_SECRET = 'isolated-account-integration-secret';
process.env.JWT_REFRESH_SECRET = 'isolated-account-integration-refresh';
const Member = require('../src/modules/members/memberdetails.model');
const Auth = require('../src/modules/auth/auth.model');
const Personal = require('../src/modules/members/personalinfo1.model');
const Application = require('../src/modules/applications/application.model');
const notification = require('../src/modules/notifications/notification.service');
const notices = [];
notification.dispatchInBackground = (...args) => notices.push(args[0]);
notification.dispatchLifecycleEvent = async (...args) => { notices.push(args[0]); return {}; };
const region = require('../src/modules/regions/region.service');
region.validateRegion = async () => ({ ok: true, region: { state: 'Test State', district: 'Test District', block: 'Test Block' } });
const auth = require('../src/modules/auth/auth.service');
const account = require('../src/modules/members/accountDetails.service');
const lifetime = require('../src/modules/members/platinum.service');
const actor = { userId: new mongoose.Types.ObjectId().toString(), role: 'super_admin', fullName: 'Test Office' };
const fixture = { fullName: 'Isolated Test Member', email: 'account@example.test', phoneNumber: '9123456780', whatsappNumber: '9123456780', password: 'First-test-2026', state: 'Test State', district: 'Test District', block: 'Test Block' };
let count = 0;
const passed = message => { count++; console.log(`PASS ${message}`); };
async function main() {
  const request = { body: { ...fixture, email: '  Test.Member+Office@gmail.com ' } };
  await new Promise((resolve, reject) => require('../src/modules/auth/auth.validators').registerValidator(request, {}, error => error ? reject(error) : resolve()));
  assert.equal(request.body.email, 'test.member+office@gmail.com', 'registration must preserve the email spelling accepted by login');
  passed('registration preserves dotted and plus-addressed emails for subsequent login');
  await mongoose.connect(env.MONGODB_URI, { dbName: prefix + 'root', serverSelectionTimeoutMS: 12000, autoIndex: false });
  await Promise.all([Member.createIndexes(), Auth.createIndexes()]);
  const created = await lifetime.createAccount(fixture, actor);
  const id = created.id;
  assert(!created.password && !created.token);
  assert.equal(String((await auth.login(fixture.email, fixture.password, { portal: 'member' })).user.id), id);
  passed('new office account signs in with registered credentials');
  const loginRow = await Auth.findOne({ email: fixture.email });
  assert.notEqual(String(loginRow._id), id);
  await auth.changePassword(id, fixture.password, 'Changed-test-2026');
  await auth.login(fixture.email, 'Changed-test-2026');
  await assert.rejects(auth.login(fixture.email, fixture.password), /Invalid credentials/);
  passed('change-password resolves separate profile/login IDs; old password fails');
  await Personal.create({ userId: id, name: fixture.fullName, phoneNumber: fixture.phoneNumber, state: fixture.state, district: fixture.district, block: fixture.block });
  await account.update(await Member.findById(id), { email: '  UPDATED@example.test ', phoneNumber: '+91 92345 67801', whatsappNumber: '+91 93456 78012', password: 'Combined-test-2026', confirmPassword: 'Combined-test-2026', currentPassword: 'Changed-test-2026' });
  await auth.login('updated@example.test', 'Combined-test-2026');
  assert.equal((await Member.findById(id)).phoneNumber, '9234567801');
  assert.equal((await Member.findById(id)).whatsappNumber, '9345678012');
  assert.equal((await Personal.findOne({ userId: id })).phoneNumber, '9234567801');
  assert.equal(await Auth.exists({ email: fixture.email }), null);
  passed('email, password, phone and WhatsApp persist and new credentials sign in');
  await Auth.create({ email: 'occupied@example.test', password: 'Other-test-2026' });
  await assert.rejects(account.update(await Member.findById(id), { email: 'occupied@example.test', password: 'Not-saved-2026' }, { admin: true }), /already in use/);
  await auth.login('updated@example.test', 'Combined-test-2026');
  await assert.rejects(account.update(await Member.findById(id), { password: 'Missing-confirmation' }), /Passwords do not match/);
  passed('duplicate email and incomplete password changes leave login working');
  const failing = await Member.findById(id);
  failing.save = async () => { throw new Error('Simulated profile write failure'); };
  await assert.rejects(account.update(failing, { email: 'rollback@example.test', password: 'Not-saved-2026' }, { admin: true }), /Simulated/);
  await auth.login('updated@example.test', 'Combined-test-2026');
  assert.equal(await Auth.exists({ email: 'rollback@example.test' }), null);
  passed('profile write failure restores the previous login email and password hash');
  const selected = await lifetime.createAccount({ email: 'updated@example.test' }, actor);
  assert.equal(selected.id, id);
  await assert.rejects(lifetime.createAccount({ email: 'updated@example.test', password: 'Ignored-password' }, actor), /already exists/);
  await lifetime.updateAccount(id, { password: 'Office-reset-2026' }, actor);
  await auth.login('updated@example.test', 'Office-reset-2026');
  passed('existing account selection is explicit and office password reset works');
  await assert.rejects(lifetime.updateAccount(id, { password: 'Forbidden-test-2026' }, { role: 'member' }), e => e.statusCode === 403);
  await lifetime.grant(id, { amount: 200000, paymentMode: 'cash', manualAdmission: true, note: 'Isolated integration office admission', receivedOn: new Date().toISOString().slice(0, 10) }, actor);
  const paid = await auth.login('updated@example.test', 'Office-reset-2026');
  assert.equal(paid.memberDetails.membershipTier, 'platinum');
  assert.equal(paid.memberDetails.membershipType, 'lifetime');
  assert.equal(paid.memberDetails.membershipStatus, 'active');
  passed('office payment grants lifetime access on the same account; login still works');
  await Auth.deleteOne({ email: 'updated@example.test' });
  await lifetime.updateAccount(id, { password: 'Recovered-test-2026' }, actor);
  await auth.login('updated@example.test', 'Recovered-test-2026');
  passed('Super Admin can repair a missing credential record with an explicit new password');
  assert(notices.includes('ACCOUNT_REGISTERED') && notices.includes('MEMBERSHIP_ACTIVATED'));
  console.log(`${count} real-database integration checks passed. Outgoing notifications intercepted.`);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (mongoose.connection.readyState === 1) {
    for (const name of [...Object.values(layout.DATABASES), prefix + 'root']) {
      if (!name.startsWith(prefix) || !/^activ_test_account_\d+_[a-z]+$/.test(name)) throw new Error('Unsafe cleanup target');
      await mongoose.connection.getClient().db(name).dropDatabase();
    }
    console.log('Temporary test databases removed.');
  }
  await mongoose.disconnect();
  process.exit(process.exitCode || 0);
});
