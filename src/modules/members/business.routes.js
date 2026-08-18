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
router.post('/business-profiles', upload.single('logo'), businessController.createBusinessProfile);
router.get('/business-profiles/me', businessController.getBusinessProfile);
router.get('/business-profiles/all', businessController.getAllBusinessProfiles);
router.get('/business-profiles/discover', businessController.discoverCompanies);
router.get('/business-profiles/:id', businessController.getBusinessProfileById);
router.put('/business-profiles/me', upload.single('logo'), businessController.updateBusinessProfile);
router.put('/business-profiles/:id', upload.single('logo'), businessController.updateBusinessProfileById);
router.delete('/business-profiles/me', businessController.deleteBusinessProfile);
router.delete('/business-profiles/:id', businessController.deleteBusinessProfileById);

module.exports = router;
