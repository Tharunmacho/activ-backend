# Required Android updates

The Android app checks its real native `versionCode` against the update that Google Play offers to the current device and account. It uses Google's `com.google.android.play:app-update:2.1.0` availability API and opens the fixed ACTIV listing, `https://play.google.com/store/apps/details?id=in.activ.membership`.

The default policy is enabled with `requireLatestAvailable: true` and `minimumVersionCode: 1`. Every newer Play release that is actually offered to the device then requires an update; administrators do not need to change a minimum number for each release. A higher build number in source or an unpublished AAB does not trigger the gate.

When an update is required, the gate replaces the entire app navigation with an update screen. It provides **Update on Google Play** and **Check again**, and rechecks when the app returns to the foreground. Opening or canceling the store does not itself dismiss the gate. Installing a current build, a confirmed Play response that no update is available, or a disabled server policy can remove the requirement.

## Availability and outage behavior

- A first check that cannot obtain a valid policy or confirm Play availability allows the app to open. An outage alone never creates a new requirement.
- The last valid policy and Play confirmation are saved together. A matching confirmation for the same installed build preserves a requirement through transient network or Play failures.
- A confirmed Play `UPDATE_NOT_AVAILABLE` response clears the saved confirmation, including when a rollout is withdrawn. An unknown or failed Play check is not treated as this response.
- Installing a different build invalidates the old confirmation. A successful disabled-policy response also clears it.
- Policy and Play requests have five-second deadlines. Local storage operations have two-second deadlines.
- The policy is Android-specific; unsupported platforms and binaries without the native module do not gate.

Google Play may offer a release to some users before others during a staged rollout. A device is gated only when Play confirms an installable newer version for that device/account. This prevents requiring an update that the user cannot obtain. The API cannot retroactively add enforcement to app versions that were released before the gate existed: users must first install a gate-capable release.

## Policy API and administration

Public, uncached `GET /api/v1/app-updates/android` returns the following in the standard response `data` envelope. Super admins use `GET` and `PUT /api/v1/app-updates/admin`.

```json
{
  "enabled": true,
  "requireLatestAvailable": true,
  "minimumVersionCode": 1,
  "message": "Please update ACTIV to continue.",
  "packageName": "in.activ.membership",
  "playUrl": "https://play.google.com/store/apps/details?id=in.activ.membership",
  "updatedAt": null
}
```

`PUT` accepts `enabled`, `requireLatestAvailable`, a positive integer `minimumVersionCode` no greater than 2100000000, and an optional message of at most 500 characters. An enabled policy additionally requires `productionAvailableConfirmed: true`, supplied by the explicit release-availability checkbox in SuperAdmin settings. Package and store URL are server-controlled. Writes are audited and stored through the `AppUpdatePolicy` data-layout mapping; reads create no database record. Actor and release-confirmation metadata are not included in the public response.

With `requireLatestAvailable: false`, the app requires an update only when its installed code is below `minimumVersionCode` **and** Play offers a build at or above that minimum. Disabling the policy provides an administrative escape hatch; devices must fetch the changed policy to observe it.

## Release and verification

1. Increase the real Android `versionCode` and build the signed release with the intended package/signing identity. This feature does not publish to Play or modify a production policy.
2. Test with a Play-installed older gate-capable build and an eligible newer build on a Play test track. Check that the gate opens the exact ACTIV listing, remains after canceling, and disappears after the new build is installed. Play availability is not proven by a sideloaded/debug APK or a Jest mock.
3. Test an account outside the rollout, first-launch network failure, a confirmed gate followed by temporary network failure, a withdrawn/unavailable update, and a disabled policy.
4. Release the new version through Google Play. The default latest-available mode automatically applies when Play makes it available to each device. Use the production-availability acknowledgement when explicitly saving an enabled policy; do not acknowledge a release that is not available.

Local verification covers real loopback API authorization, validation, persistence and audit records; mocked native availability/cache transitions; and the whole-app gate's store/retry/foreground behavior. It does not substitute for the Play test-track installation check.

References: [Google Play in-app update integration](https://developer.android.com/guide/playcore/in-app-updates/kotlin-java), [AppUpdateInfo reference](https://developer.android.com/reference/com/google/android/play/core/appupdate/AppUpdateInfo), [Android versioning](https://developer.android.com/studio/publish/versioning), and [Google Play staged rollouts](https://support.google.com/googleplay/android-developer/answer/6346149).
