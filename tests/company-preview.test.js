const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const sharp = require('sharp');
const mongoose = require('mongoose'); mongoose.set('bufferCommands', false);
const Company = require('../src/modules/members/company.model');
const Product = require('../src/models/Product');
const Trust = require('../src/modules/members/trustedcompany.model');
const companyId = new mongoose.Types.ObjectId(), ownerId = new mongoose.Types.ObjectId();
let visible = true;
const fixture = { _id: companyId, userId: ownerId, businessName: 'Sample Industries', businessType: 'Manufacturing', description: 'Engineering products and services for local businesses.', mobileNumber: '9000000000', email: 'sample@example.test', area: 'Guindy', location: 'Chennai', logo: '/uploads/fixture-logo.png', banner: '/uploads/fixture-banner.png', status: 'pending', isActive: true, panNumber: 'PRIVATE-PAN', gstNumber: 'PRIVATE-GST', turnoverRange: 'PRIVATE-FINANCIAL', schemeDetails: 'PRIVATE-SCHEME' };
const companyQuery = () => { let fields = []; return { select(s) { fields = s.split(' '); return this; }, lean: async () => Object.fromEntries(['_id', ...fields].filter(k => k in fixture).map(k => [k, fixture[k]])) }; };
Company.findById = Company.findOne = companyQuery;
require('../src/modules/members/companyPublishing').publishedIds = async () => visible ? [companyId] : [];
Product.find = () => ({ select() { return this; }, sort() { return this; }, lean: async () => [] });
Trust.countDocuments = async () => 0;
let sources = [];
require('../src/core/storage/imageVariants').readOriginal = async (_dir, name) => {
    sources.push(name);
    return sharp({ create: { width: name.includes('banner') ? 1000 : 150, height: name.includes('banner') ? 250 : 150, channels: 4, background: name.includes('banner') ? '#e9dcff' : '#552599' } }).png().toBuffer();
};
const app = express();
app.use('/api/v1/share', require('../src/modules/share/share.routes'));
app.use('/api/v1', require('../src/modules/members/business.routes'));
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ message: err.message }));
async function main() {
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    try {
        const publicPage = await fetch(`${base}/network/companies/${companyId}`);
        assert.equal(publicPage.status, 200);
        const data = await publicPage.json();
        assert.equal(data.data.businessName, fixture.businessName); assert.equal(data.data.banner, fixture.banner);
        assert(!JSON.stringify(data).includes('PRIVATE')); assert(!data.data.userId);
        assert.equal(data.data.status, 'active');
        const response = await fetch(`${base}/share/companies/${companyId}`);
        const html = await response.text();
        assert.equal(response.status, 200); assert.match(html, /property="og:title" content="Sample Industries \| ACTIV Network"/);
        assert.match(html, /network\/company\//); assert.match(html, /og:image:width" content="1200"/);
        assert(!html.includes('PRIVATE'));
        const image = await fetch(`${base}/share/companies/${companyId}/preview/fixture.jpg`);
        assert.equal(image.status, 200);
        const bytes = Buffer.from(await image.arrayBuffer()); const meta = await sharp(bytes).metadata();
        assert.equal(meta.width, 1200); assert.equal(meta.height, 630);
        assert(sources.includes('fixture-logo.png')); assert(sources.includes('fixture-banner.png'));
        if (process.env.TEST_ARTIFACTS) fs.writeFileSync(path.join(process.env.TEST_ARTIFACTS, 'business-social-preview.jpg'), bytes);
        visible = false;
        for (const route of [`network/companies/${companyId}`, `share/companies/${companyId}`, `share/companies/${companyId}/preview/fixture.jpg`]) {
            assert.equal((await fetch(`${base}/${route}`)).status, 404, `Hidden company is inaccessible: ${route}`);
        }
        console.log('PASS: public company page, public fields only, banner and logo social image, metadata, and immediate withdrawal of hidden company previews.');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
