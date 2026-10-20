# Amazon SES setup for ACTIV

Reviewed 20 October 2026. This guide describes the proposed setup; it does not
claim AWS configuration, approval, test delivery or production deployment is
complete.

SES will send ACTIV's automated email. The existing backend continues to manage
membership, bookings, reminders and retries. Members still see
`events@activ.org.in` or `member@activ.org.in`. Your existing inboxes keep receiving
replies. WhatsApp remains a separate service.

## 1. Choose the account and cost options

SES is pay-as-you-use: there is no upfront software purchase. For ACTIV's expected
volume, choose **a-la-carte pricing with shared IPs**.

| Monthly recipient deliveries | A-la-carte | Essentials |
| --- | ---: | ---: |
| 1,000 | $0.10 | $0.16 |
| 10,000 | $1.00 | $1.60 |

These are base sending charges; data, tax and optional services are additional.
Count all recipients, including office archive copies. Essentials includes SES
deliverability monitoring. Dedicated IPs and inbound Mail Manager are unnecessary
for this setup. [SES pricing](https://aws.amazon.com/ses/pricing/)

New account/region combinations default to Essentials. In SES **Pricing plan**,
choose **Cancel plan** to return to a-la-carte. The first cancellation of
automatically assigned Essentials is immediate; other downgrades take effect at
the next billing cycle. Review any enabled extras separately.
[Plan management](https://docs.aws.amazon.com/ses/latest/dg/pricing-plans.html)

Use a **client-owned Business AWS account**, with the client's legal name,
organization-controlled contact details and payment method. Complete AWS's
identity verification. Personal and Business accounts have the same features;
Business is appropriate for ownership and billing, not a sending-price discount.
[India account setup](https://docs.aws.amazon.com/accounts/latest/reference/managing-accounts-india.html)

For production, select the **AWS Paid account plan**. This enables pay-as-you-go
billing and full service access; it does not itself mean a fixed subscription.
The Free account plan ends after six months or when credits run out, whichever
comes first, and then closes automatically unless upgraded. Paid account status
does **not** grant SES production approval: complete step 5 separately.
[AWS account plans](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html)

**Basic Support is included at no additional charge.** It covers account/billing
help and quota requests, but not technical support cases. A paid support
subscription is a separate choice from the AWS account plan and SES pricing.
[AWS Support](https://aws.amazon.com/premiumsupport/faqs/)

AWS India normally charges 18% GST: 9% CGST plus 9% SGST in Delhi, or 18% IGST
elsewhere. If GST-registered, enter the client's valid GSTIN and matching
registered address in Billing **Tax Settings**. Correct invoices may support
eligible input tax credit under applicable rules; Business status/GSTIN does not
automatically waive AWS India GST. Confirm eligibility with the client's
accountant. [AWS India tax guidance](https://aws.amazon.com/tax-help/india/)

## 2. Select Mumbai and verify the domain

Select **Asia Pacific (Mumbai), `ap-south-1`** in SES. Keep the following setup in
that region. The SMTP endpoint is `email-smtp.ap-south-1.amazonaws.com`.
[Regional endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html)

1. Open **Configuration -> Identities -> Create identity**.
2. Select **Domain** and enter `activ.org.in`, without `https://` or `www.`.
3. Retain **Easy DKIM**, 2048-bit signing and enabled DKIM signatures.
4. Create the identity. Under **Authentication -> Publish DNS records**, copy
   all three generated CNAME records into your existing DNS provider.
5. Wait for domain/DKIM verification to succeed. Propagation can take up to
   72 hours.

Use AWS's actual DNS values. Domain verification permits ordinary sending from
both ACTIV addresses; separate email verification is unnecessary just to retain
those From addresses. [Identity setup](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)

## 3. Preserve inbox delivery and optionally customize MAIL FROM

**Keep the existing `activ.org.in` MX records.** They deliver incoming mail to
your current inboxes. Do not replace them with an SES receiving endpoint.

Optionally configure an unused MAIL FROM subdomain, such as
`bounce.activ.org.in`, in the SES identity. Do not reuse `mail.activ.org.in`.
Publish AWS's generated records only at the new subdomain:

| Name | Type | Value |
| --- | --- | --- |
| `bounce.activ.org.in` | MX | Priority `10`, `feedback-smtp.ap-south-1.amazonses.com` |
| `bounce.activ.org.in` | TXT | `v=spf1 include:amazonses.com ~all` |

That subdomain must have exactly one MX record and no other sending/receiving
purpose. For MX failure, SES offers its default envelope domain or message
rejection; neither switches ACTIV to Brevo.
[Custom MAIL FROM](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)

Keep existing SPF/DMARC policies while adding SES authentication. Aligned DKIM
can satisfy DMARC without custom MAIL FROM. Check authentication on received test
messages before migration. [DMARC guidance](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)

## 4. Set up bounce, complaint and delivery monitoring

Create a **Standard SNS topic in Mumbai**, grant SES publishing permission using
AWS's instructions, and subscribe an operator's email address. Confirm the
subscription. In **Identities -> activ.org.in -> Notifications -> Feedback
notifications**, select topics for bounces, complaints and deliveries. If you
also create individual email identities, configure their notifications too.
SNS usage costs extra. [Feedback setup](https://docs.aws.amazon.com/ses/latest/dg/configure-sns-notifications.html)

In **Configuration -> Suppression list -> Account-level settings**, enable
**BOUNCE** and **COMPLAINT** suppression. Review failures and stop future sends
to hard-bouncing or complaining recipients; do not remove suppression merely to
force delivery. [Suppression settings](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)

ACTIV does not yet ingest SES feedback automatically. Assign someone to monitor
notifications and update recipient eligibility until that integration is built.
Keep feedback forwarding enabled until the intended monitoring route is tested.
For optional delivery-delay reporting, use a configuration set with an SNS event
destination and assign it as the domain default.
[Configuration sets](https://docs.aws.amazon.com/ses/latest/dg/managing-configuration-sets.html)

## 5. Request production access

The regional sandbox allows only verified recipients or simulator addresses,
200 messages per 24 hours and 1 message/second.

Open **Account dashboard -> View Get set up page -> Request production access**.
Supply the public website and select the mail category representing most sends.
Describe membership/account transactions and member/event broadcasts honestly,
including recipient consent and the feedback process actually implemented.
Submit acknowledgements only when accurate.

AWS currently states an initial response within **96 hours**; it may take longer
and approval is not guaranteed. After approval, check the daily and per-second
quotas against expected bursts, including office copies.
[Production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)

## 6. Generate SMTP credentials and prepare backend settings

In Mumbai SES, open **SMTP settings -> Create SMTP Credentials**. Create a
dedicated SMTP IAM user and securely save the credential download. Retain its
SES sending permission. These regional credentials are different from mailbox
passwords and AWS console credentials. One authorized credential pair can send
using both verified-domain addresses.
[SMTP credentials](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html)

The developer should configure these exact backend variables privately:

```dotenv
EMAIL_HOST=email-smtp.ap-south-1.amazonaws.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=<Mumbai SES SMTP username>
EMAIL_PASS=<Mumbai SES SMTP password>
EVENT_EMAIL_TRANSPORT=shared
MEMBER_EMAIL_TRANSPORT=shared
```

Port 587 negotiates STARTTLS; `false` selects that mode. Alternatively use port
465 with `EMAIL_SECURE=true`. Keep certificate verification enabled.
[SMTP TLS](https://docs.aws.amazon.com/ses/latest/dg/smtp-connect.html)

Both `shared` flags select the SES relay for events and membership/account mail.
Visible From addresses remain unchanged. `EMAIL_PASS` takes precedence over the
legacy `EMAIL_PASSWORD`; an explicitly blank password disables sending.

Preserve unrelated settings and the chosen `EMAIL_ARCHIVE_COPY` policy. Store
credentials in deployment secrets, never GitHub or chat.

## 7. Apply settings to the correct source

For ordinary **Dokploy environment variables**, deploy the updated backend and
redeploy every backend/worker instance after saving values. The running container
does not receive dashboard changes automatically.

`EMAIL_CONFIG_FILE` is an optional alternative for a deliberately mounted
configuration file. The project's local setup already selects `.env` this way;
edit the selected file when that mode is enabled. Relative paths resolve from
the backend directory.

The selected file owns all SMTP settings and must include both transport flags.
Use unique, single-line assignments and replace the complete file atomically.
Malformed/missing files stop sending. Updated mailers refresh credentials for
new attempts when this source changes. For production, leave this option unset
unless a suitable mount exists; changing a file on your computer does not update
the server. Credential changes never initiate resends.

## 8. Test and cut over safely

These checks must be performed; they are not completed results:

1. Verify domain/DKIM, production access, quotas and monitoring.
2. Run `node scripts/check-email-readiness.js` from the backend against the
   intended configuration. It authenticates without sending; local success does
   not establish production settings or inbox delivery.
3. Test SES simulator success, bounce and complaint scenarios, accounting for
   archive recipients. Then send controlled test messages from both addresses to
   authorized inboxes: booking, membership, reset and an attachment.
   [Simulator](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html)
4. Inspect From/Reply-To, DKIM/DMARC, actual receipt and AWS feedback. Confirm
   running diagnostics show the SES host for both categories.
5. Keep previous configuration privately for rollback and record cutover time.
   Preserve queue history and current event/content checks.

**Do not reset or replay messages already accepted by Brevo.** They may still
arrive later and duplicate an SES resend. Inspect Brevo's outstanding queue
separately; expired reminders and updates must remain ineligible.

SMTP acceptance means submission. SES delivery feedback means the recipient
mail server accepted the message, not guaranteed inbox placement or immediate
arrival. [Event meanings](https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity.html)
