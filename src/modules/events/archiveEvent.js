const Event = require('./event.model');
const ApiError = require('../../core/utils/ApiError');
const auditService = require('../audit/audit.service');

/** Remove public visibility without destroying financial or attendee history. */
module.exports = async function archiveEvent(id, actor = {}) {
    if (!/^[a-f0-9]{24}$/i.test(String(id || ''))) throw ApiError.badRequest('Invalid event id');
    const event = await Event.findOneAndUpdate({ _id: id, archivedAt: null }, { $set: {
        archivedAt: new Date(),
        archivedBy: String(actor.userId || actor.id || actor._id || ''),
        status: 'draft',
        showOnHome: false,
        showInBanner: false,
        showOnOnboarding: false,
        registrationEnabled: false,
    } }, { new: true }).lean();
    if (!event) {
        const existing = await Event.findById(id).select('_id archivedAt').lean();
        if (existing?.archivedAt) return { id: String(id), deleted: true, archived: true, historyRetained: true };
        throw ApiError.notFound('Event not found');
    }
    await auditService.record({
        action: 'event.archived', category: 'event',
        summary: `Archived event "${event.title || 'Untitled'}"; bookings, payments and attendance retained`,
        actorEmail: actor.email || '', actorRole: actor.role || '',
        targetId: String(id), targetLabel: event.title || '', state: event.state || '',
    });
    return { id: String(id), deleted: true, archived: true, historyRetained: true };
};
