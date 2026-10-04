// In-memory CMS documents: verifies both save paths without any Mongo writes.
const assert = require('assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const {SiteSettings, ContactSettings} = require('../src/modules/cms/cms.models');
const docs = new Map([[SiteSettings, {key:'main',brand:{fullName:'ACTIV'},footer:{note:'Keep footer'}}], [ContactSettings, {key:'main',heading:'Contact ACTIV',social:{instagram:'https://instagram.com/activind'}}]]);
const query = value => ({lean() {return this;}, then(resolve,reject) {return Promise.resolve(value).then(resolve,reject);}, catch(reject) {return Promise.resolve(value).catch(reject);}});
function apply(Model, patch) {
    const doc=docs.get(Model);
    for (const [key,value] of Object.entries(patch.$set || {})) {
        const parts=key.split('.'); let target=doc;
        for(const part of parts.slice(0,-1)) target=target[part] ||= {};
        target[parts.at(-1)]=structuredClone(value);
    }
    return structuredClone(doc);
}
for(const Model of [SiteSettings,ContactSettings]) {
    Model.findOne=()=>query(structuredClone(docs.get(Model)));
    Model.findOneAndUpdate=(filter,patch)=>query(apply(Model,patch));
    Model.updateOne=(filter,patch)=>query(apply(Model,patch));
}
async function main() {
    const cms=require('../src/modules/cms/cms.service');
    const site=await cms.getSiteSettings();
    assert(site.footer.socials.some(r=>r.icon==='instagram'));
    assert(site.footer.socials.some(r=>r.icon==='threads'));
    await cms.updateSiteSettings({footer:{...site.footer,socials:[{icon:'facebook',href:'https://whatsapp.com/channel/fixture'},{icon:'instagram',href:'newhandle'}]}});
    const contact=await cms.getContactInfo();
    assert.equal(contact.social.whatsapp,'https://whatsapp.com/channel/fixture');
    assert.equal(contact.social.instagram,'https://www.instagram.com/newhandle');
    assert.equal(contact.heading,'Contact ACTIV', 'social sync preserves unrelated contact settings');
    await cms.updateContactInfo({...contact,social:{facebook:'https://facebook.com/newprofile',whatsapp:'8220112188'}});
    const updated=await cms.getSiteSettings();
    assert.equal(updated.footer.note,'Keep footer', 'contact social save preserves footer settings');
    assert.deepEqual(updated.footer.socials.map(r=>r.icon),['facebook','whatsapp']);
    assert.equal(updated.brand.fullName,'ACTIV');
    await cms.updateSiteSettings({footer:{...updated.footer,socials:[]}});
    assert.equal((await cms.getSiteSettings()).footer.socials.length,0);
    assert(Object.values((await cms.getContactInfo()).social).every(v=>!v), 'deleted links cannot reappear from the other editor');
    console.log('Social editors: Contact-to-footer and footer-to-Contact saves, correct networks, unrelated settings and deletions passed.');
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
