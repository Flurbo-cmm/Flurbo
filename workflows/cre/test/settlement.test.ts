import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, keccak256 } from "viem";
import config from "../fixtures/config.json";
import evidence from "../fixtures/observations.json";
import { prepareSettlement, reportAbi, rulesPreimage } from "../src/settlement";

const now = 1700000030;
const prepare = (c: unknown = config, e: unknown = evidence, time = now) => prepareSettlement(c, e, time);
const changedObservation = (patch: Record<string, unknown>) => ({ ...evidence,
  observations: [{ ...evidence.observations[0], ...patch }, evidence.observations[1]] });

test("two-event fixture encodes the receiver's seven words and event A bit", () => {
  const result = prepare();
  // Fixed vectors independently reproduced with Foundry cast ABI encoding + keccak.
  expect(result.rulesHash).toBe("0x544e75a084153a0d6e523edf86b76ba10a0efef40f93e43e299f7fa2f852fcbc");
  expect(result.observationsHash).toBe("0xf41952eb31bc7a7c62138fac5b0b48e84024962abdf770e42c9cf3d331fe86cf");
  expect(result.terminalState).toBe(1);
  expect(result.unsignedReport.length).toBe(2 + 224 * 2);
  expect(decodeAbiParameters(reportAbi, result.unsignedReport)).toEqual([
    1, 10143n, config.pool, keccak256(rulesPreimage(config)), BigInt(now), result.observationsHash, 1,
  ]);
  // Independent literal ABI word checks for version, chain, observation time and terminal state.
  const words = result.unsignedReport.slice(2).match(/.{64}/g)!;
  expect(words[0]).toBe("0".repeat(63) + "1");
  expect(words[1]).toBe("0".repeat(60) + "279f");
  expect(words[4]).toBe("0".repeat(56) + "6553f11e");
  expect(words[6]).toBe("0".repeat(63) + "1");
});

test("evidence order is canonical; configured event order remains meaningful", () => {
  expect(prepare(config, { ...evidence, observations: [...evidence.observations].reverse() })).toEqual(prepare());
  const reversed = prepare({ ...config, events: [...config.events].reverse() });
  expect(reversed.terminalState).toBe(2);
  expect(reversed.rulesHash).not.toBe(prepare().rulesHash);
});

test("all 14 terminal states for one through three events map to the correct bits", () => {
  for (let count = 1; count <= 3; count++) {
    const events = Array.from({ length: count }, (_, bit) => ({ id: `event-${bit}`, source: `fixture:${bit}` }));
    for (let state = 0; state < 1 << count; state++) {
      const observations = events.map((event, bit) => ({ eventId: event.id, source: event.source,
        outcome: Boolean(state & (1 << bit)), final: true, finalizedAt: now }));
      expect(prepare({ ...config, events }, { ...evidence, observations }).terminalState).toBe(state);
    }
  }
});

describe("fail closed on invalid evidence", () => {
  const cases: [string, unknown][] = [
    ["missing event", { ...evidence, observations: evidence.observations.slice(0, 1) }],
    ["duplicate event", { ...evidence, observations: [evidence.observations[0], evidence.observations[0]] }],
    ["unknown event", changedObservation({ eventId: "unknown" })],
    ["wrong source", changedObservation({ source: "fixture:other" })],
    ["unfinished", changedObservation({ final: false })],
    ["nonboolean result", changedObservation({ outcome: "false" })],
    ["future finality", changedObservation({ finalizedAt: now + 1 })],
    ["pre-close finality", changedObservation({ finalizedAt: config.closesAt - 1 })],
    ["fractional timestamp", changedObservation({ finalizedAt: now - 0.5 })],
    ["unknown field", changedObservation({ correction: true })],
    ["live mode", { ...evidence, mode: "live" }],
  ];
  for (const [label, invalid] of cases) test(label, () => expect(() => prepare(config, invalid)).toThrow());
});

test("rejects early execution and invalid configuration", () => {
  expect(() => prepare(config, evidence, config.closesAt - 1)).toThrow("not closed");
  for (const invalid of [
    { ...config, events: [] },
    { ...config, events: [...config.events, ...config.events] },
    { ...config, events: [config.events[0], config.events[0]] },
    { ...config, mode: "live" },
    { ...config, chainId: Number.MAX_SAFE_INTEGER + 1 },
    { ...config, pool: "0x" + "0".repeat(40) },
    { ...config, events: [{ id: "a", source: "https://official.example" }] },
  ]) expect(() => prepare(invalid)).toThrow();
});

test("commitments bind domain, rules, time and outcomes", () => {
  const base = prepare();
  for (const patch of [{ chainId: 143 }, { pool: "0x" + "2".repeat(40) }, { closesAt: config.closesAt - 1 }]) {
    const result = prepare({ ...config, ...patch });
    expect(result.rulesHash).not.toBe(base.rulesHash);
    expect(result.observationsHash).not.toBe(base.observationsHash);
  }
  expect(prepare(config, evidence, now + 1).observationsHash).not.toBe(base.observationsHash);
  expect(prepare(config, changedObservation({ outcome: false })).observationsHash).not.toBe(base.observationsHash);
  expect(prepare(config, changedObservation({ finalizedAt: now })).observationsHash).not.toBe(base.observationsHash);
  expect(prepare(config, changedObservation({ outcome: false })).rulesHash).toBe(base.rulesHash);
});

test("version 2 preserves bit 31 and separates the factored report domain", () => {
  const events = Array.from({length: 32}, (_, bit) => ({id: `e-${bit}`, source: `fixture:${bit}`}));
  const observations = events.map(event => ({eventId: event.id, source: event.source, outcome: true, final: true, finalizedAt: now}));
  const c = {...config, reportVersion: 2, events};
  const result = prepare(c, {...evidence, observations});
  const words = result.unsignedReport.slice(2).match(/.{64}/g)!;
  expect(result.terminalState).toBe(4294967295);
  expect(BigInt('0x' + words[0])).toBe(2n);
  expect(BigInt('0x' + words[6])).toBe(4294967295n);
  const highOnly = observations.map((row, bit) => ({...row, outcome: bit === 31}));
  expect(prepare(c, {...evidence, observations: highOnly}).terminalState).toBe(2147483648);
  expect(() => prepare({...c, reportVersion: 1}, {...evidence, observations})).toThrow();
  expect(() => prepare({...c, events: [...events, {id:'extra', source:'fixture:extra'}]}, {...evidence, observations})).toThrow();
  expect(prepare({...config, reportVersion: 2}).rulesHash).not.toBe(prepare().rulesHash);
  expect(prepare({...config, reportVersion: 2}).observationsHash).not.toBe(prepare().observationsHash);
});
