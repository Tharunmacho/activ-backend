const Notification = require('./notification.model');

class NotificationService {
    async createNotification(userId, { title, message, type = 'info', data }) {
        const notification = new Notification({ user: userId, title, message, type, data });
        await notification.save();
        return notification;
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