const express = require('express');
const controller = require('./member.controller');
const extras = require('./memberExtras.controller');
const validators = require('./member.validators');
const { verifyToken } = require('../../core/middleware/auth');
const upload = require('../../core/middleware/upload');

const router = express.Router();

router.get('/my-profile', verifyToken, controller.getMyProfile);
router.get('/business-info', verifyToken, controller.getBusinessInfo);
router.get('/financial-info', verifyToken, controller.getFinancialInfo);
router.get('/declaration-info', verifyToken, controller.getDeclarationInfo);

/**
 * The two things the mobile paid dashboard shows as placeholders.
 *
 * `Recent Activity` mapped over a local array and the certificate buttons
 * opened an `Alert` — both because there was no endpoint to call. Registered
 * before `/:id` below, or that route would swallow them as ids.
 */
router.get('/recent-activity', verifyToken, extras.listActivity);
router.get('/certificate/:kind', verifyToken, extras.getCertificate);
router.put('/profile', verifyToken, validators.updateMemberValidator, controller.updateMember);

/**
 * Profile photo upload.
 *
 * `upload.any()` rather than `upload.single(...)` because the field name is not
 * agreed across clients: the mobile app sends `photo`, this route was written
 * for `profilePhoto`, and multer rejects the request outright on a mismatch —
 * which is silent from the client's side, since the upload is wrapped in a
 * try/catch that only warns. The controller takes whichever file arrived.
 */
router.post('/profile-photo', verifyToken, upload.any(), controller.uploadProfilePhoto);

/**
 * The path the shipped mobile app actually calls (`/members/:id/photo`). It was
 * never declared, so every upload from the app 404'd. Aliased rather than
 * changed in the app because the installed builds cannot be updated.
 *
 * `:id` is ignored — the photo always belongs to the authenticated caller.
 * Honouring it would let anyone overwrite another member's photo by changing a
 * number in the URL. Declared after the literal routes above so it cannot
 * shadow them.
 */
router.post('/:id/photo', verifyToken, upload.any(), controller.uploadProfilePhoto);

router.get('/', verifyToken, controller.getMembers);

module.exports = router;