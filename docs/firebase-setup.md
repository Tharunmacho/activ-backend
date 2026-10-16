# ACTIV: Firebase push, Analytics and sign-in setup

Updated 16 October 2026. The Firebase project `activ-production`, public website settings and backend service account have been supplied locally. Firebase accepted a validation-only send with the local service account; no notification was delivered. Matching Android and iOS apps for `in.activ.membership` were found in Firebase, and their configuration files were downloaded into the local native project. These files are ignored by Git and must also be supplied to the native build machine. The deployed website's worker was still built without its Firebase settings at the last check. Complete the website rebuild, native builds, iOS APNs/signing and real-device activation checks below before treating delivery as live.

Paths below refer to the integration workspace: `frontend/` in the `activ--app` repository, `website/` in `activ-new`, and `backend/` in the workspace. The standalone `activ-backend` repository contains the contents of `backend/` at its root, so omit that prefix when working there.

## Which services to use and what they cost

Use **Firebase Cloud Messaging (FCM)** for Android/iOS notifications and **Google Analytics for Firebase / standard GA4** for app and website usage. Both are listed as no-cost products. Start on **Spark**, without linking a billing account. The implementation sends from the existing ACTIV Node server and MongoDB; it does not require Cloud Functions, Firestore, Firebase Hosting, BigQuery or phone/SMS authentication. [Firebase pricing](https://firebase.google.com/pricing)

Keep ACTIV's existing **Google, Facebook and LinkedIn OAuth sign-in** and existing member database. The local backend has credentials present for all three providers; presence is not proof that the production credentials, provider approvals or redirect URLs are correct. These flows do not create Firebase Auth users or incur Firebase Auth monthly-active-user charges.

Firebase also supports Google and Facebook authentication, and its basic non-phone authentication is different from the upgraded Identity Platform offering. LinkedIn is not a built-in Firebase provider: using generic OIDC requires **Firebase Authentication with Identity Platform**. That conflicts with an unconditional zero-cost requirement at one lakh active users. Identity Platform lists the first 50,000 social/email MAUs free, then $0.0055 per MAU for the next tier: 100,000 social/email MAUs would be about $275/month before tax, assuming all are billable under that tier. Generic OIDC has a separate allowance of only 50 MAUs, then $0.015/MAU. Registered accounts and monthly active users are different counts. We have not enabled this upgrade. [Identity Platform pricing](https://cloud.google.com/identity-platform/pricing), [Firebase OIDC requirements](https://firebase.google.com/docs/auth/web/openid-connect)

This removes Firebase usage fees for the selected push/analytics integration; it cannot make the entire ACTIV service free at one lakh users. Existing API/database/storage, email, WhatsApp, payment gateway and app-store costs remain separate. Keep Firebase billing unlinked, use standard GA4 rather than Analytics 360, and do not enable paid services as part of this setup. Delivery is subject to quotas, device permission and platform availability. [Firebase plans](https://firebase.google.com/pricing)

## 1. Create your project

1. Sign in to the [Firebase console](https://console.firebase.google.com/) with an ACTIV-owned Google account. Create a project, for example `ACTIV Production`; the project ID must be unique.
2. Enable Google Analytics during creation. Create or link a **standard GA4 property**, using India time for reporting. Select the required account/data-sharing preferences yourself.
3. Confirm the project is on **Spark**, with no billing account. Do not enable Identity Platform or phone authentication for this integration.
4. Use a separate project for development/test phones if possible. App files and backend credentials must belong to the same project in each environment.

## 2. Android app

1. In Project settings → Your apps, add an Android app with package **`in.activ.membership`**. This must match `frontend/android/app/build.gradle`; the Kotlin source package `com.activ` is not the application ID to enter in Firebase.
2. Download `google-services.json` and place it at **`frontend/android/app/google-services.json`**.
3. No SHA fingerprint is required for the implemented FCM/Analytics flow. ACTIV's social login uses the existing browser-based backend flow. Add signing fingerprints if you later introduce a native Google/Firebase Auth flow.
4. Run `npm ci` in `frontend`, then build and install the updated app. The Android Google Services plugin, notification permission, small icon and `activ_updates` channel are already wired in.
5. Sign in and allow the Android notification prompt. You can retry under **Account settings → Enable push notifications**. Super Admin has the same controls under **Notifications → Delivery**.

Without the JSON file, development builds still run, but Firebase push and native Analytics stay unavailable. Adding it requires a native rebuild; a website deploy or JavaScript-only refresh is insufficient. [React Native Firebase setup](https://rnfirebase.io/), [Messaging permissions](https://rnfirebase.io/messaging/usage)

## 3. iOS app, when releasing on iPhone

1. The Xcode target is configured with bundle identifier **`in.activ.membership`**. Register that identifier under ACTIV's Apple developer team; if ACTIV already owns a different published iOS identifier, use that exact identifier in Xcode and Firebase instead.
2. Add an Apple app in the same Firebase project. Download `GoogleService-Info.plist` to `frontend/ios/Activ/GoogleService-Info.plist` and add it to the **Activ target's resources** in Xcode. Merely copying it into the folder does not add target membership.
3. Select the correct signing team. Enable **Push Notifications**, and **Background Modes → Remote notifications**. Entitlements and the background-mode declaration are included in the project; provisioning must still match the Apple account.
4. In the Apple developer portal, create/use an APNs authentication key. Upload its `.p8` file, key ID and team ID to Firebase Project settings → Cloud Messaging → Apple app configuration. Keep the key private.
5. On a Mac, run `bundle exec pod install` in `frontend/ios`, open `Activ.xcworkspace`, build/sign and test on an iPhone. Static Firebase frameworks and conditional `FirebaseApp.configure()` are already configured.

The iOS app cannot be compiled or APNs-tested in this Windows workspace. Apple developer enrollment/distribution is separate from FCM's no-cost delivery. [React Native Firebase iOS setup](https://rnfirebase.io/messaging/usage/ios-setup)

## 4. Backend delivery credentials

Use **Node 22 or later**; the installed Firebase Admin SDK requires it. Install the backend dependencies with `npm install` (the backend currently ignores its lockfile).

1. In Firebase Project settings → Service accounts, generate a private Admin SDK key, or configure an existing service account with the necessary FCM send permission.
2. Store the key in the **backend host's secret/environment settings**. Choose one method:
   - `FIREBASE_SERVICE_ACCOUNT_JSON`: the complete service-account JSON as one valid JSON value. Keep the private key's `\n` escapes intact. In a local dotenv file, a single-quoted one-line JSON value is convenient; a hosting dashboard usually needs the JSON without shell quotes.
   - `GOOGLE_APPLICATION_CREDENTIALS`: an absolute path to a private, readable JSON secret file mounted on the backend host.
3. Set `FIREBASE_PROJECT_ID` to the project's ID, `PUSH_ENABLED=true`, and `NOTIFICATION_WORKER_ENABLED=true`.
4. Confirm the **Firebase Cloud Messaging API (HTTP v1)** is enabled for the project. Do not use a legacy server key.
5. Deploy/restart the backend with these settings. Do not replace the existing database, payment or OAuth settings. `backend/.env.firebase.example` lists the new settings without secrets.

Never put the service-account JSON or private key in `google-services.json`, a `VITE_` variable, the website, the APK, source control, screenshots or chat. The project-specific app config and typical service-account filenames are ignored by Git. Restrict server credentials to the backend host. [Admin SDK sending](https://firebase.google.com/docs/cloud-messaging/send/admin-sdk)

**Super Admin → Notifications** shows configured status, registered devices, queued/failed alerts and publications being processed. On mobile, open the Delivery tab. The test button queues a notification only for devices signed in to that Super Admin account. It does not send to members. A configured status means backend settings are present; website build configuration and actual delivery are separate checks. Publishing eligible content queues member notifications automatically.

## 5. Website notifications and Google Analytics

### Website browser push

The website now uses the Firebase JavaScript SDK and a bundled, same-origin
`/firebase-messaging-sw.js` service worker. Copy the public settings from
`website/.env.push.example` into the website's build environment. The web app,
VAPID public key and backend service account must belong to the same Firebase
project. Do not put Admin SDK credentials into any `VITE_` variable.

In Dokploy, supply these `VITE_FIREBASE_*` variables to the website **build**,
then rebuild it; runtime-only environment changes cannot update a Vite bundle.
For the Nixpacks deployment, open the **website application** (`activ-new`) in
Dokploy, set all seven variables from `.env.push.example` under Environment,
save, then **Deploy**. Restart alone cannot change the existing browser bundle.
Check `/firebase-messaging-sw.js` after deployment and enable notifications in
the browser. A successful registration increases the registered device count.
On the backend, privately supply `FIREBASE_SERVICE_ACCOUNT_JSON` (the complete
JSON, preserving escaped newlines), `FIREBASE_PROJECT_ID`, `PUSH_ENABLED=true`
and `NOTIFICATION_WORKER_ENABLED=true`. Remove the local Windows
`GOOGLE_APPLICATION_CREDENTIALS` setting from the container environment unless
you replace it with a real mounted secret path. Deploy the updated backend,
which accepts the `web` platform, before the website.

Members enable browser notifications in Account Settings. Super Admin can use
Notifications → Delivery → Browser notifications, then “Send test to my devices”.
The test includes registered browsers and phones belonging to that admin only.
Test permission denial, foreground alerts, background alerts, notification clicks,
logout and switching accounts. HTTPS is required in production; localhost is
supported for development. iPhone web push requires a supported Home Screen web app.

Web payloads contain generic text and identifiers rather than private content.
The page/worker checks a persisted account ID and session expiry before displaying
or opening an alert. Logout clears that association, closes displayed notifications
and attempts to remove the server registration. Explicit opt-out also deletes the
FCM token. Browser registration refreshes on page load, focus and hourly while open.
FCM authentication alone does not prove delivery: a real browser test remains
necessary after deployment. No Firebase Authentication migration is required.

### Website Google Analytics

1. In the GA4 property linked to Firebase, add a **Web data stream** for `https://activ.org.in`.
2. Copy its measurement ID, starting with `G-`, into **`VITE_GA_MEASUREMENT_ID`** in the website build environment. `website/.env.analytics.example` is the template.
3. Turn off **Enhanced measurement** for this stream, including automatic history-based page views, form interactions and site-search collection. ACTIV emits its own sanitised page events; avoid collecting raw URLs containing booking references, return tokens or member information.
4. Rebuild and deploy the website. Vite reads the ID at build time.
5. On the website, allow usage analytics in the consent banner. Later use **Privacy preferences** to change the choice. In the app use **Share usage analytics** in Account settings (or Super Admin Notifications → Delivery).
6. Check GA4 Realtime/DebugView for `page_view`, `screen_view` and `login` events, then normal reports after processing. Firebase's Analytics area and the linked GA4 property show the app streams; the Web stream reports the website.

Collection starts only after opt-in. The code records route/screen names and a pseudonymous ACTIV member ID for opted-in logins, plus the login method. It does not send member names, email/phone numbers, chat contents, booking references or URL query strings. Advertising consent/ID collection is disabled. Opt-out clears the analytics user ID and disables collection. [Google's PII restrictions](https://support.google.com/analytics/answer/6366371?hl=en), [Native Analytics consent](https://rnfirebase.io/analytics/usage)

## 6. Authentication and “who signed in”

**Super Admin → Settings/System → Audit log → Sign-ins** is the identity-level history: name, email, time and successful authentication method. Search by name/email. Member sessions record `password`, `google`, `facebook` or `linkedin`; administrator password sessions are included. Failed attempts do not appear as successful logins. History begins with this release, so it does not reconstruct old sessions or show every person currently online.

**Firebase Authentication → Users will not contain ACTIV users in this configuration.** Google Analytics shows usage and pseudonymous activity, not a contact directory. ACTIV's own Super Admin history provides the named sign-in record.

Preserve the existing provider apps and credentials. Their backend variables are:

| Provider | Backend secrets | Provider configuration |
| --- | --- | --- |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Web OAuth client; production consent/branding and exact authorised redirect URI |
| Facebook | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | Facebook Login, email permission, exact valid OAuth redirect URI, production access/required reviews |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | “Sign in with LinkedIn using OpenID Connect” product; `openid profile email` scopes; exact authorised redirect URI |

The callback is **`<OAUTH_REDIRECT_BASE>/<provider>/callback`**. If `OAUTH_REDIRECT_BASE` is unset, the code uses `<BACKEND_URL>/api/v1/auth/oauth`. For an API deployed at `https://api.activ.org.in`, set the base to `https://api.activ.org.in/api/v1/auth/oauth` and register:

```text
https://api.activ.org.in/api/v1/auth/oauth/google/callback
https://api.activ.org.in/api/v1/auth/oauth/facebook/callback
https://api.activ.org.in/api/v1/auth/oauth/linkedin/callback
```

Use the actual deployed API host if different, and match it exactly in all provider dashboards. Keep `FRONTEND_URL=https://activ.org.in` and `OAUTH_APP_REDIRECT=activ://auth/social`. Do not register the `activ://` URL as the provider's server callback; the backend uses it only after verifying the provider response and issuing a one-use app handoff.

Test each provider on website and phone using an already-registered ACTIV email. The existing flow matches a verified provider email to the member account. A new email goes through ACTIV registration; a provider that does not return a usable email cannot silently claim an existing account. Registration, membership approval and payment rules continue to apply. [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Facebook Login](https://developers.facebook.com/docs/facebook-login/web/), [LinkedIn OpenID Connect](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2)

## 7. Audience rules and delivery behaviour

| Update audience | Who can read it and receive its notification |
| --- | --- |
| All members | Signed-in member accounts, paid or unpaid |
| Paid members | Active, unexpired paid memberships, including Student and Lifetime |
| Paid members excluding students | Active paid memberships except Student plans, including Business, Aspirant and Lifetime |
| Unpaid members | Accounts without active membership, including expired memberships |
| Business members | Active memberships whose paid plan is for business members |
| Aspirant members | Active memberships whose paid plan is for aspirants |
| Student members | Active paid Student memberships; expired memberships and members who have paid for an upgrade are excluded |
| Lifetime members | Active lifetime members |
| Specific membership plans | Active members holding any selected plan from the membership catalogue, including retired plans with existing holders. Annual plans match the latest paid membership receipt; authoritative lifetime grants match Platinum |

To compose an update, enter a title and message, then optionally upload an image/poster or a document. Uploaded files have a preview or document link and can be replaced or removed; no pasted file URL is required. Choose the audience, select membership plans when needed, and optionally restrict the region. Review the content and recipients before publishing. **Save draft** keeps the update private and permits a title-only draft; **Publish update** requires a title plus a message, summary, image or document. Publishing or revising published content queues notifications for eligible members. Moving it back to draft removes it from member feeds.

Region targeting intersects with membership targeting: a member must match both. The backend applies the same rules to feeds, direct detail URLs, notification recipients, notification reads and the check immediately before push delivery. Selected plans come from the actual paid receipt rather than editable profile fields; pending payments do not qualify. Student members can attend eligible events and learning programmes; the private directory and direct chat show an upgrade prompt. Profile edits cannot upgrade the paid plan. A confirmed paid upgrade unlocks networking.

Published events, association updates, news, galleries and schemes enqueue recipient jobs. Existing membership, approval, payment, booking and message notifications use the same push queue when an in-app notification is created. Drafts and operational changes such as event seat counts do not broadcast. Deleting an event retains its booking records under **Old**; it does not leave a new public event notification.

Jobs persist in MongoDB and resume from a cursor, generating at most 500 recipients per publication batch. Push batches process at most 50 alerts with bounded concurrency, up to 20 recent devices per account. Unique delivery keys suppress duplicate publication retries. Invalid tokens are removed; temporary failures back off and retry up to five times, retaining successful-token hashes. Alerts older than 24 hours are skipped. Delivery is at-least-once: an abrupt crash after provider acceptance can still cause a repeat, and “sent” means provider acceptance, not proof that a person saw it. This is prepared for bounded large-audience processing but has not been load-tested with one lakh active users.

For restricted content, FCM/APNs carries a generic ACTIV alert and route identifiers, rather than the private update body or chat text. The app fetches content using the current signed-in account. Audience visibility is checked again before sending and when reading the bell. Tokens move to the current account on a shared phone and are detached/deleted on logout. Account deletion removes device registrations.

Publishing to an audience should be done through ACTIV's admin pages, so these rules apply. A Firebase console “send to everyone” campaign does not consult ACTIV membership/region rules.

## 8. Online and offline events

- **In person:** enter the venue, address and optional map link. Bookers receive the venue and entry details.
- **Online:** select Online, enter the platform, and paste the registration or meeting URL. The booking page shows “Online event” and the platform, without exposing the URL to public browsing.
- **Direct Zoom/Meet/Teams URL:** a confirmed booking offers **Join online event**.
- **Zoom registration/form URL:** a confirmed booking offers **Complete platform registration**, followed by the platform's instructions for obtaining a personal joining link.
- **Free event:** joining access opens after booking is confirmed. **Paid event:** it opens after verified payment. Pending, cancelled and waitlisted bookings do not receive the protected URL.
- **No URL yet:** the confirmation explains that the organiser has not added joining details. Save the URL on the event later; reopening a confirmed booking reads the latest value. The app does not create or host Zoom/Meet meetings: the organiser creates them with that provider.

## 9. Final activation checks

Run `node scripts/check-firebase-setup.cjs` from the repository root. It reports only presence/matching checks, never private-key values. Local `.env` checks do not inspect deployment-host settings.

After applying the configuration and rebuilding/deploying:

1. Install the app on a real phone, sign in as Super Admin, allow notifications, and send a test to that account's devices.
2. Verify foreground, background and unopened-app notification taps. OS force-stop, denied permission and network restrictions can prevent delivery; reopen the app after force-stop.
3. Publish a Student-only update using test member accounts. Confirm a Student sees it, a business member does not, and the business member cannot open the direct detail URL. Check region, unpaid and lifetime selections too.
4. Change a test Student profile to “business”: networking must remain locked until a real paid upgrade. Confirm events still work.
5. Test a free online booking and a paid test booking. Check the URL is absent before confirmation/payment and that direct meeting versus platform-registration actions are correct.
6. Log out, then log in as another test account on the same phone. Notifications must belong to the new account. Verify the admin test and sign-in audit again.
7. Opt into Analytics and check Realtime; opt out and verify further page/screen events stop. Check the actual production OAuth callback settings for all three providers.

Local automated coverage includes `backend/tests/audience-push-local.test.js`, `backend/tests/push-worker-local.test.js`, `website/tests/browser-push.test.mjs`, the mobile notification tests, the OAuth provider tests and the existing booking/public-content tests. Push tests cover publication revisions, audience and region changes, account availability, device ownership, retries, logout races and notification destinations using disposable data and mocked sends. They do not send messages to real members or prove live FCM/APNs delivery.

Validation passed locally: Android debug assembly with the Firebase native modules, mobile and website TypeScript checks, the website production build, audience/networking/online-booking backend checks, consent checks, and responsive booking-history/filter browser checks. The publication queue test covers 510 recipients over multiple batches with replay deduplication. This is not a production load test or an iOS build.

## 10. Association update email and WhatsApp delivery

Publishing or materially revising an Association Update now also queues **email and WhatsApp** alongside its in-app/push notification. The same selected audience, paid plan and region rules determine recipients. Drafts do not send. Each channel checks the current member, paid receipt, region, publication revision, expiry and preferences immediately before contacting its provider. If the member upgrades, changes region, opts out, or the update is withdrawn or replaced while queued, the old delivery is skipped. Messages already accepted by an external provider cannot be recalled.

**Account Settings → Association updates** lets members enable or disable each channel. Email starts enabled. WhatsApp requires explicit opt-in and records the consent time and normalized number; changing that number requires fresh consent. A phone number or general agreement to membership terms is not treated as WhatsApp permission. These controls apply to association updates; essential account, payment and booking messages retain their existing rules. The member API is `GET/PATCH /notifications/update-preferences`, with `{ email: boolean, whatsapp: boolean }` and `whatsappNumber` in the response.

Email uses the existing membership SMTP account, with ACTIV branding, a personal greeting, readable paragraphs, optional full poster/document button, and links to the signed-in update and notification settings. WhatsApp uses a dedicated approved template with the member's name, update title, short summary, signed-in link and a thank-you. It does not try free-form session messages as a fallback. The poster and document remain available from the full update.

### Activate the WhatsApp template

The existing Meta account and token are reused. No Firebase Auth, new WhatsApp subscription or billing change is required by this integration. The template defaults are below; set them explicitly on the backend host if desired:

```text
ASSOCIATION_UPDATE_WHATSAPP_TEMPLATE=activ_association_update_v1
ASSOCIATION_UPDATE_WHATSAPP_LANGUAGE=en_US
```

The queue starts with the backend API. Leave `NOTIFICATION_WORKER_ENABLED` unset or `true`; `false` pauses the notification worker. Email and WhatsApp do not require Firebase configuration and continue to work with `PUSH_ENABLED=false`. They still require the existing membership SMTP and WhatsApp provider credentials.

Run from the backend directory:

```text
node scripts/association-update-template.js
node scripts/association-update-template.js --status
node scripts/association-update-template.js --submit
```

The first command prints the complete template for review. `--status` is read-only. `--submit` creates only that template if missing; it sends no messages. It requires the existing `META_ACCESS_TOKEN` plus `META_WABA_ID`, with WhatsApp business-management permission. Wait for `APPROVED` and `contractMatches: true`; pending/rejected templates cannot deliver. Broad association announcements use the **MARKETING** category rather than pretending to be a transaction notice. The dedicated template was submitted on 15 October 2026; check its live status using the command above.

**Costs:** Firebase Cloud Messaging itself remains free. WhatsApp Business Platform template messages are not generally free; Meta charges based on delivered message category and recipient market, with any existing provider charges separate. SMTP quotas and prices depend on the current mail provider. This code does not enable billing or promise free unlimited mail/WhatsApp at lakh-user scale. See [official WhatsApp pricing](https://business.whatsapp.com/products/platform-pricing) and [WhatsApp opt-in/template policy](https://business.whatsapp.com/policy).

### Delivery records, retries and safe testing

Super Admin notification logs record these messages as `ASSOCIATION_UPDATE`, separately for email and WhatsApp. `accepted` means the SMTP/WhatsApp provider accepted the request. WhatsApp's existing signed webhook can advance it to sent, delivered, read or failed; email acceptance does not prove inbox delivery. Use the existing retry action after resolving a failed template/sender configuration. Retries repeat all eligibility and consent checks and do not replay old stored content to an ineligible recipient.

The persistent queue uses a claim per recipient/channel, a five-minute lease, bounded sends and backoff for known temporary provider failures. Email and WhatsApp fail independently. Interrupted sends whose outcome is unknown are held for review instead of being automatically duplicated; confirmed acceptance in the audit record is recovered without replay. Old update deliveries expire after seven days. Large campaigns still depend on provider throughput, approved WhatsApp limits and SMTP capacity; this is not a lakh-recipient load-test claim.

```text
node tests/association-update-delivery-local.test.js
node scripts/test-association-update-delivery.js
node scripts/test-association-update-delivery.js --send-email
node scripts/test-association-update-delivery.js --send-whatsapp
```

The automated test uses disposable loopback MongoDB and stubbed providers. It covers audience/plan/region selection, preference changes, drafts, old queued messages, concurrent workers, channel retries and interrupted delivery recovery. Broken connections with an uncertain provider result are held for review; a queue-write failure after acceptance is recorded must not erase that acceptance or repeat the send.

The preview command sends nothing. The two explicit send flags are hard-coded to the user-authorized test email `tharunroobika@gmail.com` and WhatsApp `+919092317264`; no other recipient can be supplied. Test email disables office archive CC/BCC and checks the final SMTP envelope. The script never connects to a member database or publishes an update. It writes an HTML preview and a small acceptance report under `artifacts/` beside the backend directory.

Verification on 15 October 2026: the authorized test email was accepted by SMTP. The read-only Meta check still reports `PENDING`, category `MARKETING`, with `contractMatches: true`; no WhatsApp test has been sent. The current record is `artifacts/association-update-live-test.json`. Wait for template approval before the WhatsApp send check, and do not repeat the already accepted email merely because the laptop or worker restarted.
