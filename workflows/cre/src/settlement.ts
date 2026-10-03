import { encodeAbiParameters, keccak256, parseAbiParameters, type Address } from "viem";
import { z } from "zod";

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,95}$/);
export const configSchema = z.object({
  mode: z.literal("synthetic-only"),
  reportVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  chainId: timestamp.refine((value) => value > 0, "chainId must be positive"),
  pool: z.string().regex(/^0x[0-9a-f]{40}$/)
    .refine((value) => value !== "0x" + "0".repeat(40), "pool must be nonzero"),
  closesAt: timestamp,
  events: z.array(z.object({
    id: identifier,
    source: z.string().regex(/^fixture:[a-z0-9:_-]{1,88}$/),
  }).strict()).min(1).max(32),
}).strict().refine((config) => new Set(config.events.map((event) => event.id)).size === config.events.length,
  "event IDs must be unique").refine((config) => config.reportVersion === 2 || config.events.length <= 3,
  "version 1 supports at most three reference-pool events");

const evidenceSchema = z.object({
  mode: z.literal("synthetic-only"),
  observations: z.array(z.object({
    eventId: identifier,
    source: z.string(),
    final: z.literal(true),
    outcome: z.boolean(),
    finalizedAt: timestamp,
  }).strict()).min(1).max(32),
}).strict();

export type Config = z.infer<typeof configSchema>;
export const reportAbi = parseAbiParameters(
  "uint8 version, uint256 chainId, address pool, bytes32 rulesHash, uint64 observedAt, bytes32 observationsHash, uint8 terminalState",
);

export const factoredReportAbi = parseAbiParameters(
  "uint8 version, uint256 chainId, address pool, bytes32 rulesHash, uint64 observedAt, bytes32 observationsHash, uint32 terminalState",
);

// ABI preimages are versioned and domain-separated. Event array order defines bit order.
export function rulesPreimage(rawConfig: unknown) {
  const config = configSchema.parse(rawConfig);
  return encodeAbiParameters(
    parseAbiParameters("string domain, uint256 chainId, address pool, uint64 closesAt, (string id, string source)[] events"),
    [`flurbo.synthetic.rules.v${(config.reportVersion ?? 1)}`, BigInt(config.chainId), config.pool as Address,
      BigInt(config.closesAt), config.events],
  );
}

/** Test fixture validation only: supplied source labels/finality are not authenticated. */
export function prepareSettlement(rawConfig: unknown, rawEvidence: unknown, now: number) {
  const config = configSchema.parse(rawConfig);
  const evidence = evidenceSchema.parse(rawEvidence);
  const observedAt = timestamp.parse(now);
  if (observedAt < config.closesAt) throw new Error("market has not closed");
  if (evidence.observations.length !== config.events.length) throw new Error("incomplete event set");
  const byId = new Map(evidence.observations.map((observation) => [observation.eventId, observation]));
  if (byId.size !== evidence.observations.length) throw new Error("duplicate observation");

  let terminalState = 0;
  const observations = config.events.map((event, bit) => {
    const observation = byId.get(event.id);
    if (!observation) throw new Error(`missing event: ${event.id}`);
    if (observation.source !== event.source) throw new Error(`source mismatch: ${event.id}`);
    if (observation.finalizedAt < config.closesAt || observation.finalizedAt > observedAt) {
      throw new Error(`finality timestamp outside [close, now]: ${event.id}`);
    }
    if (observation.outcome) terminalState += 2 ** bit;
    return observation;
  });
  const rules = rulesPreimage(config);
  const rulesHash = keccak256(rules);
  const evidencePreimage = encodeAbiParameters(
    parseAbiParameters("string domain, bytes32 rulesHash, uint64 observedAt, (string eventId, string source, bool outcome, uint64 finalizedAt)[] observations"),
    [`flurbo.synthetic.evidence.v${(config.reportVersion ?? 1)}`, rulesHash, BigInt(observedAt), observations.map((observation) => ({
      eventId: observation.eventId, source: observation.source, outcome: observation.outcome,
      finalizedAt: BigInt(observation.finalizedAt),
    }))],
  );
  const observationsHash = keccak256(evidencePreimage);
  const unsignedReport = encodeAbiParameters(config.reportVersion === 2 ? factoredReportAbi : reportAbi, [config.reportVersion ?? 1, BigInt(config.chainId),
    config.pool as Address, rulesHash, BigInt(observedAt), observationsHash, terminalState]);
  return { mode: config.mode, rulesHash, observationsHash, observedAt, terminalState, unsignedReport };
}
