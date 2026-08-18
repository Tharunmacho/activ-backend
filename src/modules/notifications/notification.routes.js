const express = require('express');
const notificationService = require('./notification.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');
const { verifyToken } = require('../../core/middleware/auth');

const router = express.Router();

router.use(verifyToken);

router.get('/', asyncHandler(async(req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const result = await notificationService.getUserNotifications(req.user.userId, parseInt(page), parseInt(limit));
    res.json(ApiResponse.success(result));
}));

router.patch('/:id/read', asyncHandler(async(req, res) => {
    const notification = await notificationService.markAsRead(req.user.userId, req.params.id);
    res.json(ApiResponse.success(notification));
}));

router.patch('/read-all', asyncHandler(async(req, res) => {
    await notificationService.markAllAsRead(req.user.userId);
    res.json(ApiResponse.success(null, 'All notifications marked as read'));
}));

module.exports = router;