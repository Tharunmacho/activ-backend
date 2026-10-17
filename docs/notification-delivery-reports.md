# Notification delivery reports

Super Admin → Notifications → **Delivery reports** (website) or **Reports** (app) shows the existing notification flow in one place. The Automation and Delivery log / Setup views remain available for configuration, delivery health, and eligible retries.

1. Choose publications, automations or all activity, a channel and an IST date range. The initial range is the last 30 days; clearing the dates includes older history.
2. Select a publication revision or automation type. Each materially changed publication has a separate report. Pending publications appear before recipient preparation completes; their counts increase during processing.
3. Search for a name, email, phone or booking reference. Select a delivery outcome or **No confirmed open** to identify contacts for review.
4. Open a recipient row to see the recorded provider timeline, timestamps, attempts and failure/skip reason. Viewing a report never sends a message. Existing Automation retry controls retain their original eligibility and consent checks.

On the website, select a summary card to filter and focus its recipient records. **Accepted / in inbox** includes records that later became delivered, opened or marked read; the separate **Provider accepted / in inbox** dropdown option selects that exact recorded state. Channel cards toggle the selected channel while preserving the other filters. Recipient identities are distinct identities, while the rows are delivery records, so one person can appear in several rows.

## What the figures mean

| Figure | Evidence |
| --- | --- |
| Recipient identities | Unique signed-in accounts and anonymous installations. An unregistered email address and phone can be separate contact identities when there is no account linking them. |
| Delivery records | One current recipient-channel outcome. A member receiving email, WhatsApp, push and an inbox notice contributes four records. Superseded retry attempts remain in the audit log, and are not counted again here. |
| Provider accepted | SMTP, WhatsApp or Firebase accepted the request. This does not assert inbox/device delivery. |
| Delivered | WhatsApp provider callback reports delivered or read. |
| Confirmed opens | WhatsApp read receipts, authenticated member notification opens, anonymous public-feed opens, and recorded push taps. |
| Marked as read | A member cleared an inbox notification. Mark-all-read is not a confirmed open. |
| Skipped / not sent | Includes absent devices, disabled preferences, obsolete content, or mock/unconfigured provider outcomes. The row explains the reason when recorded. |

WhatsApp open rate uses confirmed deliveries as its denominator. Push tap rate uses accepted sends. Email inbox delivery and opens are not measured by the current SMTP integration. A missing open receipt does **not** prove a person has not read the message. New tap instrumentation starts at deployment; historical opens cannot be reconstructed.

Email acceptance is checked against the intended recipient addresses. Acceptance of an office archive copy alone does not count as success for the recipient; an archive rejection does not override confirmed recipient acceptance. Partial or unconfirmed recipient acceptance is recorded for review and excluded from retries that could duplicate a send. This follows Nodemailer's [partial-recipient result contract](https://nodemailer.com/errors#handling-partial-failures).

Anonymous app visitors are shown as `Visitor · <installation suffix>`. They receive only public content under the separate visitor eligibility rules. Their secret installation key and FCM token never appear in reports. Current content titles/audience labels can differ from an older revision; the revision key and recipient delivery records retain their own identity.

## Implementation and verification

- `GET /notifications/reports`: token + Super Admin role required. Server-side pagination, channel/group/campaign/search/date/outcome filtering. No messages are sent by the endpoint.
- `PATCH /notifications/:id/open`: owner-authenticated member tap, body `{ "channel": "push" }` or `{ "channel": "in_app" }`. Records the first timestamp idempotently. It does not expose another account's notification.
- Push taps use the first open timestamp, separate from in-app marked-read/opened timestamps. Visitor reporting reads the corresponding public notice delivery records.
- Reports batch-resolve member names across the project's separate members database. Notification/provider joins remain in the notifications database.
- `node backend/tests/delivery-report-local.test.js` exercises real aggregation and access controls against disposable local Mongo, without provider calls.
- After building the website, `node website/tests/delivery-report-browser.test.mjs` exercises card filters, keyboard controls, pagination and aligned recipient columns in headless Chrome at 320, 390, 768 and 1440 px with isolated fixture data. Screenshots are saved to `artifacts/delivery-report`.

Production validation still requires deploying backend + website and a new app build. Provider callbacks and device permission/configuration must be working for delivery evidence to appear; no migration or fabricated historical read backfill is performed.
