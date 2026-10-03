export const SDK_VERSION = '0.2.0-beta.0';
export const CHAIN_ID = 10143;

// Wire schemas. A consumer must reject a schema it does not recognise rather than guess.
export const SCHEMAS = {
  forecast: 'flurbo.agent-forecast.v1',
  decision: 'flurbo.agent-decision.v1',
  paperFill: 'flurbo.agent-paper-fill.v1',
  quote: 'flurbo.agent-quote.v1',
  profile: 'flurbo.agent-profile.v1',
  // Canonical combination model owned by the market interface (apps/web/shared/claims.mjs).
  claim: 'flurbo.claim.v1',
  claimImplied: 'flurbo.claim-analytics.v1',
} as const;
