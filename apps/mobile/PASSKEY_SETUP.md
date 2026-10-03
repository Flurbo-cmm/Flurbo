# Native passkey domain setup

Mera and native passkey support are now installed. Android runtime validation is
still required. No generated file or successful build establishes PRF support.

## Current Android certificate

The public certificate below was extracted from the signing block of the existing
EAS preview APK, build `1e365827-9c5e-4092-a8a2-4569b158a534`:

```text
AA:B4:D2:57:75:0A:67:99:36:DA:F1:77:EE:A4:95:03:26:A1:A6:81:3E:3F:BC:38:16:79:A7:BC:E9:95:FD:B4
```

`config/mobile-passkeys.json` records this public fingerprint, package and source
APK digest. The production server serves it at
`https://flurbo.singu.online/.well-known/assetlinks.json`, without authentication
or a redirect, after this update is deployed. This does not upload a keystore.
Keep using the same EAS-managed signing key and verify the next APK's signer.
The Expo plugin `plugins/with-passkey-association.cjs` also installs the Android
app-side `asset_statements` metadata and its web relationship string. The plugin
escapes JSON quotes once for the non-translatable Android resource. Verify the
generated `strings.xml`, since config introspection can show extra escaping.

On September 25, build `317d7f66-161d-4db2-8282-96d3a9f73b4d` (0.3.0 / code 4)
was checked and its APK signing-block certificate matched the fingerprint above.
Its SHA-256 file digest is
`1643081a342f5ed6a5b8008c03957b3da589db95eb655364bd811077c0233662`.
This certificate extraction is not a cryptographic APK signature verification.

The live endpoint initially published only `get_login_creds`. Google's check for
that relation returned `linked: true`, but its `handle_all_urls` check did not.
That earlier check was insufficient to validate Android passkeys. The server now
publishes both relations, matching the local association generator and
[Google's passkey sharing guidance](https://codelabs.developers.google.com/seamless-credential-sharing).
Deploy the corrected server, verify that both relations are present in the live
JSON, and check each relation through Google's Digital Asset Links API. The
existing 0.3.0 APK can then be retried; this server correction needs no APK rebuild.
Cached association results may take time to refresh. Do not delete an existing
passkey or create a replacement account to troubleshoot an association failure.

Association checks do not prove that the password manager returns PRF output. Native errors now
distinguish missing credentials, cancellation, interrupted prompts, PRF failure,
an explicit RP validation failure and a subsequent backend-session failure.
`FLURBO_ANDROID_CERT_SHA256` optionally overrides the certificate list (empty
disables the endpoint). Multiple certificates are comma-separated.

No extra Render environment variable is necessary for the recorded preview
certificate. Check the endpoint after deploying, then rebuild the native APK.

## Choose the identity before creating passkeys

The selected host is **`flurbo.singu.online`**, under the user's `singu.online`
domain. The root domain remains available for other projects. Both EAS build
profiles set this relying party ID. DNS, HTTPS hosting and web Mera sign-in are
already working. The Android app-side declaration requires the new signed APK;
physical-device passkey and PRF acceptance remains necessary.
Changing the relying party ID does not migrate existing passkeys.

Keep the association on this same HTTPS host, even if the hosting provider changes.

For local Metro and association generation in Git Bash:

```bash
export FLURBO_PASSKEY_RP_ID=flurbo.singu.online
```

Confirm `android.package` and `ios.bundleIdentifier` in `app.json` before signing
a build. Their current `dev.flurbo.preview` values are development placeholders.
The generator reads those values directly, avoiding a second copy of the app IDs.

## Generate the files locally

From `apps/mobile`, set these process environment variables to real values:

| Variable | Used by | Value |
| --- | --- | --- |
| `FLURBO_PASSKEY_RP_ID` | Both platforms and Expo configuration | Lowercase DNS host only, without `https://`, path or port |
| `FLURBO_ANDROID_CERT_SHA256` | Android generator | Comma-separated, colon-delimited SHA-256 fingerprints of the certificates signing the installed builds |
| `FLURBO_IOS_APP_ID_PREFIX` | iOS generator | Apple's ten-character application identifier prefix; normally the Team ID, but confirm against the signed app's `application-identifier` entitlement |

These are public identifiers, not private keys. Syntax checks cannot prove that
you own the host, that the signing identity is correct, or that the host is a
registrable domain. Get the actual signing fingerprint from the selected build;
do not substitute an upload-key fingerprint for a different installed-app signer.

Run only the generator for the platform you have configured:

```powershell
npm run passkeys:association -- android
# Or, for an iOS build:
npm run passkeys:association -- ios
```

Output is written under the ignored `dist-passkeys/<rpId>/<platform>/.well-known/`
directory. Review the JSON before publishing. Android outputs `assetlinks.json`;
iOS outputs `apple-app-site-association` without a file extension. Separate host
and platform directories keep earlier output from being mistaken for a new host's
files. Regeneration replaces that host/platform's output file.

Publish the file at `https://<rpId>/.well-known/<filename>`, publicly readable with
HTTP 200 and `Content-Type: application/json`, without redirects or login gates.
Preserve any existing associations on the host when merging these entries. This
command does not upload anything or modify the domain owner's existing files.
Android includes the credential-sharing and URL-handling relations documented by
[Android Credential Manager](https://developer.android.com/identity/credential-manager/prerequisites).
It does not add an Android deep-link intent filter to the app.

Expo consumes the same `FLURBO_PASSKEY_RP_ID` to expose `extra.passkeyRpId` and
add the iOS `webcredentials:<rpId>` associated-domain entitlement. The EAS profiles
now provide the selected host; set that same value in the local Metro environment.
Regenerate/rebuild the native app after changing associated domains. Signing
fingerprints and the Apple prefix are not included in Expo's public config.

## Native validation still required

Android is the selected first test platform, using an EAS cloud build. Account
login, project linking, EAS signing setup and preview installation are verified
by the user. That earlier preview did not verify passkey authentication; rebuild
when the selected host and certificate association are ready. Android local
builds would need an SDK/JDK. iOS local builds require a Mac with Xcode; EAS
internal iPhone distribution requires Apple provisioning and device registration.
See [Expo internal distribution](https://docs.expo.dev/build/internal-distribution/).

The app now integrates the
[Mera native client](https://github.com/category-labs/mera/blob/a3102f4fa7b89ce4e58e843a2d6da2201035ff25/docs/src/content/docs/recipes/use-mera-with-react-native.md),
and needs testing for creation, returning sign-in, PRF support, cancellation, recovery and
session expiry on the actual phone. A generated association file or successful
JavaScript export alone does not validate any of those flows.
