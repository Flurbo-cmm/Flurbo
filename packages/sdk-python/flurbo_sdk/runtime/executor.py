"""Live execution (protocol/specs/transactions.md), in the same crash-safe order as the TypeScript runtime:
  plan under the lock (policy check and spend reservation in one step)
  re-check permission, assign the nonce and sign under the lock, recording the signed bytes
  broadcast outside the lock; a failure or timeout here is "unknown", never "failed"
  reconcile from the chain; resend only the identical signed bytes
"""
import time
import uuid

from ..amounts import buy_limit, sell_minimum
from ..effects import verify_effect
from ..errors import FlurboError
from ..policy import evaluate_policy
from ..recovery import recovery_step
from ..transaction import build_transaction, validate_transaction
from .headless import RuntimeApiError
from .journal import FileJournal, is_final, owner, policy_entries
from .signer import transaction_hash
from ..semantics import semantic_error, semantics_disabled

MAX_GAS = 15_000_000


def _report_intent(e: dict) -> dict:
    if e["action"] == "approve":
        return {"action": "approve", "claim": None, "quantityAtoms": "0", "limitAtoms": e["limitAtoms"], "deadline": None}
    redeem = e["action"] == "redeem"
    return {"action": e["action"], "claim": e["claim"], "quantityAtoms": e["quantityAtoms"], "limitAtoms": "0" if redeem else e["limitAtoms"], "deadline": None if redeem else e["deadline"]}


def _intent_of(e: dict) -> dict:
    if e["action"] == "approve":
        return {"action": "approve", "amountAtoms": int(e["limitAtoms"])}
    claim = {"scope": e["claim"]["scope"], "mask": int(e["claim"]["mask"])}
    if e["action"] == "redeem":
        return {"action": "redeem", "claim": claim, "quantityAtoms": int(e["quantityAtoms"])}
    return {"action": e["action"], "claim": claim, "quantityAtoms": int(e["quantityAtoms"]), "limitAtoms": int(e["limitAtoms"]), "deadline": e["deadline"]}


