# Event confirmation layout and activation

The readable confirmation template separates the event, date, time, venue,
seat count, payment, booking ID, entry reference, and booking link. Map,
language, organiser contact, and other event details are available through
the booking link rather than a crowded Details paragraph. The image-header
variant uses the event poster when available, with the existing default
image behaviour. A plain variant provides the existing no-image fallback.

Free registrations show `Free entry`. Confirmed online payments show the
actual amount and payment label; offline payments show the organiser's
recorded payment. Participant messages identify who booked for them instead
of presenting the booker's payment as a bill.

The new templates require Meta approval. Their ten-variable contract cannot
be enabled on a deployment containing only the old seven-variable sender.
Deploy the updated backend, check approval, then set these Dokploy variables
and redeploy:

```dotenv
BOTBEE_TPL_BOOKING_FLEX=activ_evt_confirmed_readable_v1
BOTBEE_TPL_BOOKING_FLEX_PLAIN=activ_evt_confirmed_readable_plain_v1
BOTBEE_TPL_WEBINAR_FLEX=activ_evt_online_readable_v1
BOTBEE_TPL_WEBINAR_FLEX_PLAIN=activ_evt_online_readable_plain_v1
```

Check approval from the backend:

```sh
node scripts/whatsapp-booking-templates.js --status --only=activ_evt_confirmed_readable_v1,activ_evt_confirmed_readable_plain_v1,activ_evt_online_readable_v1,activ_evt_online_readable_plain_v1
```

The four readable confirmation templates were verified APPROVED on 3 October
2026. They are now the defaults; explicit old flexible confirmation names are
also mapped to the readable replacements. Custom template names and `none`
remain respected. The event banner is the main confirmation's image header,
with a plain confirmation available if the image fails.

The event editor now has an optional `whatsappChannelUrl` field, validated as
`https://whatsapp.com/channel/...`. It is included in booking/reminder emails
and session text. The approved-template route sends the channel as a separate
event-information message after the main confirmation or reminder, to the
booker and each participant. PDFs remain optional supporting documents and
their names are displayed separately from the registered event's name.

Two new templates were submitted on 3 October 2026 and were still PENDING at
the last check. Enable these only after Meta marks them APPROVED:

```dotenv
BOTBEE_TPL_EVENT_CHANNEL=activ_event_channel_v1
BOTBEE_TPL_EVENT_DOCUMENT=activ_event_document_readable_v2
```

Check with:

```sh
node scripts/whatsapp-booking-templates.js --status --only=activ_event_channel_v1,activ_event_document_readable_v2
```

Uploads are served by the API host. Set this on the deployed backend when the
website and upload origins differ:

```dotenv
PUBLIC_MEDIA_URL=https://api.activ.org.in
```

Old absolute `/uploads/` URLs are re-anchored to this media origin (or the
configured public API origin when it is absent). WhatsApp document sends and
resends reject HTML responses instead of forwarding a web page as a PDF.

Deploy the backend and rebuild/deploy the website to expose the new editor
field and sending behavior. The mobile event editor supports the same field.
The public WhatsApp social link is stored in CMS Contact settings and the
footer social list, using the existing WhatsApp icon.

Paid-booking verification uses `node tests/booking-delivery.test.js`: a
successful payment webhook, payer return, reconciliation, and recorded
offline payment each dispatch one confirmation. Concurrent callbacks and
retries do not duplicate that confirmation, and an underpayment is refused.
These checks use fake provider/model methods and send no messages. They
verify application behaviour, not a new live payment's handset delivery.

Additional checks: `node tests/event-notification-content.test.js` verifies
event-specific context, channel rendering, media routing and HTML rejection;
`node tests/cms-field-survival.test.js` verifies that the new field survives
both create and edit.

## Production audit — 7 October 2026

Read-only production notification logs since 5 October 00:00 IST contained
27 WhatsApp attempts, all failed: 16 authentication errors, 7 business-account
lock errors (131031), 3 missing document-template errors (132001), and one
recipient set to ACTIV's own sending number. Membership registration,
application submission/approval, lifetime activation, event booking,
participant confirmation and event-document messages were affected.
The latest confirmed delivery in the inspected logs was 3 October.

A read-only Meta request using the locally configured token returned HTTP 401,
OAuth error 190, subcode 460. No real recipient was messaged during this audit.
The local token may differ from deployment settings; check the deployed values
as well. An HTTP acceptance alone is not proof of delivery: verify a `delivered`
or `read` webhook event.

Recovery steps, in order:

1. In Meta Business Support Home / WhatsApp Manager, review the affected WhatsApp
   Business Account restriction and complete the required verification or review.
   Application code cannot remove an account lock.
2. Generate a valid system-user token for the correct app and WhatsApp assets,
   with `whatsapp_business_messaging` and `whatsapp_business_management` access.
   Store it as `META_ACCESS_TOKEN` in the backend deployment's secrets. Confirm
   `META_PHONE_NUMBER_ID` and `META_WABA_ID` belong to the same account, then
   redeploy. Do not paste the token into a ticket or commit it to Git.
3. Run `node scripts/whatsapp-booking-templates.js --status` from the backend.
   Confirm each configured name and language is APPROVED. In particular,
   `activ_event_document_readable_v2` was missing for the failing sends; either
   obtain approval for it or select an existing approved document template with
   the same five body parameters and DOCUMENT header. The backend now respects
   an explicit `BOTBEE_TPL_EVENT_DOCUMENT=activ_event_document_v1`; it no longer
   silently upgrades this value. The default is v1 until v2 is explicitly enabled.
4. Replace ACTIV's sending number in the affected administrator contact record
   with that administrator's own reachable WhatsApp number.
5. Verify the configured webhook receives Meta message status events, then use
   a designated test recipient to test registration, application submission,
   approval, membership activation, free/paid event confirmation, participant
   confirmation and document delivery. Check `delivered`/`read` in the delivery
   dashboard for each. Live payment tests require the appropriate test gateway.
6. Once delivery is confirmed, use the existing delivery-dashboard resend action
   for still-relevant failed notifications. Review old event dates before resend.

Meta's reference: https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api

Automated verification includes template construction, event payment dispatch,
duplicate suppression, and document configuration tests. It does not establish
successful live delivery while the provider token/account remains blocked.
