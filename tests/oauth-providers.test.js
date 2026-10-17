// Provider HTTP contracts only; real account linking/verification is exercised
// by oauth-account-onboarding-local.test.js against isolated Mongo.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
Object.assign(process.env, {
 GOOGLE_CLIENT_ID:'test-google-id', GOOGLE_CLIENT_SECRET:'test-google-secret',
 FACEBOOK_APP_ID:'test-facebook-id', FACEBOOK_APP_SECRET:'test-facebook-secret',
 LINKEDIN_CLIENT_ID:'test-linkedin-id', LINKEDIN_CLIENT_SECRET:'test-linkedin-secret',
 FACEBOOK_GRAPH_VERSION:'v26.0', OAUTH_REDIRECT_BASE:'http://localhost:5057/api/v1/auth/oauth',
 OAUTH_APP_REDIRECT:'activ://auth/social', FRONTEND_URL:'http://localhost:8080', JWT_SECRET:'isolated-provider-test-secret'
});
const axios = require('axios');
const accounts = require('../src/modules/auth/oauthAccount.service');
const created = [];
accounts.create = async (provider, who) => { created.push({ provider, who }); return 'server-handoff'; };
const oauth = require('../src/modules/auth/oauth.service');
let info = { id:'facebook-id', sub:'oidc-subject', email:'MEMBER@gmail.com', email_verified:true, name:'Test Member' };
let calls = [], tokenFailure = null;
axios.post = async (url, body, options) => { calls.push({ url, body, options }); if(tokenFailure) throw tokenFailure; return {data:{access_token:'fixture-access'}}; };
axios.get = async (url, options) => {
 calls.push({url,options});
 if(url.endsWith('/oauth/access_token')) { if(tokenFailure) throw tokenFailure; return {data:{access_token:'fixture-access'}}; }
 if(url.endsWith('/me/permissions')) return {data:{data:[{permission:'email',status:'granted'}]}};
 return {data:info};
};
function begin(provider, client='') {
 let nonce; const res={cookie:(_n,v,o)=>{nonce=v;assert.equal(o.httpOnly,true);assert.equal(o.sameSite,'lax');},clearCookie(){}};
 const start=new URL(oauth.startUrl(provider,{query:{client},headers:{}},res));
 assert.equal(start.searchParams.get('redirect_uri'),`http://localhost:5057/api/v1/auth/oauth/${provider}/callback`);
 assert.equal(start.searchParams.get('response_type'),'code');
 assert(!start.toString().includes('secret'));
 return {start,res,req:{query:{code:'provider-code',state:start.searchParams.get('state')},headers:{cookie:`activ_oauth=${nonce}`}}};
}
const fields=target=>new URLSearchParams(target.startsWith('activ:')?new URL(target).search.slice(1):new URL(target).hash.slice(1));
const login=async(provider,client='')=>{const flow=begin(provider,client);return oauth.handleCallback(provider,flow.req,flow.res);};
(async()=>{
 assert(oauth.listProviders().every(p=>p.enabled));
 assert.equal(oauth.isConfigured('constructor'),false);
 assert.throws(()=>begin('__proto__'),/Unknown sign-in/);
 for(const provider of ['google','facebook','linkedin']) for(const client of ['', 'app']) {
  calls=[]; const target=await login(provider,client);
  assert(target.startsWith(client?'activ://auth/social?':'http://localhost:8080/auth/social#'));
  assert.equal(fields(target).get('code'),'server-handoff');
  assert.equal(created.at(-1).provider,provider);
  assert.equal(created.at(-1).who.subject,provider==='facebook'?'facebook-id':'oidc-subject');
  assert.equal(created.at(-1).who.verified,provider!=='facebook');
  assert.equal(calls.length,2);
  if(provider==='facebook') {
   assert.equal(begin(provider).start.searchParams.get('auth_type'),'rerequest');
   assert.equal(calls[1].options.params.appsecret_proof,crypto.createHmac('sha256','test-facebook-secret').update('fixture-access').digest('hex'));
   assert(!calls[1].options.params.access_token);
  } else {
   assert.equal(new URLSearchParams(calls[0].body).get('grant_type'),'authorization_code');
  }
  assert.equal(calls[1].options.headers.Authorization,'Bearer fixture-access');
 }
 info={...info,email:'member@example.test',email_verified:true};
 await login('google'); assert.equal(created.at(-1).who.verified,false,'third-party Google email is not authoritative');
 info={...info,hd:'example.test'}; await login('google'); assert.equal(created.at(-1).who.verified,true);
 delete info.hd;
 for(const claim of [undefined,false]) {
  info.email_verified=claim;
  for(const provider of ['google','linkedin']) {await login(provider);assert.equal(created.at(-1).who.verified,false);}
 }
 info.email=undefined;
 for(const provider of ['google','facebook','linkedin']) { await login(provider); assert.equal(created.at(-1).who.verified,false); }
 for(const provider of ['google','facebook','linkedin']) {
  const flow=begin(provider);flow.req.headers.cookie='activ_oauth=wrong';calls=[];
  assert.equal(fields(await oauth.handleCallback(provider,flow.req,flow.res)).get('error'),'expired');assert.equal(calls.length,0);
 }
 for(const [provider,raw,reason] of [['google','invalid_client','configuration'],['linkedin','unauthorized_scope_error','permissions'],['facebook',{code:101,message:'PRIVATE'},'configuration']]) {
  tokenFailure={response:{status:400,data:{error:raw}}};const target=await login(provider,'app');
  assert.equal(fields(target).get('error'),reason);assert(!target.includes('PRIVATE'));
 }
 delete process.env.FACEBOOK_APP_SECRET;
 assert.equal(oauth.listProviders().find(p=>p.key==='facebook').enabled,false);
 assert.throws(()=>begin('facebook'),/not set up/);
 console.log('PASS provider contracts: web/app callback, server exchange, stable subject, authoritative email claims, Facebook proof, missing claims, CSRF and safe errors.');
 process.exit(0);
})().catch(error=>{console.error(error);process.exit(1);});
