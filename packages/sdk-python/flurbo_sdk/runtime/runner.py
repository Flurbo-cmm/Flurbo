"""The agent loop, same configuration format (flurbo.agent-config.v1) and behavior as the TypeScript runtime.

research -> validated forecast -> strategy -> policy -> quote and simulation -> journal -> sign -> broadcast
-> receipt -> verify -> report. Paper mode never constructs a signer.
"""
import copy
import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path

from ..claims import claim_key
from ..errors import FlurboError
from ..policy import effective_policy
from ..strategy import STRATEGY, candidate_claims, decide
from .chain import ChainReader
from .executor import Executor
from .headless import RuntimeApiError, RuntimeClient
from .journal import FileJournal, is_final
from .research import AnthropicMessages, FixtureForecaster, HttpRetriever, OpenAICompatible, ProviderError, Researcher
from .rpc import json_rpc
from .signer import signer_from_env

SDK_VERSION = "0.2.0"

DEFAULT_CONFIG = {
    "schema": "flurbo.agent-config.v1",
    "api": {"baseUrl": "https://flurbo.singu.online", "credentialEnv": "FLURBO_AGENT_TOKEN"},
    "chain": {"rpcUrl": "https://testnet-rpc.monad.xyz"},
    "signer": {"kind": "local-key", "keyEnv": "FLURBO_AGENT_PRIVATE_KEY"},
    "stateDir": ".flurbo-agent", "mode": "paper", "markets": ["pilot"],
    "schedule": {"intervalSeconds": 300, "heartbeatSeconds": 30, "waitSeconds": 90},
    "research": {"retriever": {"kind": "http", "allowHosts": ["github.com"]}, "provider": {"kind": "none"}, "perCycle": 2, "perHour": 20, "maxEvidenceAgeDays": 14},
    "strategy": {"id": "joint-edge", "quantityAtoms": "1000000", "slippageBps": 50, "minEdgeBps": 500, "minEdgeAtoms": "10000", "maxCostAtoms": "2000000", "includeSingles": True, "minEvidence": 1},
    "policy": {"markets": ["pilot"], "maxQuantityAtoms": "2000000", "maxTradeCostAtoms": "2000000", "maxSlippageBps": 50,
               "spend": {"totalAtoms": "20000000", "windows": [{"seconds": 86400, "atoms": "10000000"}]}, "maxPositionAtoms": "5000000", "maxWorstCaseLossAtoms": "10000000",
               "gas": {"maxFeeWei": "100000000000000000", "reserveWei": "200000000000000000"}, "quoteMaxAgeSeconds": 30, "minSecondsBeforeClose": 120, "maxPending": 2,
               "allowSell": False, "allowRedeem": False},
    "policyMaxAgeSeconds": 120, "paperBudgetAtoms": "50000000",
}


def default_config() -> dict:
    return copy.deepcopy(DEFAULT_CONFIG)


def parse_config(c: dict) -> dict:
    def bad(m: str):
        raise FlurboError("invalid_input", f"Configuration: {m}")
    if not isinstance(c, dict) or c.get("schema") != "flurbo.agent-config.v1":
        bad("schema must be flurbo.agent-config.v1.")
    if c.get("mode") not in ("paper", "live"):
        bad("mode must be paper or live.")
    if not c.get("markets"):
        bad("list at least one market.")
    if not all(m in c["markets"] for m in c["policy"]["markets"]):
        bad("policy.markets must be a subset of markets.")
    if c["policy"]["maxSlippageBps"] not in (10, 50, 100) or c["strategy"]["slippageBps"] > c["policy"]["maxSlippageBps"]:
        bad("slippage must be 10, 50 or 100 and within the policy.")
    for name in (c["api"]["credentialEnv"], c["signer"]["keyEnv"]):
        if not re.match(r"^[A-Z_][A-Z0-9_]*$", name):
            bad("credential and key settings must name environment variables.")
    if c["schedule"]["intervalSeconds"] < 10 or c["schedule"]["heartbeatSeconds"] < 5:
        bad("schedule too aggressive.")
    requirements = c["research"].get("evidenceRequirements", {})
    if not isinstance(requirements, dict):
        bad("evidenceRequirements must be a map of market namespace to event requirements.")
    for namespace, rows in requirements.items():
        if namespace not in c["markets"] or not isinstance(rows, list):
            bad("evidence requirements must name a configured market.")
        if any(not isinstance(row, dict) or set(row) != {"event", "freshness"} or type(row["event"]) is not int or not 0 <= row["event"] < 4 or row["freshness"] not in ("release", "background") for row in rows):
            bad("invalid event evidence requirement.")
        if len({row["event"] for row in rows}) != len(rows):
            bad("duplicate event evidence requirement.")
    return c


