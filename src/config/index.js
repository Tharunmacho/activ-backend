require('dotenv').config();

module.exports = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 5000,
    apiVersion: process.env.API_VERSION || 'v1',

    db: {
        uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/activ-db',
        testUri: process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/activ-test',
        options: {
            /**
             * Connection pool sizing, tuned for a remote Atlas cluster.
             *
             * `minPoolSize` was unset, which defaults to 0: the pool starts
             * empty and opens a connection only when a query needs one. Every
             * such open is a TLS handshake plus SCRAM auth against a cluster
             * roughly 100ms away, which costs 1-3 seconds — and the server
             * reported 2,090 connections created against 14 currently open, so
             * this was happening constantly. That is the source of the
             * multi-second stalls that appeared at random on otherwise trivial
             * queries: the query was fast, opening the socket to send it was
             * not.
             *
             * Keeping five connections warm means the common case never pays
             * for a handshake. `maxIdleTimeMS` then retires anything above that
             * floor after a minute rather than holding the whole pool open.
             */
            minPoolSize: 5,
            maxPoolSize: 20,
            maxIdleTimeMS: 60000,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        }
    },

    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT, 10) || 6379,
        password: process.env.REDIS_PASSWORD || '',
        db: parseInt(process.env.REDIS_DB, 10) || 0,
        retryStrategy: (times) => Math.min(times * 50, 2000)
    },

    jwt: {
        secret: process.env.JWT_SECRET || 'your-secret-key',
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
        refreshSecret: process.env.JWT_REFRESH_SECRET || 'your-refresh-secret',
        refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d'
    },

    rateLimit: {
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
        maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 1000
    },

    cors: {
        origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:3000'],
        credentials: true
    },

    /**
     * Outbound mail — ONE definition, read by both senders.
     *
     * `core/utils/mailer.js` (admin welcomes, password resets) and
     * `modules/notifications/email.service.js` (the lifecycle notifications)
     * each built their own transport, and they disagreed about the name of the
     * password variable: one read `EMAIL_PASSWORD`, the other `EMAIL_PASS`.
     * Pasting the credential into either one made half the mail send and the
     * other half silently fall back to mock — with a log line at `info` saying
     * so and nothing else to notice. Both spellings are accepted here and both
     * senders now read this object, so the two cannot drift again.
     *
     * `placeholder` is the second half of that trap. A `.env` shipped with
     * `EMAIL_USER=your-email@gmail.com` is not configured, but it is not empty
     * either, so a plain truthiness check calls it configured and every send
     * fails against a mailbox that does not exist. Anything still carrying a
     * `your-...`/`changeme`/`...here` value is treated as absent.
     */
    email: (() => {
        const PLACEHOLDER = /^(your[-_. ]|changeme|xxx|<|replace)|(_here|-here)$/i;
        const real = (value) => {
            const v = String(value || '').trim();
            return !v || PLACEHOLDER.test(v) ? '' : v;
        };

        const host = real(process.env.EMAIL_HOST);
        const user = real(process.env.EMAIL_USER);
        // Both spellings, `EMAIL_PASS` first because that is what the BotBee /
        // notification setup documents.
        const password = real(process.env.EMAIL_PASS) || real(process.env.EMAIL_PASSWORD);
        const port = parseInt(process.env.EMAIL_PORT, 10) || 587;

        const defaultFrom = real(process.env.EMAIL_DEFAULT_FROM)
            || real(process.env.EMAIL_FROM)
            || user
            || 'events@activ.org.in';

        return {
            host,
            port,
            user,
            password,
            /*
             * 465 is implicit TLS and everything else negotiates STARTTLS, so
             * the port decides this on its own. `EMAIL_SECURE` overrides it for
             * the rare host that disagrees.
             */
            secure: process.env.EMAIL_SECURE
                ? String(process.env.EMAIL_SECURE).toLowerCase() === 'true'
                : port === 465,

            fromName: real(process.env.EMAIL_FROM_NAME) || 'ACTIV',
            /** The envelope address every message is actually sent from. */
            defaultFrom,
            /** Legacy composite value, still read by `core/utils/mailer.js`. */
            from: process.env.EMAIL_FROM || `ACTIV Platform <${defaultFrom}>`,

            /**
             * Put the REGION in the From address, not only in the display name.
             *
             * Off by default, and that default is what makes this work the
             * moment a password is pasted in. A provider will only send from an
             * address the authenticated account owns — Gmail refuses with 553
             * unless the alias is verified under "Send mail as", and a host that
             * does accept it produces SPF/DMARC misalignment that files the
             * message in spam. Until every `district.*@activ.org.in` alias has
             * been created and verified, the From address stays the
             * authenticated one and the region is carried by the display name
             * and the Reply-To, both of which need no verification at all.
             *
             * Turn this on once the aliases are verified.
             */
            useRegionalFrom: String(process.env.EMAIL_USE_REGIONAL_FROM || '').toLowerCase() === 'true',

            /** The domain the derived regional addresses are built under. */
            regionDomain: real(process.env.EMAIL_REGION_DOMAIN) || 'activ.org.in',
            /** Where a reply goes when a region has no staffed admin at all. */
            supportAddress: real(process.env.EMAIL_SUPPORT_ADDRESS) || 'support@activ.org.in',

            get isConfigured() {
                return !!(this.host && this.user && this.password);
            }
        };
    })(),

    /**
     * BotBee WhatsApp.
     *
     * The request SHAPE is configuration, not code. This integration is written
     * against BotBee's documented `app.botbee.io` API, but an endpoint path or
     * an auth style that turns out to differ must be a one-line `.env` change
     * and not a patch to a service file — otherwise the first real send fails
     * silently and the only symptom is a WhatsApp message nobody receives.
     *
     * `node scripts/test-notifications.js --whatsapp` prints the exact URL,
     * headers and body that will be sent, so a mismatch is visible before a
     * single member is messaged.
     */
    /**
     * Meta WhatsApp Cloud API — the direct route, used for TEMPLATES only.
     *
     * WHY IT EXISTS. BotBee's `/send/template` accepts variable values and
     * delivers a literal `-` in every slot. That was measured to exhaustion on
     * 7 Sep 2026 — see `notificationTemplates.js` for the full list of what was
     * tried, including a system field confirmed stored on the subscriber. It is
     * a fault inside the provider, so no amount of work on this side fixes it.
     *
     * Meta's own API is the layer BotBee sits on top of, and its `components`
     * parameter is the documented, universal way to fill a template. Talking to
     * it directly removes the broken hop.
     *
     * TEMPLATES ONLY, DELIBERATELY. Free-text replies stay on BotBee: the
     * inbound webhook, the keyword bot and the session window all live there,
     * and moving them would mean re-pointing Meta's webhook away from BotBee and
     * losing the dashboard. This is the smallest change that fixes the one
     * broken thing.
     *
     * INERT UNTIL A TOKEN EXISTS. With no `META_ACCESS_TOKEN` this is not
     * configured, `isConfigured` is false, and every template send goes to
     * BotBee exactly as before. Adding the token is the entire switch-over;
     * there is no second flag to remember and no code to change.
     *
     *   META_ACCESS_TOKEN     permanent System User token, whatsapp_business_messaging
     *   META_PHONE_NUMBER_ID  defaults to BOTBEE_PHONE_NUMBER_ID — the same number
     *   META_API_VERSION      defaults to v21.0
     */
    metaCloud: (() => {
        const PLACEHOLDER = /^(your[-_. ]|changeme|xxx|<|replace)|(_here|-here)$/i;
        const real = (value) => {
            const v = String(value === undefined || value === null ? '' : value).trim();
            return !v || PLACEHOLDER.test(v) ? '' : v;
        };

        const accessToken = real(process.env.META_ACCESS_TOKEN);
        /*
         * The same handset BotBee already messages from, unless overridden.
         * BOTBEE_PHONE_NUMBER_ID is a Meta phone number id — it is Meta's
         * identifier, not BotBee's — so the default is right and stops the two
         * halves of this integration drifting onto different numbers.
         */
        const phoneNumberId = real(process.env.META_PHONE_NUMBER_ID)
            || real(process.env.BOTBEE_PHONE_NUMBER_ID);

        return {
            accessToken,
            phoneNumberId,
            apiVersion: real(process.env.META_API_VERSION) || 'v21.0',
            baseUrl: (real(process.env.META_BASE_URL) || 'https://graph.facebook.com').replace(/\/+$/, ''),
            timeoutMs: parseInt(process.env.META_TIMEOUT_MS, 10) || 15000,
            isConfigured: !!(accessToken && phoneNumberId)
        };
    })(),

    botbee: (() => {
        const PLACEHOLDER = /^(your[-_. ]|changeme|xxx|<|replace)|(_here|-here)$/i;
        const real = (value) => {
            const v = String(value || '').trim();
            return !v || PLACEHOLDER.test(v) ? '' : v;
        };

        return {
            baseUrl: (real(process.env.BOTBEE_BASE_URL) || 'https://app.botbee.io').replace(/\/+$/, ''),
            apiToken: real(process.env.BOTBEE_API_TOKEN),
            phoneNumberId: real(process.env.BOTBEE_PHONE_NUMBER_ID),

            /** Shared secret BotBee echoes back on the webhook handshake. */
            webhookVerifyToken: real(process.env.BOTBEE_WEBHOOK_VERIFY_TOKEN),

            /*
             * Two spellings each, for the same reason the email password takes
             * two: a variable name that is documented one way and read another
             * is a credential that appears to be set and is not.
             */
            sendTemplatePath: real(process.env.BOTBEE_TEMPLATE_ENDPOINT)
                || real(process.env.BOTBEE_SEND_TEMPLATE_PATH)
                || '/api/v1/whatsapp/send-template',
            sendTextPath: real(process.env.BOTBEE_TEXT_ENDPOINT)
                || real(process.env.BOTBEE_SEND_TEXT_PATH)
                || '/api/v1/whatsapp/send-message',

            /**
             * How the token is presented: `bearer` (Authorization header),
             * `header` (X-API-Key), `body` (a field in the JSON), or `both`.
             * `both` is the default because sending the token in the header AND
             * the body satisfies either convention, and an API that ignores an
             * unexpected field is far commoner than one that rejects it.
             */
            authStyle: (real(process.env.BOTBEE_AUTH_STYLE) || 'both').toLowerCase(),

            /** Reads the approved templates, and the row ids sending needs. */
            templateListPath: real(process.env.BOTBEE_TEMPLATE_LIST_ENDPOINT)
                || '/api/v1/whatsapp/template/list',

            /*
             * Which field carries the template's variables.
             *
             * Empty means "send every plausible spelling", which is the safe
             * default on an endpoint that silently ignores fields it does not
             * recognise: a wrong single guess delivers a message with `#1#`
             * printed in it. Set this once a live test shows which one
             * substitutes.
             */
            templateParamsField: real(process.env.BOTBEE_TEMPLATE_PARAMS_FIELD),

            /**
             * An OVERRIDE for the custom fields a template's variables are bound
             * to. Empty in normal operation, and empty is not a fallback.
             *
             * BotBee does not substitute by position. Its `variable_map` binds
             * each slot to a named custom field — `{"body":{"1":"#name#"}}` on
             * the templates written through BotBee's field picker, and
             * `{"body":{"1":"#1#"}}` on the ACTIV ones, whose bodies were typed
             * as `#1#` and so are bound to fields literally NAMED `1`, `2`, `3`.
             *
             * `botbee.service` now reads that map off each template row and
             * sends the values under whatever names it finds, so this variable
             * has nothing to do in the ordinary case. A WhatsApp template cannot
             * be edited within 24 hours of its last change and cannot be
             * re-approved by Meta on any useful timescale, which makes the
             * binding on the account the fixed point and this code the thing
             * that moves — reading the binding is what lets both spellings work
             * off one code path, with no list here to keep in step by hand.
             *
             * Set it, in slot order, only for a template whose binding the list
             * endpoint does not report:
             *
             *   BOTBEE_TEMPLATE_FIELDS=name,status,next_step
             */
            templateFields: String(process.env.BOTBEE_TEMPLATE_FIELDS || '')
                .split(',')
                .map((v) => v.trim().replace(/^#|#$/g, ''))
                .filter(Boolean),

            /**
             * The approved template name for each kind of message.
             *
             * IN CONFIGURATION BECAUSE META BURNS NAMES. Deleting a template
             * does not release its name immediately: the API refuses new content
             * under the same name and locale while the deletion is still
             * processing ("New English (US) content can't be added while the
             * existing English (US) content is being deleted"), and a REJECTED
             * template holds its name too while remaining invisible in
             * BotBee's list, which only returns Approved rows.
             *
             * That turns a naming collision into a code change on someone else's
             * schedule. Keeping the names here means a burned name costs one
             * `.env` line and a restart: create the template under whatever name
             * BotBee will accept, point the variable at it, done.
             */
            templates: {
                welcome: real(process.env.BOTBEE_TPL_WELCOME) || 'activ_registration_welcome',
                status: real(process.env.BOTBEE_TPL_STATUS) || 'activ_membership_status',
                payment: real(process.env.BOTBEE_TPL_PAYMENT) || 'activ_payment_request',
                event: real(process.env.BOTBEE_TPL_EVENT) || 'activ_event_reminder',
                /*
                 * The detailed event-booking templates. EMPTY BY DEFAULT: until a
                 * name is set here the booking messages go through `event` above,
                 * which is already approved. Set each one only once Meta has
                 * approved it (scripts/whatsapp-booking-templates.js submits them),
                 * and a send that still fails falls back to `event` on its own.
                 */
                /*
                 * The CUSTOM templates (`_v2` in notificationTemplates.js) are
                 * named by default and tried FIRST. While one is still in Meta
                 * review Meta refuses it and the send falls through the chain to
                 * the approved poster template, so nothing is lost; the day it is
                 * approved it becomes the only one sent, with no redeploy.
                 */
                booking: real(process.env.BOTBEE_TPL_BOOKING) || 'activ_event_booking_v3',
                bookingWebinar: real(process.env.BOTBEE_TPL_BOOKING_WEBINAR) || 'activ_webinar_registration_v3',
                bookingCancel: real(process.env.BOTBEE_TPL_BOOKING_CANCEL) || 'activ_booking_cancelled_v2',
                bookingReminder: real(process.env.BOTBEE_TPL_BOOKING_REMINDER) || 'activ_booking_reminder_v3',
                // A participant's seat, booked for them by somebody else (names the booker).
                bookingParticipant: real(process.env.BOTBEE_TPL_BOOKING_PARTICIPANT) || 'activ_participant_seat_v1',
                /*
                 * Two ALREADY-APPROVED templates on the account, both with the
                 * event poster as an image header and the association's full
                 * name as the footer. Used for a confirmation and a reminder
                 * whenever the dedicated one above is not set:
                 *   cnfrm  in person — 13 variables: attendee, venue, date,
                 *          time from/to, seats, amount
                 *   ccmsg  online    — 4 variables: attendee, event, link, email
                 * Set either to `none` to fall back to the generic template.
                 */
                bookingInPerson: real(process.env.BOTBEE_TPL_BOOKING_INPERSON) || 'cnfrm',
                bookingOnline: real(process.env.BOTBEE_TPL_BOOKING_ONLINE) || 'ccmsg'
            },

            /*
             * Used when the template an event asks for is not on the account —
             * a template still in Meta review, or one that was rejected. Set to
             * an empty string to send nothing rather than something generic.
             *
             * IT DEFAULTS TO WHATEVER `BOTBEE_TPL_STATUS` RESOLVES TO, not to a
             * second literal. A hardcoded name here is a name nobody maintains:
             * the moment the status template is created under a different one —
             * which is the whole reason these are in `.env` — the fallback
             * points at a template that is not on the account, and the safety
             * net silently becomes a second way to send nothing.
             */
            fallbackTemplate: process.env.BOTBEE_FALLBACK_TEMPLATE !== undefined
                ? real(process.env.BOTBEE_FALLBACK_TEMPLATE)
                : (real(process.env.BOTBEE_TPL_STATUS) || 'activ_membership_status'),

            /**
             * Send the readable free-text copy alongside every template.
             *
             * ON BY DEFAULT, AND IT IS A WORKAROUND, NOT A FEATURE. BotBee's
             * `/send/template` reports success and renders every variable as a
             * literal `-`; the text copy is the only one that reaches the member
             * with their own name in it, because this codebase builds that
             * string itself. Free text is legal only inside the 24-hour window a
             * member's own message opens, so it cannot replace the template —
             * both go.
             *
             * Set `BOTBEE_ALSO_SEND_TEXT=false` the day the provider substitutes
             * properly, and the member stops receiving two of everything.
             */
            alsoSendText: String(process.env.BOTBEE_ALSO_SEND_TEXT || 'true').toLowerCase() !== 'false',

            timeoutMs: parseInt(process.env.BOTBEE_TIMEOUT_MS, 10) || 15000,

            /** Country code prepended to a bare 10-digit Indian mobile number. */
            defaultCountryCode: real(process.env.BOTBEE_DEFAULT_COUNTRY_CODE) || '91',

            get isConfigured() {
                return !!(this.apiToken && this.phoneNumberId);
            }
        };
    })(),

    upload: {
        maxFileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 5 * 1024 * 1024,
        uploadDir: process.env.UPLOAD_DIR || './uploads'
    },

    /**
     * S3-compatible bucket (Garage) that holds every upload — see
     * `core/storage/objectStore.js`. Unset, uploads fall back to GridFS.
     */
    objectStorage: {
        region: process.env.AWS_REGION || 'garage',
        bucket: process.env.AWS_BUCKET_NAME || '',
        endpoint: process.env.AWS_ENDPOINT_URL || '',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
        /** Key prefix inside the bucket; a file is `<prefix>/<filename>`. */
        prefix: (process.env.AWS_UPLOAD_PREFIX || 'uploads').replace(/^\/+|\/+$/g, ''),

        get isConfigured() {
            return !!(this.bucket && this.accessKeyId && this.secretAccessKey);
        }
    },

    log: {
        level: process.env.LOG_LEVEL || 'info',
        file: process.env.LOG_FILE || 'logs/app.log'
    },

    /**
     * Instamojo, API v1.1 — see the note above `PaymentService`.
     *
     * The default was `https://api.instamojo.com/v2`, which is a DIFFERENT API
     * with a different path spelling and OAuth2 auth. The key/token pair below
     * is v1.1's scheme and the account is a v1.1 account, so the two never
     * matched and every request 404'd. The default is the v1.1 host now, so a
     * deployment that never set `INSTAMOJO_BASE_URL` works rather than failing
     * on the first payment.
     */
    instamojo: {
        apiKey: process.env.INSTAMOJO_API_KEY || '',
        authToken: process.env.INSTAMOJO_AUTH_TOKEN || '',
        privateSalt: process.env.INSTAMOJO_PRIVATE_SALT || '',
        baseUrl: process.env.INSTAMOJO_BASE_URL || 'https://www.instamojo.com/api/1.1'
    },

    payment: {
        /*
         * 'mock' lets the server sign its own payment orders, which is how the
         * flow works with no gateway account connected. It is refused when
         * NODE_ENV is 'production' regardless of what this says, so a forgotten
         * setting cannot ship a free-membership button.
         *
         * Set to 'gateway' once a real provider is wired in.
         */
        mode: process.env.PAYMENT_MODE || 'mock',
        /*
         * The key payment signatures are verified against. Falls back to the
         * JWT secret so a deployment that has not set it still signs with
         * something unguessable; a signature anyone can compute is not a check.
         * Becomes the gateway's key secret on integration.
         */
        signingSecret:
            process.env.PAYMENT_SIGNING_SECRET ||
            process.env.RAZORPAY_KEY_SECRET ||
            process.env.JWT_SECRET ||
            ''
    },

    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
    backendUrl: process.env.BACKEND_URL || 'http://localhost:5000',

    admin: {
        /**
         * Shared passwords accepted for ANY admin account, in addition to that
         * account's own password.
         *
         * This exists only to keep the pre-seeded demo admins reachable while
         * the new super-admin creation flow is being verified. It is a genuine
         * authentication bypass: anyone who knows an admin's email address can
         * sign in as them, which defeats the geofence entirely.
         *
         * Empty by default, so it is off unless a deployment opts in. Remove
         * ADMIN_DEMO_PASSWORDS from the environment once real admins are being
         * created with their own credentials.
         */
        demoPasswords: String(process.env.ADMIN_DEMO_PASSWORDS || '')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean),

        /**
         * Whether the legacy `adminsdb` mirror counts as real staffing for
         * region coverage. See `admin.repository.js`.
         */
        includeLegacyInCoverage:
            String(process.env.ADMIN_COVERAGE_INCLUDE_LEGACY || '').toLowerCase() === 'true'
    }
};