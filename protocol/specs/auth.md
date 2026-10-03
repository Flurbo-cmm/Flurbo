# Agent credentials and wallet association

## Agent credentials

A credential lets a runtime outside the browser read market data and report activity for one agent. It is not signing authority and cannot move funds.

**Issuance.** Only a signed-in Mera account with testnet approval can issue a credential, from the agent page (session routes under `/api/agents/{agentId}/credentials`). The token is shown once in the issuance response and never again. Flurbo stores only a SHA-256 digest of the secret.

**Format.** `fla1_{credentialId}_{secret}`: `credentialId` is 16 lowercase hex characters, `secret` is 43 base64url characters (32 random bytes). The runtime sends it only as `Authorization: Bearer {token}`. Tokens in query strings are rejected and never logged.

**Scopes.**

| Scope | Allows |
| --- | --- |
| `markets:read` | Deployments, markets, quotes, analytics |
| `wallet:read` | Balances, allowances and positions of the agent's associated wallet |
| `runtime:report` | Heartbeats, policy reads and decision reports |
| `executions:report` | Reporting transaction hashes for verification |

A credential names at least one scope. No scope reaches settlement, assertion, challenge, reviewer, faucet or operator routes; those are not part of this API.

**Lifetime.** Expiry is chosen at issuance: 1 to 90 days (default 30). An agent has at most 5 active credentials. Rotation issues a new credential and revokes the old one in the same step; there is no overlap, so the runtime must be given the new token. Revocation takes effect for every request that starts after it is stored. A request already being processed completes, and nothing it writes can undo the revocation: the credential record is written only by issuance, revocation and rotation under the owner's lock, and a request records its last use in a separate key that only ever moves forward.

**Every request re-checks** the credential (exists, not revoked, not expired), the agent (exists, belongs to the credential's account, not archived for new work), and the account's testnet approval. Removing approval returns `INVITE_REQUIRED` from the next request.

**Rate limits.** 120 requests per minute per credential, plus the service-wide limit. Exceeding it returns `RATE_LIMITED` with `Retry-After`.

**Cross-account isolation.** A credential only reaches its own agent. Other agents and accounts answer `NOT_FOUND`.

**Runtime response to credential problems.** On `CREDENTIAL_REVOKED`, `CREDENTIAL_EXPIRED`, `INVITE_REQUIRED`, `UNAUTHENTICATED` or `AGENT_ARCHIVED`, a compliant runtime stops initiating new actions immediately. It keeps reconciling transactions it already signed, using its own RPC, and keeps unsent reports in its journal. A transaction already broadcast may still confirm.

## Agent wallet association

**Proof.** The agent page requests a challenge for a wallet address. The message is:

```
Flurbo agent wallet association
Origin: {origin}
Mera account: {account}
Agent: {agentId}
Agent wallet: {wallet}
Chain: Monad testnet (10143)
Nonce: {nonce}
Issued: {ISO-8601}
Expires: {ISO-8601}
This proves control of this wallet so Flurbo can attribute its verified agent trades to this agent. It does not move funds, grant Flurbo any authority, or authorize a transaction.
```

The wallet signs it with EIP-191 `personal_sign` (the runtime command `flurbo-agent sign-message` does this locally with the agent key). The challenge expires after 5 minutes, is single use, and is bound to the origin, the signed-in session, the account and the agent. A signature over a different message, from a different wallet, for another agent or account, after expiry, or a second time is rejected.

**Policies.**

- One agent per wallet across all accounts. A wallet associated with an active agent cannot be associated with another.
- The wallet may not be the Mera account address, a MetaMask wallet linked to any Flurbo account for manual trading, or a reserved address (pool, resolver, deployment creator, reviewers, challenge eligibility signer, and operator addresses the service configures).
- The exclusion with manual links holds in both directions and at every step: it is checked when a challenge is issued, again when it is verified, and the final writes exclude each other atomically. An agent wallet can never become a MetaMask-linked wallet, and the reverse, so a wallet's trades count either in Portfolio or as agent activity, never both.
- Replacing the wallet ends the old association at the replacement time and starts the new one. Transactions are attributed using the wallet associated at their block time, so earlier verified executions stay attributed.
- Archiving an agent ends its current association and frees the wallet. Its history is kept.

**What association does not do.** It does not move funds or positions to the Mera account, does not give Flurbo any authority over the wallet, and does not make every transaction from the wallet an agent execution. Only reported and verified executions are attributed (see transactions.md).
