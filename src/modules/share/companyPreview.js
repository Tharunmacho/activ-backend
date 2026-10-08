const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiError = require('../../core/utils/ApiError');
const { uploadNameOf } = require('../../core/storage/uploadUrls');
const esc = value => String(value || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
const compact = (value, max) => { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };

async function companyForShare(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw ApiError.notFound('Company not found');
    const company = await require('../members/company.model').findById(id)
        .select('userId businessName businessType description businessActivities mobileNumber email area location banner logo isActive').lean();
    if (!company || company.isActive === false) throw ApiError.notFound('Company not found');
    const allowed = await require('../members/companyPublishing').publishedIds([company.userId]);
    if (!allowed.some(value => String(value) === String(company._id))) throw ApiError.notFound('Company not found');
    const { userId, ...publicCompany } = company;
    return publicCompany;
}
const versionOf = company => crypto.createHash('sha256').update(JSON.stringify(company)).digest('hex').slice(0, 20);
async function localImage(raw, width, height) {
    const name = uploadNameOf(raw);
    if (!name) return null;
    const store = require('../../core/storage/uploadStore');
    if (store.safeRel(name) !== name) return null;
    try {
        const bytes = await require('../../core/storage/imageVariants').readOriginal(store.UPLOADS_DIR, name, store);
        return await require('sharp')(bytes).rotate().resize(width, height, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
    } catch { return null; }
}
async function previewBytes(company) {
    const sharp = require('sharp');
    const [banner, logo] = await Promise.all([localImage(company.banner, 1136, 310), localImage(company.logo, 104, 104)]);
    const detail = [company.businessType, company.area, company.location].filter(Boolean).join(' · ');
    const contact = [company.mobileNumber, company.email].filter(Boolean).join('  |  ');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
      <rect width="1200" height="630" fill="#fff"/><rect x="32" y="24" width="1136" height="310" rx="18" fill="#f1ebff"/>
      <text x="72" y="190" fill="#4b2389" font-family="Arial, DejaVu Sans, Liberation Sans, sans-serif" font-size="50" font-weight="700">ACTIV Network</text>
      <rect x="32" y="358" width="104" height="104" rx="18" fill="#f1ebff"/>
      <text x="60" y="424" fill="#4b2389" font-family="Arial, DejaVu Sans, Liberation Sans, sans-serif" font-size="40" font-weight="700">${esc(compact(company.businessName, 2))}</text>
      <text x="164" y="400" fill="#15132e" font-family="Arial, DejaVu Sans, Liberation Sans, sans-serif" font-size="37" font-weight="700">${esc(compact(company.businessName, 47))}</text>
      <text x="164" y="446" fill="#625d77" font-family="Arial, DejaVu Sans, Liberation Sans, sans-serif" font-size="25">${esc(compact(detail, 78))}</text>
      <text x="32" y="504" fill="#45415b" font-family="Arial, DejaVu Sans, Liberation Sans, sans-serif" font-size="25">${esc(compact(company.description || company.businessActivities, 91))}</text>
      <text x="32" y="552" fill="#45415b" font-family="Arial, DejaVu Sans, Liberation Sans, sans-serif" font-size="23">${esc(compact(contact, 95))}</text>
      <path d="M32 578H1168" stroke="#e4dcf6"/>
      <text x="32" y="613" fill="#542697" font-family="Arial, DejaVu Sans, Liberation Sans, sans-serif" font-size="21" font-weight="700">ACTIV NETWORK</text>
      <text x="1168" y="613" text-anchor="end" fill="#625d77" font-family="Arial, DejaVu Sans, Liberation Sans, sans-serif" font-size="21">activ.org.in</text>
    </svg>`;
    const layers = [];
    if (banner) layers.push({ input: banner, top: 24, left: 32 });
    if (logo) layers.push({ input: logo, top: 358, left: 32 });
    return sharp(Buffer.from(svg)).composite(layers).jpeg({ quality: 86 }).toBuffer();
}
module.exports = { companyForShare, versionOf, previewBytes };
