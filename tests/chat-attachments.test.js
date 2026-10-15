// Mocked membership/storage references; real validators and HTTP download headers.
// No database connection or external message delivery.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'local-chat-attachment-test-key';
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const attachments = require('../src/modules/messages/messageAttachments');
const config = require('../src/config');
const owner = String(new mongoose.Types.ObjectId()), peer = String(new mongoose.Types.ObjectId()), outsider = String(new mongoose.Types.ObjectId());
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
const file = (name, type, content) => ({ originalname: name, mimetype: type, buffer: Buffer.isBuffer(content) ? content : Buffer.from(content) });
const saved = [];
(async () => {
    await test('valid PDF and plain documents expose canonical bounded metadata', async () => {
        assert.deepEqual(await attachments.validateFile(file('report.pdf', 'application/pdf', '%PDF-1.4\n%%EOF')), { name: 'report.pdf', mimeType: 'application/pdf', size: 14, kind: 'file' });
        assert.equal((await attachments.validateFile(file('report.csv', 'text/csv', 'name,amount\nExample,25'))).mimeType, 'text/csv');
        assert.equal((await attachments.validateFile(file('notes.rtf', 'application/rtf', '{\\rtf1 Example}'))).kind, 'file');
    });
    await test('reject executable, spoofed, empty, oversized and active content', async () => {
        for (const candidate of [file('run.exe','application/pdf','%PDF-1.4'), file('run.pdf','application/pdf','MZ executable'),
            file('run.pdf','text/plain','%PDF-1.4'), file('empty.txt','text/plain',''), file('huge.txt','text/plain',Buffer.alloc(10*1024*1024+1)),
            file('active.txt','text/plain','<html><script>bad</script>'), file('active.rtf','application/rtf','{\\rtf1 \\object bad}'),
            file('fake.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document','PK not an Office document'),
            file('image.svg','image/svg+xml','<svg/>')]) {
            await assert.rejects(attachments.validateFile(candidate), error => error.statusCode === 400);
        }
    });
    await test('real raster image accepted; image spoof and excessive image size rejected', async () => {
        const png = await require('sharp')({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer();
        assert.equal((await attachments.validateFile(file('photo.png','image/png',png))).kind, 'image');
        await assert.rejects(attachments.validateFile(file('photo.jpg','image/jpeg',png)), /valid supported/);
        await assert.rejects(attachments.validateFile(file('photo.png','image/png',Buffer.alloc(5*1024*1024+1))), /5 MB/);
    });
    await test('upload preserves legacy field and returns signed owner-bound receipt without exposing storage path', async () => {
        const req = { files: { file: [{ ...file('../../quote.pdf','application/pdf','%PDF-1.4\n%%EOF'), fieldname: 'file' }] } };
        const result = await attachments.storeUpload(req, owner); saved.push(req.file.path);
        assert.equal(result.name, 'quote.pdf'); assert.equal(result.storageName, undefined); assert.equal(result.kind, 'file');
        assert.match(result.url, /^\/api\/v1\/messages\/attachments\//);
        const canonical = attachments.forMessage(owner, '', { token: result.token, name:'run.exe', url:'https://evil.test' });
        assert.equal(canonical.name, 'quote.pdf'); assert.equal(canonical.url, result.url);
        assert.throws(() => attachments.forMessage(peer, '', { token: result.token }), /choose the file again/i);
        assert.throws(() => attachments.forMessage(owner, result.url), /Attach/);
        assert.equal(attachments.publicMetadata(canonical).storageName, undefined);
        assert.equal(attachments.publicMetadata(canonical).token, undefined);
        const expired = jwt.sign(canonical, config.jwt.secret, { audience:'activ-chat-upload', subject:owner, expiresIn:-1 });
        assert.throws(() => attachments.forMessage(owner, '', { token: expired }), /choose the file again/i);
        const png = await require('sharp')({create:{width:1,height:1,channels:3,background:'#fff'}}).png().toBuffer();
        const legacy = {files:{image:[{...file('picture.png','image/png',png),fieldname:'image'}]}};
        const picture = await attachments.storeUpload(legacy, owner); saved.push(legacy.file.path);
        assert.equal(attachments.forMessage(owner, picture.url).kind, 'image');
    });
    await test('legacy raster paths remain valid and traversal or foreign URL injection is rejected', async () => {
        assert.equal(attachments.forMessage(owner, '/uploads/media/old-id/photo.jpg').kind, 'image');
        for (const url of ['https://evil.test/a.png','javascript:alert(1)','/uploads/../../run.png','/uploads/a%2fb.png','/api/v1/messages/attachments/anything']) {
            assert.throws(() => attachments.forMessage(owner,url), /Attach/);
        }
    });
    await test('private document storage cannot be reached through public upload paths', async () => {
        const app=express(); app.use('/uploads',attachments.blockPublicFiles); app.use((req,res)=>res.status(200).end());
        for (const url of ['/uploads/chat-files/id/report.pdf','/uploads/%63hat-files/id/report.pdf','/uploads/chat-files%2fid%2freport.pdf']) {
            assert.equal((await request(app).get(url)).status,404,url);
        }
        assert.equal((await request(app).get('/uploads/chat-images/id/photo.png')).status,200);
    });
    await test('member cannot download another conversation and inactive/student memberships are rejected', async () => {
        const Member=require('../src/modules/members/memberdetails.model');
        const Order=require('../src/modules/payment/paymentorder.model');
        const {Conversation,Message}=require('../src/modules/messages/message.model');
        const service=require('../src/modules/messages/message.service');
        const originals=[Member.findById,Order.findOne,Conversation.find,Message.findOne];
        const conversationId=new mongoose.Types.ObjectId();
        let status='active', kind='aspirant', seenFilter;
        const metadata={id:'764b0ba0-29c9-4d08-bc82-146dc046188a',kind:'file',name:'quote.pdf'};
        Member.findById=id=>({select:()=>({lean:async()=>({_id:id,fullName:'Member',membershipStatus:status,membershipType:'annual',membershipExpiresAt:new Date(Date.now()+86400000),memberType:kind,isActive:true})})});
        Order.findOne=()=>({sort(){return this;},select(){return this;},lean:async()=>null});
        Conversation.find=query=>({select:()=>({lean:async()=>String(query.participants)===outsider?[]:[{_id:conversationId}]})});
        Message.findOne=query=>({select:()=>({lean:async()=>{seenFilter=query;return query.conversationId.$in.length?{attachment:metadata}:null;}})});
        try {
            assert.equal((await service.attachmentForDownload(metadata.id,owner)).name,'quote.pdf');
            assert.deepEqual(seenFilter.conversationId.$in,[conversationId]);
            await assert.rejects(service.attachmentForDownload(metadata.id,outsider),error=>error.statusCode===404);
            kind='student'; await assert.rejects(service.attachmentForDownload(metadata.id,owner),error=>error.statusCode===403);
            kind='aspirant';status='pending';await assert.rejects(service.attachmentForDownload(metadata.id,owner),error=>error.statusCode===403);
        } finally { [Member.findById,Order.findOne,Conversation.find,Message.findOne]=originals; }
    });
    await test('download is attachment-only with private cache policy and no sniffing', async () => {
        const filePath=saved[0];
        const root=require('../src/core/storage/uploadStore').UPLOADS_DIR;
        const meta={storageName:path.relative(root,filePath).split(path.sep).join('/'),name:'quote.pdf',mimeType:'application/pdf'};
        const app=express();app.get('/download',(req,res,next)=>attachments.download(meta,res).catch(next));
        const response=await request(app).get('/download');
        assert.equal(response.status,200);assert.match(response.headers['content-disposition'],/^attachment;/);
        assert.equal(response.headers['cache-control'],'private, no-store');assert.equal(response.headers['x-content-type-options'],'nosniff');
    });
    await test('multipart accepts only one bounded file and the actual router requires authentication', async () => {
        const app=express();app.post('/upload',attachments.receive,(req,res)=>res.end());app.use((error,req,res,next)=>res.status(error.statusCode||500).json({message:error.message}));
        assert.equal((await request(app).post('/upload').attach('file',Buffer.from('one'),'one.txt').attach('image',Buffer.from('two'),'two.txt')).status,400);
        const secured=express();secured.use('/messages',require('../src/modules/messages/message.routes'));
        secured.use((error,req,res,next)=>res.status(error.statusCode||500).json({message:error.message}));
        assert.equal((await request(secured).get('/messages/attachments/764b0ba0-29c9-4d08-bc82-146dc046188a')).status,401);
    });
    console.log(`${passed} chat attachment cases passed; no database or external delivery.`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    for(const target of saved){await fs.unlink(target).catch(()=>{});await fs.rmdir(path.dirname(target)).catch(()=>{});}
    process.exit(process.exitCode||0);
});
