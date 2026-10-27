// Public share text must agree with attendee pages without changing stored event fields.
const assert = require('node:assert/strict');
const { eventShareContent } = require('../src/modules/share/eventShareContent');
const event = { title: 'Business workshop', startAt: '2030-11-01T09:30:00Z',
    endAt: '2030-11-01T12:30:00Z', venue: 'Community Hall', venueAddress: 'Chennai',
    venueMapUrl: 'https://maps.google.com/?q=Community+Hall', registrationFee: 0 };
for (const platform of ['Zoom', 'Google Meet', 'ACTIV room', '']) {
    const online = { ...event, mode: 'online', onlinePlatform: platform,
        onlineUrl: 'https://meet.google.com/private-link' };
    const content = eventShareContent(online, 'https://activ.org.in/events/workshop');
    assert.ok(content.title.endsWith('at Online'));
    assert.ok(content.text.includes('Venue: Online\n'));
    assert.ok(!/Zoom|Google Meet|ACTIV room|Community Hall|Chennai|private-link|maps.google/.test(JSON.stringify(content)));
    assert.equal(online.onlinePlatform, platform, 'Public presentation must not change the saved platform used in notifications');
}
const inPerson = eventShareContent({ ...event, mode: 'offline', onlinePlatform: 'Zoom' });
assert.ok(inPerson.text.includes('Venue: Community Hall, Chennai'));
assert.ok(inPerson.text.includes(event.venueMapUrl));
console.log('PASS public event share labels: Online with saved/blank platform; offline venue and directions preserved.');
