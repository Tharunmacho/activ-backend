# Passwords and linked sign-in providers

`/auth/me`, `/members/my-profile` and authentication `user` responses include:

- `hasPassword`: whether an existing password credential can be used.
- `linkedProviders`: trusted linked identity names (`google`, `facebook`, `linkedin`), never provider subjects or tokens.
- `passwordStatus`: `set`, `not_set`, or `legacy_unknown`.

New social registrations have `passwordLoginEnabled: false` and no password hash. They can continue using their linked provider without choosing an ACTIV password. A real password save sets the internal marker to true. Ordinary registration still requires a password. Password hashes and reset tokens never appear in profile capabilities.

Legacy OAuth registrations stored random hashes without recording their origin. A hash with a linked provider and no marker is `legacy_unknown`; it may also be a real password. Keep its password login and change-password checks intact. Offer provider login and optional verified-email setup/reset without claiming the old password was user chosen. A legacy hash without linked providers remains `set`. Never infer password absence from the last login method or registration timestamps.

Optional first-password setup uses the existing `/auth/forgot-password` email and `/auth/reset-password` token flow (`portal: "member"`). The public request gives the same response for unknown accounts. A signed-in session or linked provider alone cannot bypass current-password checks on either `/auth/change-password` or member account edits. Member reset tokens are consumed atomically, expire, and are refused when the account/profile has been blocked. Provider identity links survive a password setup/reset.

No migration of existing hashes is required or safe without separate trustworthy provenance. No new collections or dependencies are introduced.

Local verification: `node tests/account-password-capabilities-local.test.js` uses a disposable loopback MongoDB with cached binaries; outgoing email/notification methods are replaced by fixtures. `node tests/oauth-account-onboarding-local.test.js` verifies the existing provider handoff and identity-linking flows.
