# Notification delivery reports

Super Admin → Notifications → **Delivery reports** (website) or **Reports** (app) shows the existing notification flow in one place. The Automation and Delivery log / Setup views remain available for configuration, delivery health, and eligible retries.

1. Choose publications, automations or all activity, a channel and an IST date range. The initial range is the last 30 days; clearing the dates includes older history.
2. Select a publication revision or automation type. Each materially changed publication has a separate report. Pending publications appear before recipient preparation completes; their counts increase during processing.
3. Search for a name, email, phone or booking reference. Select a delivery outcome or **No confirmed open** to identify contacts for review.
4. Open a recipient row to see the recorded provider timeline, timestamps, attempts and failure/skip reason. Viewing a report never sends a message.
5. Use **Review failed deliveries** for the current filters, or **Review resend** on an individual failed record. Review the eligible count and exclusions, then explicitly confirm the resend. The same flow is available for publication and automation failures on web and mobile. Read the result before reviewing another batch.
6. Filtered batch review starts with the newest 100 failures. For older failures, select **Failed**, navigate the recipient pages, and use **Review failed deliveries on this page** to review the visible failures together. Narrow the date, activity, or search filters to review a smaller batch. Ineligible failures remain in the report with their reasons.

On the website, select a summary card to filter and focus its recipient records. **Accepted / in inbox** includes records that later became delivered, opened or marked read; the separate **Provider accepted / in inbox** dropdown option selects that exact recorded state. Channel cards toggle the selected channel while preserving the other filters. Recipient identities are distinct identities, while the rows are delivery records, so one person can appear in several rows.

## Clear history manually

**Clear logs** reviews all history matching the current category and filters, across every page. Confirm once to clear the reviewed records. On a booking, it includes both records with a booking reference and older records matched to the booking's recipients, including records beyond the screen's display limit. Individual **Delete** actions still select only that row.

The review shows how many records can be cleared and why others must stay. Pending sends and active retries remain visible. Records that change after review are retained, and new messages arriving after the selection was captured stay in history. When no records are retained, the history counts return to zero; the next new record starts the count at 1. Member inbox messages, original delivery outcomes and duplicate-send protection are preserved. Clearing history does not send messages or disable existing automatic retry rules.

A full selection is limited to 10,000 matching records. If it exceeds that limit, the review fails before clearing anything; narrow the dates or other filters and clear each selection. During a slow or interrupted clear, continue the same reviewed operation to check the current batch and finish the remaining batches.

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
- `POST /notifications/history/delete-preview`: Super Admin only. `{ view: 'logs' | 'reports', filters, all: true }` captures the full matching selection, with an explicit error above 10,000 records. Explicit `ids` can replace `filters`. The response contains aggregate `matched`, `reviewed`, `eligible`, `retained`, `reasons`, the full eligible `ids`, and `batches: [{ ids, token, eligible }]`; each batch has at most 500 IDs and its own actor-bound, expiring token. For a full review, top-level `token` is empty, `remaining` is zero and `truncated` is false. `{ view: 'logs', filters: { bookingRef }, all: true }` includes canonical legacy recipient matches as well as tracked booking records. Preview writes nothing.
- `POST /notifications/history/delete`: confirms one immutable `{ ids, token }` batch. Clients confirm the frozen batches sequentially after one user confirmation, retain the current token if interrupted, and count each completed batch result once. Repeated submissions return the existing result; `processing: true` is not a completed result. The server rechecks each record's version and sending state before hiding it from admin history. No new selection is fetched while clearing. Existing callers without `all: true` retain the original single-batch limit of 500.
- `POST /notifications/reports/retry-preview`: Super Admin only. Reviews the current failed-record filters or explicit report row IDs; returns an actor-bound, expiring confirmation token. Preview sends nothing. Large selections are bounded and report any remaining records requiring another review.
- `POST /notifications/reports/retry`: Super Admin only. Requires the exact reviewed IDs and token. Rechecks current source, recipient and delivery state, preserves attempts and records an audit. Duplicate confirmations reuse the existing batch result. Failed email and WhatsApp deliveries reuse their original sending workflows; eligible push failures requeue their existing record. Existing inbox records are not recreated.
- `GET /notifications/reports/retry-status`: Super Admin only, with the review token in `X-Delivery-Retry-Token`. Retrieves the existing batch result after a slow or interrupted confirmation without sending again.
- Retry excludes accepted, delivered, read, replaced, opted-out, obsolete, or uncertain/partially accepted outcomes. Email/WhatsApp report retries are limited to recent history (30 days); push alerts must still be within their current validity window. Credential messages require their account workflow. A retry cannot guarantee provider acceptance; recorded reasons explain exclusions and new failures.
- `PATCH /notifications/:id/open`: owner-authenticated member tap, body `{ "channel": "push" }` or `{ "channel": "in_app" }`. Records the first timestamp idempotently. It does not expose another account's notification.
- Push taps use the first open timestamp, separate from in-app marked-read/opened timestamps. Visitor reporting reads the corresponding public notice delivery records.
- Reports batch-resolve member names across the project's separate members database. Notification/provider joins remain in the notifications database.
- `node backend/tests/delivery-report-local.test.js` exercises real aggregation and access controls against disposable local Mongo, without provider calls.
- `node backend/tests/notification-history-local.test.js` verifies full and legacy reviews, chunk replay, records changed between chunks, new arrivals, pending/inbox/deduplication preservation, count reset, booking selections beyond both display limits, and explicit oversized-selection rejection against disposable local Mongo. No provider is contacted.
- After building the website, `node website/tests/delivery-report-browser.test.mjs` exercises card filters, keyboard controls, pagination and aligned recipient columns in headless Chrome at 320, 390, 768 and 1440 px with isolated fixture data. Screenshots are saved to `artifacts/delivery-report`.

Production validation still requires deploying backend + website and a new app build. Provider callbacks and device permission/configuration must be working for delivery evidence to appear; no migration or fabricated historical read backfill is performed.