class JointEdgeStrategy:
    """The reference strategy. A custom strategy is any object with id, version and decide(ctx)."""
    id, version = STRATEGY["id"], STRATEGY["version"]

    def __init__(self, config: dict):
        self.config = {"quantityAtoms": int(config["quantityAtoms"]), "slippageBps": config["slippageBps"], "minEdgeBps": config["minEdgeBps"],
                       "minEdgeAtoms": int(config["minEdgeAtoms"]), "maxCostAtoms": int(config["maxCostAtoms"]), "minEvidence": config["minEvidence"], "includeSingles": config["includeSingles"]}

    def decide(self, ctx: dict) -> dict:
        m, f = ctx["market"], ctx["forecast"]
        claims = [c for c in candidate_claims(m["pool"], m["eventCount"], f["events"], self.config["includeSingles"])]
        quotes = ctx["quote"](claims, self.config["quantityAtoms"])
        d = decide(m, f, self.config, ctx["now"], quotes)
        p = d["proposal"]
        explanation = "No covered claim clears the edge threshold after the quoted cost and slippage allowance." if not p else \
            f"Forecast {p['forecastPpm'] / 10_000:.1f}% that the claim pays; quoted cost {p['quoteAtoms']} atoms, at most {p['worstCostAtoms']} with slippage; estimated edge {p['edgeAtoms']} atoms before gas."
        return {"outcome": d["outcome"], "reasons": d["reasons"], "explanation": explanation,
                "proposal": p and {"scope": p["scope"], "mask": p["mask"], "quantityAtoms": p["quantityAtoms"], "quoteAtoms": p["quoteAtoms"], "slippageBps": p["slippageBps"],
                                   "edgeAtoms": p["edgeAtoms"], "edgeBps": p["edgeBps"]}}


class PaperBook:
    """Paper trades: priced at the quote at the decision's block, no market impact, strictly newer block per
    claim, and a paper budget. No signer is involved."""

    def __init__(self, directory: Path, journal: FileJournal, budget_atoms: int):
        self.file, self.journal, self.budget = directory / "paper.json", journal, budget_atoms

    def read(self) -> list[dict]:
        return json.loads(self.file.read_text())["fills"] if self.file.exists() else []

    def fill(self, record: dict) -> dict:
        def do():
            fills = self.read()
            if any(x["decisionId"] == record["decisionId"] for x in fills):
                return {"ok": False, "reason": "already_filled"}
            if any(x["claim"] == record["claim"] and x["namespace"] == record["namespace"] and int(x["snapshotBlock"]) >= int(record["snapshotBlock"]) for x in fills):
                return {"ok": False, "reason": "same_quote_block"}
            if sum(int(x["costAtoms"]) for x in fills) + int(record["costAtoms"]) > self.budget:
                return {"ok": False, "reason": "paper_budget"}
            saved = {"id": str(uuid.uuid4()), **record}
            self.file.write_text(json.dumps({"schema": "flurbo.agent-paper.v1", "model": "quote-at-snapshot-no-impact-v1", "fills": fills + [saved]}, indent=1))
            return {"ok": True, "record": saved}
        return self.journal.with_lock(do)


