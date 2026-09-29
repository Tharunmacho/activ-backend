const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '../../../uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer configuration
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Create unique filename: fieldname-timestamp.ext
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

// File filter (optional but good for security)
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Not an image! Please upload only images.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: fileFilter
});

/**
 * MEMBER PHOTOS — one folder per member, kept for good.
 *
 *   uploads/members/<name-slug>-<memberId>/profile-<timestamp>.<ext>
 *
 * Every upload is a new file; nothing earlier is overwritten or deleted, so a
 * photo a member once had can never vanish from under a page still showing it.
 * `persistUploadsMiddleware` copies the file to the bucket under the same
 * relative path, and `/uploads` serves it from disk, bucket or GridFS alike.
 */
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const memberSlug = (name) => String(name || '')
    .normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().toLowerCase().replace(/[\s_-]+/g, '-').slice(0, 40) || 'member';

const memberPhotoStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const id = String((req.user && (req.user.userId || req.user.id || req.user._id)) || '').replace(/[^\w]/g, '');
        if (!id) return cb(new Error('Sign in to upload a photo'));
        // The name is looked up once per request, not trusted from the body.
        const MemberDetails = require('../../modules/members/memberdetails.model');
        MemberDetails.findById(id).select('fullName').lean()
            .catch(() => null)
            .then((member) => {
                const folder = `${memberSlug(member && member.fullName)}-${id}`;
                const dir = path.join(uploadDir, 'members', folder);
                fs.mkdir(dir, { recursive: true }, (err) => cb(err || null, dir));
            });
    },
    filename: function (req, file, cb) {
        const ext = IMAGE_EXT[String(file.mimetype || '').toLowerCase()] || '.jpg';
        cb(null, `profile-${Date.now()}${ext}`);
    }
});

upload.memberPhoto = multer({
    storage: memberPhotoStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter
});
upload.UPLOAD_DIR = uploadDir;

module.exports = upload;
