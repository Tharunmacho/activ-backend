# Association update delivery channels

Admin create and edit payloads accept `deliveryChannels` with exactly three boolean keys:

```json
{ "deliveryChannels": { "email": true, "whatsapp": false, "push": false } }
```

Any combination is valid, including all false for a feed-only update. A JSON-encoded object is also accepted for the existing multipart banner upload route. Partial objects, extra keys, null, arrays and string-valued booleans return HTTP 400.

New announcements that omit the field store all false. Existing announcements created before this field was introduced retain all channels enabled when the stored field is absent. An edit or status-only action that omits the field preserves the stored policy. Admin responses include the effective full object; member and public content responses omit the delivery configuration. No migration or replay of existing announcements is required.

The selection controls email, WhatsApp and device/browser push independently. Member preferences, WhatsApp consent, audience and regional restrictions, publication dates, and enabled device registrations still apply. Selecting push covers eligible member devices and, when the update separately includes visitors, visitor devices. The member notification feed and explicitly public visitor feed remain available even when every outbound channel is off.

Channel changes are material publication revisions. Workers and manual retry reviews/confirmation check the latest source and channel policy. Disabled channels cannot be queued or sent by a stale publication, and a reviewed retry cannot bypass a subsequent channel change. Public feed eligibility is checked separately from visitor push eligibility. The content hash for legacy announcements with an absent field remains unchanged.

Creation and status-change audit metadata include the effective channels. A queue item cancelled after a final pre-send check is recorded as skipped; any corresponding delivery attempt log records the reason and disables automatic retries. Delivery reports use the queue's skipped outcome.

Verification: `node tests/association-update-channels-local.test.js` uses a disposable loopback MongoDB and intercepted email, WhatsApp, member push and visitor push adapters. It covers all eight combinations, defaults, strict validation, multipart input, legacy hashes/queues, preferences/devices, feeds, queued revisions and retry rechecks. It makes no production writes or real sends.
