const assert = require('node:assert/strict');
Object.assign(process.env,{GOOGLE_CLIENT_ID:'fixture-id',GOOGLE_CLIENT_SECRET:'fixture-secret',OAUTH_REDIRECT_BASE:'http://localhost:5057/api/v1/auth/oauth',FRONTEND_URL:'http://localhost:8080'});
const accounts = require('../src/modules/auth/oauthAccount.service');
let handed, exchanged;
accounts.create=async(provider,who)=>{handed={provider,who};return 'single-use-server-flow';};
accounts.exchange=async(code,input)=>{exchanged={code,input};return {requiresEmailVerification:true,email:'member@example.test',provider:'google'};};
const oauth=require('../src/modules/auth/oauth.service');
oauth.PROVIDERS.google.profile=async()=>({subject:'google-subject',email:'member@example.test',verified:false,name:'Member'});
async function login(client=''){
 let nonce;const res={cookie:(_name,value)=>{nonce=value;},clearCookie(){}};
 const url=new URL(oauth.startUrl('google',{query:{client},headers:{}},res));
 return oauth.handleCallback('google',{query:{code:'provider-code',state:url.searchParams.get('state')},headers:{cookie:`activ_oauth=${nonce}`}},res);
}
(async()=>{
 assert.equal(await login(),'http://localhost:8080/auth/social#code=single-use-server-flow&provider=google');
 assert.equal(await login('app'),'activ://auth/social?code=single-use-server-flow&provider=google');
 assert.equal(handed.who.subject,'google-subject');assert.equal(handed.who.verified,false);
 assert.equal((await oauth.exchange('single-use-server-flow',{verificationCode:'123456'})).requiresEmailVerification,true);
 assert.deepEqual(exchanged,{code:'single-use-server-flow',input:{verificationCode:'123456'}});
 oauth.PROVIDERS.google.profile=async()=>{throw {response:{status:401,data:{error:'invalid_client',secret:'PRIVATE'}}};};
 const failure=await login();assert(failure.includes('error=configuration'));assert(!failure.includes('PRIVATE'));
 console.log('PASS OAuth landing: website/app handoff, server-only profile trust, email verification delegation and safe provider failure.');
 process.exit(0);
})().catch(error=>{console.error(error);process.exit(1);});
