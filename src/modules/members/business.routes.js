const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const businessController = require('./business.controller');
const { verifyToken } = require('../../core/middleware/auth');

// Ensure uploads folder exists in root
const uploadsDir = path.join(__dirname, '../../../uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for disk storage in local /uploads directory
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, `company-logo-${uniqueSuffix}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

// All routes require authentication
router.use(verifyToken);

// Business profile routes
router.post('/business-profiles', upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), businessController.createBusinessProfile);
router.get('/business-profiles/me', businessController.getBusinessProfile);
router.get('/business-profiles/all', businessController.getAllBusinessProfiles);
router.get('/business-profiles/discover', businessController.discoverCompanies);

/*
 * TRUST LIST, and the member-facing company page.
 *
 * DECLARED BEFORE `/business-profiles/:id`. Express matches in the order routes
 * are registered, so a literal path behind a parameter route is a literal the
 * parameter captures: `/business-profiles/trust-list` would arrive at
 * `getBusinessProfileById` with `id = "trust-list"`, which is not a valid
 * ObjectId and answers 404. The same trap is documented for `/settings` behind
 * `/plans/:key` in CLAUDE.md, and it is silent both times — the route exists,
 * the request is authenticated, and the answer is simply wrong.
 */
router.get('/business-profiles/trust-list', businessController.getTrustList);
router.get('/business-profiles/trust-list/ids', businessController.getTrustListIds);
router.post('/business-profiles/trust-list/:companyId', businessController.addToTrustList);
router.delete('/business-profiles/trust-list/:companyId', businessController.removeFromTrustList);

/* "View as member" — the whitelist-projected page any member may open. */
router.get('/business-profiles/public/:id', businessController.getPublicCompany);

router.get('/business-profiles/:id', businessController.getBusinessProfileById);
router.put('/business-profiles/me', upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), businessController.updateBusinessProfile);
router.put('/business-profiles/:id', upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), businessController.updateBusinessProfileById);
router.delete('/business-profiles/me', businessController.deleteBusinessProfile);
router.delete('/business-profiles/:id', businessController.deleteBusinessProfileById);

module.exports = router;
