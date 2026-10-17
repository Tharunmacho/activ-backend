# Account creation and social sign-in

Email/password registration already opens the member dashboard before application completion. Its existing name, contact and region fields remain in place. Google, Facebook and LinkedIn now follow the same dashboard-first behavior for new members after the account identity is securely established.

New social accounts contain a real member credential record and a member profile with `registrationIncomplete: true`, `profileCompleted: false`, `membershipStatus: pending`, `membershipType: none`, and role `member`. An unknown random password is hashed through the existing credential model; no password is sent or displayed. A missing provider name remains blank. Account creation never submits or approves an application. The personal/business/declaration workflow and final submission validation still decide completeness and approval routing.

## Existing accounts and verification

The server associates each authenticated provider subject with the existing MemberAuth ID, not with a mutable provider email. Once associated, that social identity opens the same account even when the provider changes or stops sharing its email. Existing membership, payment and approval status remain unchanged. Both credential and profile blocking rules still apply, and social authentication never grants an administrator role.

A first association is allowed using a trustworthy verified email:

- Google: `email_verified` must be true and the email must be a Gmail address or have Google's hosted-domain claim. Google explicitly warns that a verified third-party email can become stale.
- LinkedIn: `email_verified` must explicitly be true. The email and verification claims can both be absent.
- Facebook, missing claims, and non-authoritative Google email: ACTIV requires its own email verification code before creating or connecting an account. Merely receiving an email field is insufficient.

The email screen tells an existing member to use their existing ACTIV email. A correct code opens that same account without needing the forgotten password. A new address creates a draft account only after verification. Missing provider email can be entered here; it is never trusted without the code.

The browser/app does not supply provider IDs or trusted-email flags. The backend retrieves them through the server-side provider exchange. OAuth state remains bound to the initiating browser cookie and the return client remains allowlisted.

## Verification contract

The provider callback returns a signed, ten-minute handoff. It is not a member access token and contains no email or provider subject. The expiring `OAuthFlow` record holds the pending identity. Public responses are uncached.

`POST /api/v1/auth/oauth/exchange { code }` either returns the normal member session or:

```json
{ "requiresEmailVerification": true, "email": "member@example.com", "provider": "facebook" }
```

The user requests a code through `POST /api/v1/auth/oauth/verify-email { code, email }`, then sends `POST /api/v1/auth/oauth/exchange { code, verificationCode }`. These use the standard `data` response envelope.

Codes are stored as server-keyed HMAC hashes, expire with the handoff, allow at most five guesses, and can be sent at most three times per flow with a sixty-second cooldown. Recipient limits and the existing authentication rate limiter also apply. Codes are sent only to the intended email: the new `privateRecipientOnly` mailer option suppresses office archive copies, and delivery logs never contain the code or message body. Failed delivery does not claim success or create a session.

MongoDB atomically consumes the handoff, preventing concurrent/replayed exchanges across workers without relying on an in-process cache. Deletion removes provider associations using the captured credential ID, invalidates their pending flows, and allows a later fresh registration to associate the provider again. Old deletion retries cannot remove a new account's provider association.

Leaving the web sign-in or verification screen prevents its pending response from storing a session or replacing a newer login. The native screen ignores responses from older attempts and cancels delayed dashboard navigation when the screen closes or a newer callback arrives. A consumed linked flow also rechecks its credential association before account lookup, so a concurrent deletion cannot turn that old callback into a new registration.

## Deployment and checks

No live provider configuration, email, account or deletion was performed during development. Existing provider credentials and exact callbacks must be valid for the deployed API origin. Google uses `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; Facebook uses `FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET`; LinkedIn uses `LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET`. The existing configured membership SMTP sender must accept verification emails. Missing provider credentials leave that provider unavailable; mail failure gives a retryable verification error.

Deploy the backend and website changes together and release a native build containing the verification screen. Older native clients understand direct social sessions but cannot render the new first-association email challenge.

Local tests use temporary loopback MongoDB, fixture provider responses, mocked SMTP, React Native rendering and a local browser fixture. They check new draft accounts, existing-account recovery, identity stability, blocking/admin boundaries, email-code limits, concurrency/replay, deletion cleanup, dashboard navigation and responsive verification forms. Real provider consent and email deliverability require deployment smoke checks with authorized test accounts.

References: [Google backend authentication and authoritative email guidance](https://developers.google.com/identity/sign-in/web/backend-auth), [LinkedIn OpenID Connect profile and optional email claims](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2). Meta's documentation endpoints returned HTTP 429 during this review; no undocumented email-verification guarantee is assumed.
