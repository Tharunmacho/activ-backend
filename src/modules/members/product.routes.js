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
router.get('/low-stock', productController.listLowStock);
router.get('/stock-movements', productController.listStockMovements);
router.get('/:id', productController.getProductById);
router.put('/:id', upload.single('image'), productController.updateProduct);
// Stock and publish are named operations rather than a full PUT: adjusting a
// level should not require sending back the price, and a publish toggle that
// rewrites every field is one stale form away from reverting an edit.
router.post('/:id/stock', productController.adjustStock);
router.patch('/:id/publish', productController.setPublished);
// Not owner-scoped: this is another member saying they looked at it.
router.post('/:id/view', productController.recordProductView);
router.delete('/:id', productController.deleteProduct);

module.exports = router;
