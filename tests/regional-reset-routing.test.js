// Pure adapters: no accounts changed and no reset email actually sent.
const assert = require('assert/strict');
const repo = require('../src/modules/admin/admin.repository');
let routedTo, savedToken, active=true, central=true;
repo.findRawByEmail = async email => ({doc:{_id:'0123456789abcdef01234567',role:'state_admin',email,fullName:'Regional Admin',state:'Bihar',createdVia:'super_admin_ui',active,
    ...(central ? {notificationEmail:'member@activ.org.in'} : {})},source:'state_admins'});
repo.updateById = async (hit,set) => {savedToken=set;};
require('../src/core/utils/mailer').sendPasswordReset = async input => {routedTo=input.email;return {sent:true};};
async function main() {
    const auth=require('../src/modules/auth/auth.service');
    await auth.requestPasswordReset('regional-login@example.test',{portal:'admin'});
    assert.equal(routedTo,'member@activ.org.in');
    assert(savedToken.resetPasswordToken && savedToken.resetPasswordExpires);
    central=false;
    await auth.requestPasswordReset('real-admin@example.test',{portal:'admin'});
    assert.equal(routedTo,'real-admin@example.test', 'existing admin notification destinations remain intact');
    active=false;routedTo=undefined;
    await auth.requestPasswordReset('inactive@example.test',{portal:'admin'});
    assert.equal(routedTo,undefined);
    console.log('Regional reset routing: new login aliases use central mailbox, existing destinations and inactive-account protection passed.');
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
