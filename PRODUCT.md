# Product

## Platform

web

## Users

Two audiences use one interface.

- General consumers who want to hold a view on a real event: they arrive with one question in mind, want one price pair, one clear action and plain language, and confirm every transaction in their own MetaMask wallet.
- Quant traders and builders who price relationships between events: they read exact figures, conditional and joint probabilities, price impact, contract addresses and transaction hashes, use the keyboard, and run agents through the SDKs.

Both reach the app after creating a Mera passkey account and being approved for access. The landing page and docs are public.

## Product Purpose

Flurbo is an information market. People buy shares on single questions, or on linked combinations of up to three questions from the same pool, all priced from one shared pool. A correct share pays 1 test AUSD and a losing share pays 0. Success is a member who understands what they are buying, what decides the answer and when they can collect, and who comes back because the prices are informative.

## Positioning

One shared pool prices single questions and their combinations together, so the market shows how events connect (conditional chance, joint chance, the gap to independence), not only whether each one happens. Every price, rule, source, bond, challenge, ruling and payout is public and inspectable, down to the contract and the transaction.

## Operating Context

- Monad testnet preview with test AUSD and test MON only. A Sepolia leg exists for Reality.eth answers and Kleros arbitration.
- Members sign in with a Mera passkey bound to `flurbopm.singu.online`, then link one or more MetaMask trading wallets with a signature. Every trade, approval, bond, challenge, appeal and payout is a wallet transaction the member confirms.
- Markets come from registries (`config/collections.json`, `config/oracle-markets.json`, `config/hybrid-markets.json`). Three market kinds share one directory: pilot and practice pools settled by mechanical source readers with a bonded proposal and challenge window; oracle pools answered on Reality.eth with Kleros arbitration and a relay to Monad; hybrid pools that route each question to a mechanical reader or Reality.eth, with any challenge going to Kleros.
- A shared pool pays only when every question in it is final.
- Agents can trade on a member's behalf through the API and SDKs (TypeScript, Python, Rust, C++), in paper mode or with explicit approval for live testnet trades.
- Operators use separate pages (workspace, evidence review, metrics) that are not member-facing.

## Capabilities and Constraints

- Routes, URLs, query parameters and anchors are fixed: `/`, `/docs`, `/login`, `/signup`, `/markets` and its market pages, `/portfolio`, `/agents`, `/access`, `/fund`, plus operator routes.
- No mechanism changes in presentation work: contracts, API calls, pricing, claim encoding, settlement, quote expiry, submission locks, pending transaction recovery, semantic acknowledgment, session and access gating stay exactly as they are.
- Prices are the cost of one share in test AUSD including price impact. They are not probabilities.
- Light theme only. Forest, ivory and lime are the brand.
- Vocabulary: market, question, view, position, share, price, pays 1.000, pool, linked, combination, forecast, source, rule, proof, settle, collect, challenge, evidence.
- Never used in member-facing copy: bet, betting, wager, odds, jackpot, gamble, gambling, punt, parlay, degen, "win big", "cash out", "lock it in", "hot", "streak", "boost".
- Copy uses no em dashes or en dashes and no exclamation marks.

## Brand Commitments

- The Flurbo logo: three hand-drawn contour rings, a lime dot where contours meet (the "joint state"), and the lowercase wordmark in Space Grotesk. The geometry is fixed and never redrawn.
- The loading screen: two contour ring systems converge into the logo, the lime dot appears, the wordmark settles, and forest panels split left and right. Its choreography and timings are kept; only its look and feel may improve.
- Palette: forest ink `#14271d`, ivory `#f5f4ec`, lime `#d9f76d`.
- Voice: calm, plain and precise, like a well set markets page. Never a casino or sportsbook: no confetti, coins, dice, neon, sounds, leaderboards, streaks, badges, countdown hype or fake urgency.

## Evidence on Hand

- Live testnet pools and their public records: contracts on Monadscan, Reality.eth questions on Sepolia, Kleros disputes. The hybrid pool `hybrid-reality-2` in `config/hybrid-markets.json` is the reference for showing a real public record.
- Technical litepaper (PDF, linked from the footer) and the in-app guide at `/docs` with screenshots in `apps/web/src/pages/docs-media/`.
- The landing example (two linked questions about an exchange supporting an upgrade and the upgrade going live) uses illustrative numbers and must be labelled as an example.
- There are no testimonials, customer logos, usage statistics or mainnet figures. None may be invented.

## Product Principles

1. Prove, do not claim: show the price, the rule, the source and the record instead of describing trust.
2. One primary thing per screen: the consumer layer leads, and every quant detail is one interaction away, never removed.
3. Connections are the product: linked questions and their joint and conditional prices appear wherever a market appears.
4. Habit through information, never through pressure: return visits are rewarded with what changed, not with mechanics that push another trade.
5. Every transaction is explicit: the member always sees what they confirm, on which network, before their wallet asks.

## Accessibility & Inclusion

- WCAG 2.2 AA contrast, visible focus on every control, full keyboard operation, and accessible names that tests and assistive technology rely on.
- Reduced motion is honored everywhere, including the loading screen.
- Color is never the only signal: price changes carry a sign and an arrow, status carries text.
- No horizontal scrolling at any width from 360 px up.
