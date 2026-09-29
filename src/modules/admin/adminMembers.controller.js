const adminMembersService = require('./adminMembers.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');

/** Admin → Members. The rules live in `adminMembers.service`. */

const list = asyncHandler(async (req, res) => {
    res.json(ApiResponse.success(await adminMembersService.list(req.user || {}, req.query || {})));
});

const setReminders = asyncHandler(async (req, res) => {
    const enabled = req.body && (req.body.enabled === true || req.body.enabled === 'true');
    const row = await adminMembersService.setReminders(req.user || {}, req.params.id, enabled);
    res.json(ApiResponse.success(row, enabled ? 'Renewal reminders switched on' : 'Renewal reminders switched off'));
});

const remindNow = asyncHandler(async (req, res) => {
    res.json(ApiResponse.success(await adminMembersService.remindNow(req.user || {}, req.params.id), 'Reminder sent'));
});

const remindAllExpired = asyncHandler(async (req, res) => {
    const r = await adminMembersService.remindAllExpired(req.user || {});
    res.json(ApiResponse.success(r, `Reminder sent to ${r.sent} member${r.sent === 1 ? '' : 's'}`));
});

module.exports = { list, setReminders, remindNow, remindAllExpired };
