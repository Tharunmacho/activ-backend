const mongoose = require('mongoose');
const Notification = require('./notification.model');
const logger = require('../../config/logger');

class NotificationService {
    async createNotification(userId, { title, message, type = 'info', data }) {
        const notification = new Notification({ user: userId, title, message, type, data });
        await notification.save();
        return notification;
    }

    /**
     * Write a notification, but never let it break the thing that triggered it.
     *
     * Every caller is inside an action that matters far more than the bell icon
     * — approving an application, recording a payment. A notification is a
     * side-effect, so a bad id, a validation error or a momentarily unreachable
     * database resolves to `null` and is logged, rather than turning a completed
     * approval into a 500 the admin will retry against a now-terminal state.
     */
    async safeCreate(userId, { title, message, type = 'info', data } = {}) {
        try {
            const id = userId && userId._id ? userId._id : userId;
            if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return null;
            if (!title || !message) return null;

            return await this.createNotification(id, { title, message, type, data });
        } catch (error) {
            logger.warn('Notification not created', {
                userId: String(userId || ''),
                title,
                error: error && error.message
            });
            return null;
        }
    }

    async getUserNotifications(userId, page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const notifications = await Notification.find({ user: userId })
            .skip(skip)
            .limit(limit)
            .sort({ createdAt: -1 });

        const total = await Notification.countDocuments({ user: userId });
        const unread = await Notification.countDocuments({ user: userId, isRead: false });

        return { notifications, pagination: { page, limit, total, pages: Math.ceil(total / limit) }, unread };
    }

    async markAsRead(userId, notificationId) {
        const notification = await Notification.findOneAndUpdate({ _id: notificationId, user: userId }, { isRead: true }, { new: true });
        return notification;
    }

    async markAllAsRead(userId) {
        await Notification.updateMany({ user: userId, isRead: false }, { isRead: true });
        return true;
    }
}

module.exports = new NotificationService();