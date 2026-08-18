const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const productController = require('./product.controller');
const { verifyToken } = require('../../core/middleware/auth');

// Ensure uploads folder exists
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
        cb(null, `product-img-${uniqueSuffix}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

// Apply auth middleware to all routes
router.use(verifyToken);

// Product routes with image upload support
router.post('/', upload.single('image'), productController.createProduct);
router.get('/', productController.getProducts);
// Static paths must stay above '/:id' or Express treats them as an id
router.get('/discover', productController.discoverProducts);
router.get('/stats', productController.getProductStats);
router.get('/activities', productController.getRecentActivities);
router.get('/:id', productController.getProductById);
router.put('/:id', upload.single('image'), productController.updateProduct);
router.delete('/:id', productController.deleteProduct);

module.exports = router;
