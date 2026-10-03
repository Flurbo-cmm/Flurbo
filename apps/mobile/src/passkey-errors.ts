// Display stable categories only, never native payloads, credential IDs or PRF data.
export function passkeyErrorMessage(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const e = current as { code?: unknown; error?: unknown; message?: unknown; cause?: unknown };
    const code = e.code ?? e.error;
    if (code === 'ACCOUNT_SERVICE_UNAVAILABLE') return 'Your passkey step finished, but Flurbo could not establish a server session. Check your connection and retry your existing passkey. Code: ACCOUNT_SERVICE_UNAVAILABLE.';
    if (code === 'PRF_UNAVAILABLE') return 'Your passkey provider did not return the wallet unlock data (PRF). Update Google Password Manager and Google Play services, then try the same passkey. Do not create a replacement for an existing funded wallet.';
    if (code === 'CRYPTO_UNAVAILABLE') return 'The app could not initialize secure randomness. Close and reopen Flurbo. Code: CRYPTO_UNAVAILABLE.';
    if (code === 'UserCancelled') return 'Passkey sign-in was cancelled. No account was opened. Tap Sign in when you are ready.';
    if (code === 'NoCredentials') return 'No Flurbo passkey was available from this provider. Use the Google account or password manager where you saved your flurbo.singu.online passkey. A localhost passkey belongs to a different site.';
    if (code === 'NoCreateOption' || code === 'NotConfigured') return 'Enable Google Password Manager or another passkey provider in Android settings, with a screen lock and an account signed in. Then try again.';
    if (code === 'NotSupported') return 'Passkeys are unavailable from this device or provider. Update Google Play services and your password manager, then retry.';
    if (code === 'TimedOut' || code === 'Interrupted') return 'The passkey prompt timed out or was interrupted. Keep Flurbo open and retry the same passkey.';
    if (code === 'CredentialAlreadyExists') return 'This passkey already exists. Choose Sign in instead of creating another account.';
    if (typeof e.message === 'string' && /(?:rp.?id|relying party).*(?:validat|match)|(?:asset.?link|association)/i.test(e.message)) return 'Android could not verify this build for flurbo.singu.online. Install the current signed Flurbo APK and retry. Code: DOMAIN_ASSOCIATION.';
    if (code === 'BadConfiguration' || code === 'RequestFailed') return `Android rejected the passkey request. Retry with your existing passkey and report this code if it continues: ${code}.`;
    current = e.cause;
  }
  return 'Passkey sign-in did not finish. Retry your existing passkey. If it continues, report code PASSKEY_OPERATION_FAILED and whether the passkey chooser opened.';
}
