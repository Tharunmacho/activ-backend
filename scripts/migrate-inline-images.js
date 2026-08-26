/**
 * Move base64 images out of the database and onto disk.
 *
 * The website's product forms used to post the image as a base64 data URL in a
 * JSON `imageUrl` field. `createProduct` accepts a body `imageUrl`, so the whole
 * picture was written into the product document instead of to /uploads.
 *
 * That is not a tidiness problem. A single 2.19 MB product made every query that
 * returned it take about seven seconds against the remote cluster, measured
 * against 141ms for the same query with the field excluded — a 49x difference,
 * on five documents. `GET /business-profiles/discover` returns every company
 * with its catalog, so the Discover screen paid that cost on every search.
 *
 * This decodes each inline image, writes it under /uploads with the same naming
 * convention multer uses, and rewrites the field to the relative path everything
 * else stores.
 *
 *   node scripts/migrate-inline-images.js            # dry run
 *   node scripts/migrate-inline-images.js --confirm  # apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--confirm');
const UPLOADS = path.join(__dirname, '..', 'uploads');

const EXT = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
};

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/** Decode a `data:` URL, or return null when the value is a normal path. */
const decode = (value) => {
    const raw = String(value || '');
    const m = /^data:([^;,]+);base64,(.*)$/is.exec(raw);
    if (!m) return null;
    const mime = m[1].toLowerCase();
    return { mime, ext: EXT[mime] || '.jpg', buffer: Buffer.from(m[2], 'base64'), rawLength: raw.length };
};

const writeFileFor = (prefix, decoded) => {
    const name = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}${decoded.ext}`;
    if (APPLY) fs.writeFileSync(path.join(UPLOADS, name), decoded.buffer);
    return `/uploads/${name}`;
};

(async () => {
    if (APPLY && !fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

    await mongoose.connect(process.env.MONGODB_URI, { minPoolSize: 2 });
    console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — connected\n`);

    const Product = require('../src/models/Product');
    const Company = require('../src/modules/members/company.model');

    let converted = 0;
    let reclaimed = 0;

    // ---- products -----------------------------------------------------------
    // `imageUrl` is only read back, never matched on, so a projection is enough
    // to find the offenders without pulling every document in full.
    const products = await Product.find({ imageUrl: /^data:/ }).select('_id name imageUrl').lean();
    console.log(`products with an inline image: ${products.length}`);
    for (const p of products) {
        const d = decode(p.imageUrl);
        if (!d) continue;
        const url = writeFileFor('product-img', d);
        console.log(`  ${String(p.name).padEnd(24)} ${kb(d.rawLength)} -> ${url}`);
        if (APPLY) await Product.updateOne({ _id: p._id }, { $set: { imageUrl: url } });
        converted++;
        reclaimed += d.rawLength;
    }

    // ---- companies ----------------------------------------------------------
    // No company should have one — `createBusinessProfile` has never read a body
    // `logo` — but the same shape is checked so a stray row cannot hide here.
    const companies = await Company.find({ logo: /^data:/ }).select('_id businessName logo').lean();
    console.log(`\ncompanies with an inline logo: ${companies.length}`);
    for (const c of companies) {
        const d = decode(c.logo);
        if (!d) continue;
        const url = writeFileFor('company-logo', d);
        console.log(`  ${String(c.businessName).padEnd(24)} ${kb(d.rawLength)} -> ${url}`);
        if (APPLY) await Company.updateOne({ _id: c._id }, { $set: { logo: url } });
        converted++;
        reclaimed += d.rawLength;
    }

    console.log(`\n${converted} document(s) ${APPLY ? 'converted' : 'would be converted'}, ${kb(reclaimed)} moved out of the database.`);
    if (!APPLY && converted > 0) console.log('Re-run with --confirm to apply.');

    await mongoose.disconnect();
})().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
