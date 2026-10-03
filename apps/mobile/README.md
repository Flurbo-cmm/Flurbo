# Native mobile client

The Expo client uses Mera passkeys for account access and a linked MetaMask wallet through WalletConnect for Monad testnet trading. The passkey relying-party host is `flurbo.singu.online`; Android and iOS association details are in `PASSKEY_SETUP.md`.

The client shares claim and transaction validation code with `apps/web` and the legacy wallet controller with `apps/dashboard`. Keep those packages in the same checkout. Kuru order-book controls have been removed from this company copy; existing receipt and wallet recovery paths remain in the legacy trading controller.

Run `npm --prefix apps/mobile ci`, `npm --prefix apps/mobile run typecheck` and `npm --prefix apps/mobile test` from the repository root. Native device and wallet prompts require manual acceptance testing. See [the project reference](../../docs/PROJECT_REFERENCE.md) for the current product architecture and migration status.