class AgentRunner:
    def __init__(self, config: dict, env: dict | None = None, client=None, chain=None, signer=None, retriever=None, forecaster=None, strategy=None, now=None, log=None):
        self.config, self.env = config, env if env is not None else os.environ
        self.now = now or (lambda: int(time.time()))
        self.log = log or (lambda event, detail=None: print(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event, **(detail or {})}), flush=True))
        self.dir = Path(config["stateDir"])
        self.dir.mkdir(parents=True, exist_ok=True)
        self.runtime_file, self.stop_file, self.outbox_file = self.dir / "runtime.json", self.dir / "stop.request", self.dir / "outbox.json"
        self.saved = json.loads(self.runtime_file.read_text()) if self.runtime_file.exists() else {}
        self.runtime_id, self.started_at = self.saved.get("runtimeId") or f"rt-{uuid.uuid4()}", self.now()
        token = self.env.get(config["api"]["credentialEnv"])
        self.client = client or (RuntimeClient(config["api"]["baseUrl"], token) if token else None)
        self.chain = chain or ChainReader(json_rpc(config["chain"]["rpcUrl"]))
        # Paper mode never constructs a signer.
        self.signer = (signer or signer_from_env(config["signer"]["keyEnv"], self.env)) if config["mode"] == "live" else None
        self.wallet = self.signer.address if self.signer else "paper"
        self.journal = FileJournal(self.dir, self.signer.address if self.signer else "0x" + "00" * 20)
        self.paper = PaperBook(self.dir, self.journal, int(config["paperBudgetAtoms"]))
        self.forecaster = forecaster or self._forecaster()
        r = config["research"]
        self.researcher = Researcher(retriever or HttpRetriever(r["retriever"].get("allowHosts", []), r["retriever"].get("allowLocalHttp", False)),
                                     self.forecaster, r["maxEvidenceAgeDays"] * 86_400, r["perCycle"], r["perHour"], self.now)
        self.strategy = strategy or JointEdgeStrategy(config["strategy"])
        self.flurbo, self.read_at, self.blocked_by, self.last_cycle_at, self.last_error = None, None, None, None, None
        self.verified: set[str] = set()
        self.executor = Executor(self.chain, self.signer, self.journal, self.client, self._policy_now, self._live_allowed, self.now,
                                 config["schedule"]["waitSeconds"], 1.0, self.log, self._stop) if self.signer else None

    def _forecaster(self):
        p = self.config["research"]["provider"]
        try:
            if p["kind"] == "openai-compatible":
                return OpenAICompatible(p["baseUrl"], p["model"], self.env.get(p["apiKeyEnv"]) if p.get("apiKeyEnv") else None, p.get("timeoutMs", 60_000) / 1000, p.get("maxRetries", 2))
            if p["kind"] == "anthropic":
                return AnthropicMessages(p["model"], self.env.get(p["apiKeyEnv"]), timeout=p.get("timeoutMs", 60_000) / 1000, max_retries=p.get("maxRetries", 2))
            if p["kind"] == "fixture":
                path = (self.dir / ".." / p["replyFile"]).resolve()
                return FixtureForecaster(lambda _prompt: path.read_text(encoding="utf-8"), f"fixture:{path.name}")
            return ProviderError("provider_not_configured", "No research provider is configured. Set research.provider in the configuration.")
        except ProviderError as e:
            return e

    def _stop(self, code: str) -> None:
        if not self.blocked_by:
            self.log("stopped_new_actions", {"code": code})
        self.blocked_by = code

    def _effective(self) -> dict:
        local = {"mode": self.config["mode"], "maxTradeCostAtoms": self.config["policy"]["maxTradeCostAtoms"], "spend": self.config["policy"]["spend"]}
        return effective_policy(local, self.flurbo, self.read_at, self.now(), self.config["policyMaxAgeSeconds"])

    def _live_allowed(self):
        if self.blocked_by:
            return False, self.blocked_by
        if self.stop_file.exists():
            return False, "stop_requested"
        e = self._effective()
        return e["liveAllowed"], e["reason"]

    def _policy_now(self) -> dict:
        e = self._effective()
        p = copy.deepcopy(self.config["policy"])
        p["maxTradeCostAtoms"], p["spend"]["windows"] = e["maxTradeCostAtoms"], e["windows"]
        return p

    def state(self) -> str:
        if getattr(self, "_stopped", False):
            return "stopped"  # sent once, in the final heartbeat when a run ends
        return "stopping" if self.stop_file.exists() else "blocked" if self.blocked_by else "paused" if (self.flurbo or {}).get("paused") else "running"

    def _api(self, fn):
        if not self.client:
            return None
        try:
            return fn()
        except RuntimeApiError as e:
            self.last_error = e.api_code
            if e.stop:
                self._stop(e.api_code)
            return None

    def _accept(self, p: dict) -> None:
        self.flurbo = {"version": p["version"], "paused": p["paused"], "liveEnabled": p["liveEnabled"], "limits": p["limits"]}
        self.read_at = self.now()

    def refresh_policy(self) -> None:
        p = self._api(lambda: self.client.policy())
        if p:
            self._accept(p)

    def heartbeat(self) -> None:
        pending = sum(1 for e in self.journal.read()["entries"] if not is_final(e))
        policy = self._policy_now()
        policy_hash = hashlib.sha256(json.dumps({"mode": self.config["mode"], "policy": policy, "strategy": self.config["strategy"]}, sort_keys=True).encode()).hexdigest()
        r = self._api(lambda: self.client.heartbeat({"runtimeId": self.runtime_id, "sdk": {"language": "python", "version": SDK_VERSION}, "mode": self.config["mode"], "state": self.state(),
                                                     "policy": {"hash": policy_hash, "flurboVersion": (self.flurbo or {}).get("version"),
                                                                "summary": {"maxTradeCostAtoms": policy["maxTradeCostAtoms"], "windows": policy["spend"]["windows"],
                                                                            "totalAtoms": policy["spend"]["totalAtoms"], "maxPending": policy["maxPending"]}},
                                                     "pending": pending, "startedAt": self.started_at, "lastCycleAt": self.last_cycle_at, "lastErrorCode": self.last_error}))
        if r:
            self._accept(r)

    def _report_decision(self, decision: dict) -> None:
        """Decisions are reported as self-reported records; failed reports wait in a local outbox."""
        outbox = json.loads(self.outbox_file.read_text()) if self.outbox_file.exists() else []
        outbox.append(decision)
        remaining = []
        for item in outbox:
            if not remaining and self._api(lambda item=item: self.client.decision(item)) is not None:
                continue
            remaining.append(item)
        self.outbox_file.write_text(json.dumps(remaining[-200:]))

    def _market_cycle(self, d: dict) -> None:
        if d["namespace"] + d["codeHashes"]["pool"] not in self.verified:
            self.chain.verify_deployment(d)
            self.verified.add(d["namespace"] + d["codeHashes"]["pool"])
        detail = self._api(lambda: self.client.market(d["namespace"]))
        if not detail:
            return
        head, resolved = self.chain.block(), self.chain.resolved(d["pool"])
        market = {"pool": d["pool"], "eventCount": d["eventCount"], "open": not resolved and head["timestamp"] < d["closesAt"], "resolved": resolved, "closesAt": d["closesAt"], "snapshotBlockHash": head["hash"]}
        if not market["open"]:
            self.log("market_closed", {"namespace": d["namespace"]})
            return
        if d["closesAt"] - self.now() < self.config["policy"]["minSecondsBeforeClose"]:
            self.log("too_close_to_close", {"namespace": d["namespace"]})
            return
        events = [{"index": e["index"], "question": e["question"], "yesRule": e["yesRule"], "noRule": e["noRule"], "observationEndsAt": e["observationEndsAt"]} for e in detail["events"]]
        for a in range(len(events)):
            for b in range(a + 1, len(events)):
                if self.blocked_by or self.stop_file.exists():
                    return
                pair = sorted([events[a], events[b]], key=lambda event: event["index"])
                indices = tuple(event["index"] for event in pair)
                decision_id = f"d-{uuid.uuid4()}"
                sources = [{"event": e["index"], "url": e["source"]["referenceUrl"]} for e in detail["events"] if e["index"] in indices and (e.get("source") or {}).get("referenceUrl")]
                sources += [s for s in self.config["research"]["retriever"].get("extraSources", {}).get(d["namespace"], []) if s["event"] in indices]
                base = {"schema": "flurbo.agent-runtime-decision.v1", "decisionId": decision_id, "namespace": d["namespace"], "createdAt": self.now()}
                requirements = self.config["research"].get("evidenceRequirements", {}).get(d["namespace"], [])
                found = self.researcher.research(d["pool"], detail.get("title", ""), d["eventCount"], pair, sources,
                                                 [r for r in requirements if r["event"] in indices])
                provenance = found.get("provenance") or {"kind": "custom", "name": "unconfigured"}
                if provenance["kind"] not in ("model", "fixture", "custom"):
                    provenance = {"kind": "custom", "name": provenance["name"]}
                if found["status"] == "abstain":
                    self.log("research_abstained", {"namespace": d["namespace"], "events": list(indices), "reason": found["reason"]})
                    self._report_decision({**base, "outcome": "abstain", "reasons": [found["reason"]], "provenance": provenance, "summary": found["detail"][:600]})
                    continue

                def quote(claims, quantity):
                    out = {}
                    for scope, mask in claims:
                        amount = self.chain.quote(d["pool"], "buy", scope, mask, quantity, head)
                        if amount is not None and 0 < amount <= quantity:
                            out[claim_key(10143, d["pool"], scope, mask)] = {"amountAtoms": amount, "expiresAt": head["timestamp"] + 60, "blockHash": head["hash"]}
                    return out
                forecast = {"events": found["output"]["events"], "statesPpm": found["output"]["statesPpm"], "freshEvidence": found["freshEvidence"]}
                decision = self.strategy.decide({"market": market, "forecast": forecast, "now": self.now(), "quote": quote})
                if decision["outcome"] == "abstain" or not decision.get("proposal"):
                    self.log("strategy_abstained", {"namespace": d["namespace"], "events": list(indices), "reasons": decision["reasons"]})
                    self._report_decision({**base, "outcome": "abstain", "reasons": decision["reasons"] or ["strategy_abstained"], "provenance": provenance, "forecast": found["forecast"],
                                           "summary": decision["explanation"][:600]})
                    continue
                p = decision["proposal"]
                if p["slippageBps"] not in (10, 50, 100):
                    raise FlurboError("invalid_input", "The strategy chose an unsupported slippage.")
                candidate = {"claim": {"scope": p["scope"], "mask": str(p["mask"])}, "quantityAtoms": str(p["quantityAtoms"]), "quoteAtoms": str(p["quoteAtoms"]),
                             "slippageBps": p["slippageBps"], "edgeAtoms": None if p.get("edgeAtoms") is None else str(p["edgeAtoms"]), "edgeBps": p.get("edgeBps"), "quoteBlock": str(head["number"])}
                if self.config["mode"] == "paper":
                    from ..semantics import semantic_error, semantics_disabled
                    reason = 'SEMANTICS_UNAVAILABLE'
                    try:
                        assessment = self.client.validate_trade(d['namespace'], candidate['claim'], p['quantityAtoms'])
                        reason = semantic_error(assessment, d, candidate['claim'], p['quantityAtoms'], self.now())
                        if reason is None and semantics_disabled(assessment):
                            self.log('SEMANTICS_DISABLED', {'namespace': d['namespace']})
                    except Exception:
                        pass
                    if reason:
                        self.log(reason, {'namespace': d['namespace']})
                        self._report_decision({**base, 'outcome':'abstain', 'reasons':[reason], 'provenance':provenance, 'forecast':found['forecast'], 'candidate':candidate, 'summary':'The purchase did not pass outcome compatibility checks.'})
                        continue
                    r = self.paper.fill({"decisionId": decision_id, "namespace": d["namespace"], "claim": candidate["claim"], "quantityAtoms": candidate["quantityAtoms"],
                                         "costAtoms": candidate["quoteAtoms"], "snapshotBlock": candidate["quoteBlock"], "filledAt": self.now()})
                    self.log("paper_trade" if r["ok"] else "paper_skipped", {"namespace": d["namespace"], "claim": candidate["claim"], **({} if r["ok"] else {"reason": r["reason"]})})
                    self._report_decision({**base, "outcome": "paper" if r["ok"] else "abstain", "reasons": [] if r["ok"] else [r["reason"]], "provenance": provenance,
                                           "forecast": found["forecast"], "candidate": candidate, "summary": decision["explanation"][:600]})
                    continue
                self.refresh_policy()
                result = self.executor.execute({"decisionId": decision_id, "deployment": d, "action": "buy", "claim": {"scope": p["scope"], "mask": int(p["mask"])},
                                                "quantityAtoms": p["quantityAtoms"], "slippageBps": p["slippageBps"], "quoteAtoms": p["quoteAtoms"], "quoteBlock": head})
                self.log("execution", {"namespace": d["namespace"], "status": result["status"], **({"hash": result["hash"]} if result.get("hash") else {}),
                                       **({"violations": result["violations"]} if "violations" in result else {})})
                rejected = result["status"] in ("rejected_by_policy", "blocked")
                reasons = result.get("violations") or ([result["reason"]] if result["status"] == "blocked" else [])
                self._report_decision({**base, "outcome": "rejected_by_policy" if rejected else "trade", "reasons": reasons, "provenance": provenance, "forecast": found["forecast"],
                                       "candidate": candidate, **({"violations": result["violations"]} if "violations" in result else {}),
                                       **({"execution": {"hash": result["hash"], "status": result["status"]}} if result.get("hash") else {}), "summary": decision["explanation"][:600]})

    def cycle(self) -> None:
        self.researcher.reset_cycle()
        self.refresh_policy()
        self.heartbeat()
        if self.executor:
            self.executor.reconcile_all()
            self.executor.report()
        if not self.blocked_by and not self.stop_file.exists() and self.client:
            deployments = self._api(lambda: self.client.deployments()) or []
            for d in [x for x in deployments if x["namespace"] in self.config["markets"]]:
                try:
                    self._market_cycle(d)
                except FlurboError as e:
                    self.last_error = e.code
                    self.log("market_cycle_failed", {"namespace": d["namespace"], "code": e.code})
        self.last_cycle_at = self.now()
        self.runtime_file.write_text(json.dumps({**self.saved, "runtimeId": self.runtime_id, "startedAt": self.started_at, "lastCycleAt": self.last_cycle_at,
                                                 "blockedBy": self.blocked_by, "lastErrorCode": self.last_error}, indent=1))
        self.heartbeat()

    def recover(self) -> dict:
        """Reconciles and reports existing transactions only. Never starts a new action."""
        self.refresh_policy()
        if not self.executor:
            return {"reconciled": 0, "message": "Paper mode has no transactions to recover."}
        r = self.executor.reconcile_all()
        self.executor.report()
        return {"reconciled": len(r), "open": sum(1 for e in self.journal.read()["entries"] if not is_final(e))}

    def request_stop(self) -> None:
        self.stop_file.write_text(str(self.now()))

    def run(self, once: bool = False) -> None:
        self.stop_file.unlink(missing_ok=True)
        self.log("started", {"runtimeId": self.runtime_id, "mode": self.config["mode"], "wallet": self.wallet, "markets": self.config["markets"]})
        last_beat = time.monotonic()
        while True:
            self.cycle()
            if once or self.stop_file.exists():
                break
            until = time.monotonic() + self.config["schedule"]["intervalSeconds"]
            while time.monotonic() < until and not self.stop_file.exists():
                time.sleep(0.5)
                if time.monotonic() - last_beat > self.config["schedule"]["heartbeatSeconds"]:
                    self.heartbeat()
                    last_beat = time.monotonic()
            if self.stop_file.exists():
                break
        # Every ended run tells Flurbo it stopped, whether it was asked to stop or ran once, so the dashboard
        # never shows a finished runtime as running.
        self.stop_file.unlink(missing_ok=True)
        self._stopped = True
        try:
            self.heartbeat()
        finally:
            self._stopped = False
        self.log("stopped", {"runtimeId": self.runtime_id})

    def status(self) -> dict:
        j = self.journal.read() if (self.dir / "journal.json").exists() else {"entries": []}
        return {"runtimeId": self.runtime_id, "mode": self.config["mode"], "wallet": self.wallet, "stopRequested": self.stop_file.exists(),
                "locked": (self.dir / "journal.lock").exists(), "pending": [{"id": e["id"], "action": e["action"], "status": e["status"], "hash": e["hash"]} for e in j["entries"] if not is_final(e)],
                "recent": [{"action": e["action"], "status": e["status"], "hash": e["hash"], "costAtoms": e.get("costAtoms")} for e in j["entries"][-10:]],
                "paperFills": len(self.paper.read()), "lastCycleAt": self.saved.get("lastCycleAt"),
                "state": "stopping" if self.stop_file.exists() else "blocked" if self.saved.get("blockedBy") else "ready", "blockedBy": self.saved.get("blockedBy"),
                "lastErrorCode": self.saved.get("lastErrorCode")}
