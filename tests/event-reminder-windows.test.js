// Pure: reminders go 2 days and 1 day before the start, never late.
const assert = require('node:assert/strict');
delete process.env.EVENT_REMINDER_DEFAULT_HOURS;
const { reminderOffsets, windowClosed } = require('../src/modules/events/eventReminder');
const H = 3600000, start = Date.parse('2026-10-25T09:30:00Z');
assert.deepEqual(reminderOffsets({}).sort((a, b) => b - a), [48, 24]);
assert.deepEqual(reminderOffsets({ reminderOffsetsHours: [72, 2] }).sort((a, b) => b - a), [72, 2]);
const offsets = [48, 24];
assert.equal(windowClosed(start, 48, offsets, start - 47 * H), false, '47h out: the 2-day reminder is due');
assert.equal(windowClosed(start, 48, offsets, start - 23 * H), true, '23h out: the 2-day window has passed');
assert.equal(windowClosed(start, 24, offsets, start - 23 * H), false, '23h out: the 1-day reminder is due');
assert.equal(windowClosed(start, 24, offsets, start + H), true, 'after the start nothing is due');
assert.equal(windowClosed(start, 48, offsets, start - 30 * H), true, 'published 30h out: the missed 2-day reminder is not sent late');
assert.equal(windowClosed(start, 48, offsets, start - 40 * H), false, 'a restart a few hours late still sends it');
console.log('PASS: event reminder windows');
