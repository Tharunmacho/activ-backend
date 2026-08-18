const express = require('express');
const controller = require('./member.controller');
const validators = require('./member.validators');
const { verifyToken } = require('../../core/middleware/auth');

const router = express.Router();

router.get('/my-profile', verifyToken, controller.getMyProfile);
router.get('/business-info', verifyToken, controller.getBusinessInfo);
router.get('/financial-info', verifyToken, controller.getFinancialInfo);
router.get('/declaration-info', verifyToken, controller.getDeclarationInfo);
router.put('/profile', verifyToken, validators.updateMemberValidator, controller.updateMember);
router.get('/', verifyToken, controller.getMembers);

module.exports = router;