class Executor:
    def __init__(self, chain, signer, journal: FileJournal, client, policy, live_allowed, now=None, wait_seconds: float = 60, poll_seconds: float = 1.0, log=None, on_stop=None):
        self.chain, self.signer, self.journal, self.client = chain, signer, journal, client
        self.policy, self.live_allowed = policy, live_allowed
        self.now = now or (lambda: int(time.time()))
        self.wait_seconds, self.poll_seconds = wait_seconds, poll_seconds
        self.log = log or (lambda event, detail=None: None)
        self.on_stop = on_stop
        self.wallet = signer.address

    def semantic_check(self, deployment, claim, quantity):
        reason, disabled = 'SEMANTICS_UNAVAILABLE', False
        try:
            if self.client:
                r = self.client.validate_trade(deployment['namespace'], claim, quantity)
                reason = semantic_error(r, deployment, claim, quantity, self.now())
                disabled = reason is None and semantics_disabled(r)
        except Exception:
            pass
        if reason or disabled:
            self.log(reason or 'SEMANTICS_DISABLED', {'namespace': deployment['namespace'], 'scope': claim['scope'], 'mask': str(claim['mask'])})
        return reason

    # Everything up to and including the policy check and reservation.
    def plan(self, deployment: dict, intent: dict, decision_id: str, quote_block: dict | None, slippage_bps: int):
        tx = build_transaction(intent, deployment, self.wallet)
        try:
            self.chain.simulate(self.wallet, tx["to"], tx["data"])
        except FlurboError:
            return {"status": "simulation_failed", "detail": "The transaction would revert at the latest block."}
        try:
            gas = self.chain.estimate_gas(self.wallet, tx["to"], tx["data"]) * 120 // 100
        except FlurboError:
            return {"status": "simulation_failed", "detail": "Gas could not be estimated."}
        if gas <= 0 or gas > MAX_GAS:
            return {"status": "simulation_failed", "detail": "Gas is outside the service limit."}
        fees, native, head, resolved = self.chain.fees(), self.chain.native_balance(self.wallet), self.chain.block(), self.chain.resolved(deployment["pool"])
        policy, snapshot = self.policy(), self.journal.read()
        claims = {}
        for e in snapshot["entries"]:
            if e.get("claim") and e["namespace"] == deployment["namespace"]:
                claims[(e["claim"]["scope"], e["claim"]["mask"])] = e["claim"]
        if intent["action"] != "approve":
            claims[(intent["claim"]["scope"], str(intent["claim"]["mask"]))] = {"scope": intent["claim"]["scope"], "mask": str(intent["claim"]["mask"])}
        holdings = [{**c, "quantityAtoms": str(self.chain.holdings(deployment["pool"], self.wallet, c["scope"], int(c["mask"])))} for c in claims.values()]

        def reserve(j: dict):
            market = {"namespace": deployment["namespace"], "pool": deployment["pool"], "eventCount": deployment["eventCount"], "closesAt": deployment["closesAt"],
                      "open": not resolved and head["timestamp"] < deployment["closesAt"], "resolved": resolved}
            if intent["action"] == "approve":
                fee, v = gas * fees["maxFeePerGas"], []
                if intent["amountAtoms"] < 1 or intent["amountAtoms"] > 100_000_000:
                    v.append("SERVICE_LIMIT")
                if deployment["namespace"] not in policy["markets"]:
                    v.append("MARKET_NOT_ALLOWED")
                if fee > int(policy["gas"]["maxFeeWei"]):
                    v.append("GAS_FEE_LIMIT")
                if native - fee < int(policy["gas"]["reserveWei"]):
                    v.append("GAS_RESERVE")
                if sum(1 for e in j["entries"] if not is_final(e)) >= policy["maxPending"]:
                    v.append("PENDING_LIMIT")
                violations = v
            else:
                violations = evaluate_policy({"policy": policy, "now": self.now(), "market": market, "wallet": {"nativeBalanceWei": str(native), "holdings": holdings},
                                              "journal": policy_entries(j), "candidate": {"action": intent["action"], "namespace": deployment["namespace"],
                                              "claim": {"scope": intent["claim"]["scope"], "mask": str(intent["claim"]["mask"])}, "quantityAtoms": str(intent["quantityAtoms"]),
                                              "limitAtoms": "0" if intent["action"] == "redeem" else str(intent["limitAtoms"]), "slippageBps": slippage_bps,
                                              "quoteBlockTimestamp": (quote_block or {}).get("timestamp", self.now()), "gasLimit": str(gas), "maxFeePerGas": str(fees["maxFeePerGas"])}})["violations"]
            if violations:
                return {"status": "rejected_by_policy", "violations": violations}
            a = intent["action"]
            entry = {"id": str(uuid.uuid4()), "action": a, "namespace": deployment["namespace"], "pool": deployment["pool"],
                     "claim": None if a == "approve" else {"scope": intent["claim"]["scope"], "mask": str(intent["claim"]["mask"])},
                     "quantityAtoms": "0" if a == "approve" else str(intent["quantityAtoms"]),
                     "limitAtoms": str(intent["amountAtoms"]) if a == "approve" else "0" if a == "redeem" else str(intent["limitAtoms"]),
                     "deadline": intent["deadline"] if a in ("buy", "sell") else None, "status": "planned", "plannedAt": self.now(), "decisionId": decision_id,
                     "to": tx["to"], "data": tx["data"], "gas": str(gas), "maxFeePerGas": str(fees["maxFeePerGas"]), "maxPriorityFeePerGas": str(fees["maxPriorityFeePerGas"]),
                     "nonce": None, "rawTransaction": None, "hash": None, "signedAt": None, "broadcastAt": None, "finalAt": None, "costAtoms": None, "receipt": None, "note": None,
                     "owner": owner(), "report": {"status": "none", "attempts": 0, "flurboStatus": None}}
            j["entries"].append(entry)
            return {"entry": entry}
        return self.journal.locked(reserve)

    # Signs a planned entry; None if it is no longer planned or live execution is no longer allowed.
    def sign(self, entry_id: str, deployment: dict) -> dict | None:
        def do(j: dict):
            e = next((x for x in j["entries"] if x["id"] == entry_id), None)
            if not e or e["status"] != "planned":
                return None
            allowed, reason = self.live_allowed()
            if not allowed:
                e.update({"status": "abandoned", "finalAt": self.now(), "note": f"not signed: {reason}"})
                return None
            if e['action'] == 'buy':
                reason = self.semantic_check(deployment, e['claim'], e['quantityAtoms'])
                if reason:
                    e.update({'status': 'abandoned', 'finalAt': self.now(), 'note': reason})
                    return None
            validate_transaction({"chainId": 10143, "from": self.wallet, "to": e["to"], "data": e["data"], "value": 0}, _intent_of(e), deployment, self.wallet)
            highest = max([-1] + [x["nonce"] for x in j["entries"] if not is_final(x) and x["nonce"] is not None])
            nonce = max(self.chain.nonce(self.wallet, "pending"), highest + 1)
            raw = self.signer.sign_transaction({"chainId": 10143, "nonce": nonce, "to": e["to"], "data": e["data"], "value": 0, "gas": int(e["gas"]),
                                                "maxFeePerGas": int(e["maxFeePerGas"]), "maxPriorityFeePerGas": int(e["maxPriorityFeePerGas"])})
            e.update({"status": "signed", "nonce": nonce, "rawTransaction": raw, "hash": transaction_hash(raw).lower(), "signedAt": self.now()})
            return dict(e)
        return self.journal.locked(do)

    def broadcast(self, e: dict) -> None:
        try:
            self.chain.send_raw(e["rawTransaction"])
        except FlurboError:
            self.log("broadcast_uncertain", {"hash": e["hash"]})  # recovery looks the hash up; nothing new is signed
            return

        def mark(j: dict):
            x = next((y for y in j["entries"] if y["id"] == e["id"]), None)
            if x and x["status"] == "signed":
                x.update({"status": "broadcast", "broadcastAt": self.now()})
        self.journal.locked(mark)
        self.log("broadcast", {"hash": e["hash"]})

    def reconcile_entry(self, entry_id: str) -> dict | None:
        e = next((x for x in self.journal.read()["entries"] if x["id"] == entry_id), None)
        if not e or is_final(e):
            return e
        if e["status"] == "planned" and self.now() - e["plannedAt"] < 60 and e["owner"]["pid"] != owner()["pid"]:
            return e  # a fresh plan of a live process; it re-checks before signing
        head = self.chain.block()
        receipt = self.chain.receipt(e["hash"]) if e["hash"] else None
        tx_found = receipt is not None or (bool(self.chain.transaction(e["hash"])) if e["hash"] else False)
        # A receipt counts once one more block is built on it, the same depth Flurbo's verifier requires.
        settled = receipt if receipt and head["number"] >= receipt["blockNumber"] + 1 else None
        step = recovery_step({"status": e["status"], "action": e["action"], "nonce": e["nonce"], "deadline": e["deadline"]},
                             {"txFound": tx_found, "receiptStatus": settled["status"] if settled else None, "nonceLatest": self.chain.nonce(self.wallet, "latest")}, head["timestamp"])
        facts = lambda r: {"blockNumber": str(r["blockNumber"]), "gasUsed": str(r["gasUsed"]), "effectiveGasPrice": None if r["effectiveGasPrice"] is None else str(r["effectiveGasPrice"])}
        if step["action"] == "verify" and settled:
            allowance = str(self.chain.allowance(self.wallet, e["pool"], hex(settled["blockNumber"]))) if e["action"] == "approve" else None
            effect = verify_effect({"action": e["action"], "wallet": self.wallet, "pool": e["pool"], "claim": e["claim"], "quantityAtoms": e["quantityAtoms"],
                                    "limitAtoms": "0" if e["action"] == "redeem" else e["limitAtoms"]}, {"status": settled["status"], "logs": settled["logs"]}, allowance)
            update = {"status": effect["status"], "finalAt": self.now(), "costAtoms": effect.get("collateralAtoms") if effect["status"] == "confirmed" else None, "receipt": facts(settled)}
        elif step["action"] == "release":
            update = {"status": step["status"], "finalAt": self.now(), **({"receipt": facts(receipt)} if receipt else {})}
        elif step["action"] == "rebroadcast":
            try:
                self.chain.send_raw(e["rawTransaction"])
                self.log("rebroadcast_same_bytes", {"hash": e["hash"]})
            except FlurboError:
                pass
            return e
        elif step["action"] == "poll" and e["status"] == "signed":
            update = {"status": "broadcast", "broadcastAt": self.now()}
        else:
            return e

        def apply(j: dict):
            x = next((y for y in j["entries"] if y["id"] == entry_id), None)
            if not x or x["status"] != e["status"]:
                return x
            x.update(update)
            return dict(x)
        return self.journal.locked(apply)

    def reconcile_all(self) -> list:
        results = []
        for e in [x for x in self.journal.read()["entries"] if not is_final(x)]:
            try:
                results.append(self.reconcile_entry(e["id"]))
            except FlurboError as err:
                self.log("reconcile_failed", {"entry": e["id"], "code": err.code})
        return results

    def report(self) -> None:
        """Reports every transaction that reached the network, idempotently, and records Flurbo's status."""
        if not self.client:
            return
        final_flurbo = ("confirmed", "reverted", "mismatch", "attributed-elsewhere")
        for e in self.journal.read()["entries"]:
            landed = e["hash"] and e["status"] in ("broadcast", "confirmed", "reverted", "mismatch")
            if not landed or e["report"]["status"] == "rejected" or (e["report"]["status"] == "accepted" and e["report"]["flurboStatus"] in final_flurbo):
                continue
            stop = False
            try:
                r = self.client.execution(e["hash"]) if e["report"]["status"] == "accepted" else self.client.report_execution(
                    {"namespace": e["namespace"], "hash": e["hash"], "intent": _report_intent(e), "decisionId": e["decisionId"], "nonce": e["nonce"], "sdk": {"language": "python", "version": "0.2.0"}})
                status = {"status": "accepted", "flurboStatus": (r or {}).get("status")}
            except RuntimeApiError as err:
                status = {"status": "rejected" if err.api_code == "HASH_CONFLICT" else "pending", "flurboStatus": err.api_code}
                stop = err.stop
                if stop and self.on_stop:
                    self.on_stop(err.api_code)

            def save(j: dict, eid=e["id"], s=status):
                x = next((y for y in j["entries"] if y["id"] == eid), None)
                if x:
                    x["report"] = {"status": s["status"], "attempts": x["report"]["attempts"] + 1, "flurboStatus": s["flurboStatus"]}
            self.journal.locked(save)
            if stop:
                return

    def wait(self, entry_id: str) -> dict | None:
        until = time.monotonic() + self.wait_seconds
        while True:
            e = self.reconcile_entry(entry_id)
            if not e or is_final(e) or time.monotonic() > until:
                return e
            time.sleep(self.poll_seconds)

    def _run(self, deployment, intent, decision_id, quote_block, slippage_bps) -> dict:
        planned = self.plan(deployment, intent, decision_id, quote_block, slippage_bps)
        if "entry" not in planned:
            return planned
        signed = self.sign(planned["entry"]["id"], deployment)
        if not signed:
            return {"status": "blocked", "reason": self.live_allowed()[1] or "not_planned"}
        self.broadcast(signed)
        self.report()
        done = self.wait(signed["id"])
        self.report()
        return {"status": done["status"] if done and is_final(done) else "pending", "entryId": signed["id"], "hash": signed["hash"], "costAtoms": (done or {}).get("costAtoms")}

    def _precheck(self, deployment, intent, quote_block, slippage_bps) -> list[str]:
        resolved, head = self.chain.resolved(deployment["pool"]), self.chain.block()
        held = self.chain.holdings(deployment["pool"], self.wallet, intent["claim"]["scope"], intent["claim"]["mask"])
        r = evaluate_policy({"policy": self.policy(), "now": self.now(), "market": {"namespace": deployment["namespace"], "pool": deployment["pool"], "eventCount": deployment["eventCount"],
                             "closesAt": deployment["closesAt"], "open": not resolved and head["timestamp"] < deployment["closesAt"], "resolved": resolved},
                             "wallet": {"nativeBalanceWei": "0", "holdings": [{"scope": intent["claim"]["scope"], "mask": str(intent["claim"]["mask"]), "quantityAtoms": str(held)}]},
                             "journal": policy_entries(self.journal.read()), "candidate": {"action": "buy", "namespace": deployment["namespace"],
                             "claim": {"scope": intent["claim"]["scope"], "mask": str(intent["claim"]["mask"])}, "quantityAtoms": str(intent["quantityAtoms"]),
                             "limitAtoms": str(intent["limitAtoms"]), "slippageBps": slippage_bps, "quoteBlockTimestamp": quote_block["timestamp"], "gasLimit": "0", "maxFeePerGas": "0"}})
        return [v for v in r["violations"] if v not in ("GAS_FEE_LIMIT", "GAS_RESERVE")]

    def execute(self, c: dict) -> dict:
        """c: {decisionId, deployment, action, claim:{scope, mask:int}, quantityAtoms, slippageBps, quoteAtoms, quoteBlock}."""
        allowed, reason = self.live_allowed()
        if not allowed:
            return {"status": "blocked", "reason": reason or "blocked"}
        d = c["deployment"]
        deadline_for = lambda b: min(b["timestamp"] + 300, d["closesAt"] - 1)
        if c["action"] == "redeem":
            return self._run(d, {"action": "redeem", "claim": c["claim"], "quantityAtoms": c["quantityAtoms"]}, c["decisionId"], None, 0)
        if c["action"] == "sell":
            return self._run(d, {"action": "sell", "claim": c["claim"], "quantityAtoms": c["quantityAtoms"], "limitAtoms": sell_minimum(c["quoteAtoms"], c["slippageBps"]),
                                 "deadline": deadline_for(c["quoteBlock"])}, c["decisionId"], c["quoteBlock"], c["slippageBps"])
        reason = self.semantic_check(d, c["claim"], c["quantityAtoms"])
        if reason:
            return {"status": "blocked", "reason": reason}
        limit, quote_block = buy_limit(c["quoteAtoms"], c["slippageBps"]), c["quoteBlock"]
        if any(e["action"] == "approve" and e["pool"] == d["pool"] and not is_final(e) for e in self.journal.read()["entries"]):
            return {"status": "approval_pending", "detail": "An approval for this pool is still being confirmed."}
        early = self._precheck(d, {"claim": c["claim"], "quantityAtoms": c["quantityAtoms"], "limitAtoms": limit}, quote_block, c["slippageBps"])
        if early:
            return {"status": "rejected_by_policy", "violations": early}
        if self.chain.allowance(self.wallet, d["pool"]) < limit:
            approval = self._run(d, {"action": "approve", "amountAtoms": limit}, c["decisionId"], None, 0)
            if approval["status"] != "confirmed":
                return approval if approval["status"] == "rejected_by_policy" else {"status": "approval_pending", "detail": f"Approval {approval['status']}; the purchase waits for the next cycle."}
            quote_block = self.chain.block()  # re-quote; a higher cost is never accepted to force the fill
            again = self.chain.quote(d["pool"], "buy", c["claim"]["scope"], c["claim"]["mask"], c["quantityAtoms"], quote_block)
            if again is None:
                return {"status": "quote_unavailable", "detail": "The pool no longer quotes this claim at this size."}
            if buy_limit(again, c["slippageBps"]) > limit:
                return {"status": "price_moved", "detail": "The price rose after the approval; the next cycle decides again."}
            limit = buy_limit(again, c["slippageBps"])
        return self._run(d, {"action": "buy", "claim": c["claim"], "quantityAtoms": c["quantityAtoms"], "limitAtoms": limit, "deadline": deadline_for(quote_block)},
                         c["decisionId"], quote_block, c["slippageBps"])
