// Live execution (protocol/specs/transactions.md), in the same crash-safe order as the TypeScript runtime:
//   plan under the lock (policy check and spend reservation in one step)
//   re-check permission, assign the nonce and sign under the lock, recording the signed bytes
//   broadcast outside the lock; a failure or timeout here is "unknown", never "failed"
//   reconcile from the chain; resend only the identical signed bytes
#include <chrono>

#include <algorithm>

#include "flurbo/runtime.hpp"

namespace flurbo {

using json::Value;

namespace {

constexpr u128 MAX_GAS = 15'000'000;

Value* find_entry(Value& j, const std::string& id) {
  for (auto& e : j.get_or_add("entries").as_array())
    if (e.str("id") == id) return &e;
  return nullptr;
}

std::optional<Value> find_copy(const Value& j, const std::string& id) {
  for (const auto& e : j["entries"].as_array())
    if (e.str("id") == id) return e;
  return std::nullopt;
}

Intent intent_of(const Value& e) {
  std::string a = e.str("action");
  if (a == "approve") return Intent::approve(parse_i128(e.str("limitAtoms")));
  Claim c{static_cast<unsigned>(e["claim"]["scope"].as_int()), static_cast<unsigned>(std::stoul(e["claim"].str("mask")))};
  i128 q = parse_i128(e.str("quantityAtoms"));
  if (a == "redeem") return Intent::redeem(c, q);
  uint64_t deadline = static_cast<uint64_t>(e["deadline"].as_int());
  return a == "buy" ? Intent::buy(c, q, parse_i128(e.str("limitAtoms")), deadline) : Intent::sell(c, q, parse_i128(e.str("limitAtoms")), deadline);
}

Value report_intent(const Value& e) {
  Value v = Value::object();
  std::string a = e.str("action");
  v.set("action", a);
  if (a == "approve") {
    v.set("claim", Value());
    v.set("quantityAtoms", "0");
    v.set("limitAtoms", e["limitAtoms"]);
    v.set("deadline", Value());
  } else {
    v.set("claim", e["claim"]);
    v.set("quantityAtoms", e["quantityAtoms"]);
    v.set("limitAtoms", a == "redeem" ? Value("0") : e["limitAtoms"]);
    v.set("deadline", a == "redeem" ? Value() : e["deadline"]);
  }
  return v;
}

Value facts(const Receipt& r) {
  Value f = Value::object();
  f.set("blockNumber", std::to_string(r.block_number));
  f.set("gasUsed", to_string_u(r.gas_used));
  f.set("effectiveGasPrice", r.effective_gas_price ? Value(to_string_u(*r.effective_gas_price)) : Value());
  return f;
}

u128 u128_of(const Value& v) { return v.is_string() ? static_cast<u128>(parse_i128(v.as_string())) : 0; }

}  // namespace

Executor::Executor(std::shared_ptr<ChainReader> chain, std::shared_ptr<Signer> signer, std::shared_ptr<FileJournal> journal, std::shared_ptr<RuntimeClient> client,
                   std::shared_ptr<Controls> controls, int wait_ms)
    : wallet(signer->address()), chain_(std::move(chain)), signer_(std::move(signer)), journal_(std::move(journal)), client_(std::move(client)),
      controls_(std::move(controls)), wait_ms_(wait_ms) {}

Planned Executor::plan(const Deployment& d, const Intent& intent, const std::string& decision_id, const std::optional<Block>& quote_block, int64_t slippage_bps) {
  UnsignedCall tx = build_transaction(intent, d, wallet);
  try {
    chain_->simulate(wallet, tx.to, tx.data);
  } catch (const Error&) {
    return {"simulation_failed", {}, {}, "The transaction would revert at the latest block."};
  }
  u128 gas;
  try {
    gas = chain_->estimate_gas(wallet, tx.to, tx.data) * 120 / 100;
  } catch (const Error&) {
    return {"simulation_failed", {}, {}, "Gas could not be estimated."};
  }
  if (gas == 0 || gas > MAX_GAS) return {"simulation_failed", {}, {}, "Gas is outside the service limit."};
  Fees fees = chain_->fees();
  u128 native = chain_->native_balance(wallet);
  Block head = chain_->block();
  bool resolved = chain_->resolved(d.pool);
  Policy policy = controls_->policy();
  Value snapshot = journal_->read();
  std::vector<ClaimRef> claims;
  auto note = [&](const ClaimRef& c) {
    if (std::find(claims.begin(), claims.end(), c) == claims.end()) claims.push_back(c);
  };
  for (const auto& e : snapshot["entries"].as_array())
    if (e["claim"].is_object() && e.str("namespace") == d.namespace_) note(ClaimRef::from_json(e["claim"]));
  if (intent.action != "approve") note(ClaimRef::of(intent.claim.scope, intent.claim.mask));
  std::vector<Holding> holdings;
  for (const auto& c : claims) holdings.push_back({c, static_cast<i128>(chain_->holdings(d.pool, wallet, c.scope, c.mask_u()))});
  int64_t now = controls_->now();
  PolicyMarket market{d.namespace_, d.pool, d.event_count, static_cast<int64_t>(d.closes_at), !resolved && head.timestamp < static_cast<int64_t>(d.closes_at), resolved};
  return journal_->locked([&](Value& j) -> Planned {
    i128 fee = static_cast<i128>(gas * fees.max_fee_per_gas);
    std::vector<std::string> violations;
    if (intent.action == "approve") {
      if (intent.limit_atoms < 1 || intent.limit_atoms > SERVICE_MAX_ATOMS) violations.push_back("SERVICE_LIMIT");
      if (std::find(policy.markets.begin(), policy.markets.end(), d.namespace_) == policy.markets.end()) violations.push_back("MARKET_NOT_ALLOWED");
      if (fee > policy.max_fee_wei) violations.push_back("GAS_FEE_LIMIT");
      if (static_cast<i128>(native) - fee < policy.reserve_wei) violations.push_back("GAS_RESERVE");
      size_t pending = 0;
      for (const auto& e : j["entries"].as_array()) pending += !is_final(e);
      if (pending >= policy.max_pending) violations.push_back("PENDING_LIMIT");
    } else {
      PolicyInput in;
      in.policy = policy;
      in.now = now;
      in.market = market;
      in.native_balance_wei = static_cast<i128>(native);
      in.holdings = holdings;
      in.journal = policy_entries(j);
      in.candidate = {intent.action, d.namespace_, ClaimRef::of(intent.claim.scope, intent.claim.mask), intent.quantity_atoms,
                      intent.action == "redeem" ? 0 : intent.limit_atoms, slippage_bps, quote_block ? quote_block->timestamp : now, static_cast<i128>(gas),
                      static_cast<i128>(fees.max_fee_per_gas)};
      violations = evaluate_policy(in);
    }
    if (!violations.empty()) return {"rejected_by_policy", {}, violations, ""};
    bool approve = intent.action == "approve", redeem = intent.action == "redeem";
    Value e = Value::object();
    e.set("id", uuid4());
    e.set("action", intent.action);
    e.set("namespace", d.namespace_);
    e.set("pool", d.pool);
    e.set("claim", approve ? Value() : ClaimRef::of(intent.claim.scope, intent.claim.mask).to_json());
    e.set("quantityAtoms", approve ? "0" : to_string(intent.quantity_atoms));
    e.set("limitAtoms", redeem ? "0" : to_string(intent.limit_atoms));
    e.set("deadline", approve || redeem ? Value() : Value(static_cast<int64_t>(intent.deadline)));
    e.set("status", "planned");
    e.set("plannedAt", now);
    e.set("decisionId", decision_id);
    e.set("to", tx.to);
    e.set("data", tx.data);
    e.set("gas", to_string_u(gas));
    e.set("maxFeePerGas", to_string_u(fees.max_fee_per_gas));
    e.set("maxPriorityFeePerGas", to_string_u(fees.max_priority_fee_per_gas));
    for (const char* k : {"nonce", "rawTransaction", "hash", "signedAt", "broadcastAt", "finalAt", "costAtoms", "receipt", "note"}) e.set(k, Value());
    e.set("owner", owner());
    Value report = Value::object();
    report.set("status", "none");
    report.set("attempts", 0);
    report.set("flurboStatus", Value());
    e.set("report", report);
    j.get_or_add("entries").push(e);
    return {"planned", e, {}, ""};
  });
}

std::string Executor::semantic_check(const Deployment& d, const Claim& c, i128 quantity) {
  std::string reason = "SEMANTICS_UNAVAILABLE";
  bool disabled = false;
  try {
    if (client_) {
      auto r = client_->validate_trade(d.namespace_, c.scope, c.mask, to_string(quantity));
      reason = semantic_error(r, d, c.scope, c.mask, to_string(quantity), controls_->now());
      disabled = reason.empty() && semantics_disabled(r);
    }
  } catch (...) {}
  if (!reason.empty() || disabled) { Value detail = Value::object(); detail.set("namespace", d.namespace_); controls_->log(disabled ? "SEMANTICS_DISABLED" : reason, detail); }
  return reason;
}

std::optional<Value> Executor::sign(const std::string& entry_id, const Deployment& d) {
  return journal_->locked([&](Value& j) -> std::optional<Value> {
    std::optional<uint64_t> highest;
    for (const auto& x : j["entries"].as_array())
      if (!is_final(x) && x["nonce"].is_integer()) highest = std::max(highest.value_or(0), static_cast<uint64_t>(x["nonce"].as_int()));
    Value* e = find_entry(j, entry_id);
    if (!e || e->str("status") != "planned") return std::nullopt;
    auto [allowed, reason] = controls_->live_allowed();
    if (!allowed) {
      e->set("status", "abandoned");
      e->set("finalAt", controls_->now());
      e->set("note", "not signed: " + reason);
      return std::nullopt;
    }
    if (e->str("action") == "buy") {
      auto intent = intent_of(*e);
      auto collision = semantic_check(d, intent.claim, intent.quantity_atoms);
      if (!collision.empty()) { e->set("status", "abandoned"); e->set("finalAt", controls_->now()); e->set("note", collision); return std::nullopt; }
    }
    validate_transaction({CHAIN_ID, wallet, e->str("to"), e->str("data"), 0}, intent_of(*e), d, wallet);
    uint64_t pending = chain_->nonce(wallet, "pending");
    uint64_t nonce = highest ? std::max(pending, *highest + 1) : pending;
    Tx1559 tx{CHAIN_ID, nonce, e->str("to"), e->str("data"), 0, u128_of((*e)["gas"]), u128_of((*e)["maxFeePerGas"]), u128_of((*e)["maxPriorityFeePerGas"])};
    std::string raw = signer_->sign_transaction(tx);
    e->set("status", "signed");
    e->set("nonce", static_cast<int64_t>(nonce));
    e->set("rawTransaction", raw);
    e->set("hash", lower(transaction_hash(raw)));
    e->set("signedAt", controls_->now());
    return *e;
  });
}

void Executor::broadcast(const Value& e) {
  Value hash = Value::object();
  hash.set("hash", e["hash"]);
  try {
    chain_->send_raw(e.str("rawTransaction"));
  } catch (const Error&) {
    controls_->log("broadcast_uncertain", hash);  // recovery looks the hash up; nothing new is signed
    return;
  }
  journal_->locked([&](Value& j) {
    Value* x = find_entry(j, e.str("id"));
    if (x && x->str("status") == "signed") {
      x->set("status", "broadcast");
      x->set("broadcastAt", controls_->now());
    }
  });
  controls_->log("broadcast", hash);
}

std::optional<Value> Executor::reconcile_entry(const std::string& entry_id) {
  auto found = find_copy(journal_->read(), entry_id);
  if (!found || is_final(*found)) return found;
  Value e = *found;
  if (e.str("status") == "planned" && controls_->now() - e.integer("plannedAt") < 60 && e["owner"].integer("pid") != static_cast<int64_t>(process_id()))
    return e;  // a fresh plan of a live process; it re-checks before signing
  Block head = chain_->block();
  std::string hash = e.str("hash");
  std::optional<Receipt> receipt = hash.empty() ? std::nullopt : chain_->receipt(hash);
  bool tx_found = receipt.has_value() || (!hash.empty() && chain_->transaction_found(hash));
  // A receipt counts once one more block is built on it, the same depth Flurbo's verifier requires.
  std::optional<Receipt> settled = receipt && head.number > receipt->block_number ? receipt : std::nullopt;
  RecoveryEntry r{e.str("status"), std::nullopt, std::nullopt};
  if (e["nonce"].is_integer()) r.nonce = static_cast<uint64_t>(e["nonce"].as_int());
  if (e["deadline"].is_integer()) r.deadline = e["deadline"].as_int();
  ChainView view{tx_found, settled ? std::optional<int>(settled->status) : std::nullopt, chain_->nonce(wallet, "latest")};
  Step step = recovery_step(r, view, head.timestamp);
  int64_t now = controls_->now();
  std::function<void(Value&)> update;
  if (step.action == "verify" && settled) {
    std::optional<std::string> allowance;
    if (e.str("action") == "approve") allowance = chain_->allowance(wallet, e.str("pool"), hex_of(settled->block_number)).dec();
    EffectIntent intent{e.str("action"), wallet, e.str("pool"), std::nullopt, parse_i128(e.str("quantityAtoms")),
                        e.str("action") == "redeem" ? 0 : parse_i128(e.str("limitAtoms"))};
    if (e["claim"].is_object()) intent.claim = ClaimRef::from_json(e["claim"]);
    Effect effect = verify_effect(intent, settled->status, settled->logs, allowance);
    Value f = facts(*settled);
    update = [effect, f, now](Value& x) {
      x.set("status", effect.status);
      x.set("finalAt", now);
      x.set("costAtoms", effect.status == "confirmed" && effect.collateral_atoms ? Value(to_string(*effect.collateral_atoms)) : Value());
      x.set("receipt", f);
    };
  } else if (step.action == "release") {
    std::optional<Value> f;
    if (receipt) f = facts(*receipt);
    update = [step, f, now](Value& x) {
      x.set("status", step.status);
      x.set("finalAt", now);
      if (f) x.set("receipt", *f);
    };
  } else if (step.action == "rebroadcast") {
    try {
      chain_->send_raw(e.str("rawTransaction"));
      Value h = Value::object();
      h.set("hash", hash);
      controls_->log("rebroadcast_same_bytes", h);
    } catch (const Error&) {
    }
    return e;
  } else if (step.action == "poll" && e.str("status") == "signed") {
    update = [now](Value& x) {
      x.set("status", "broadcast");
      x.set("broadcastAt", now);
    };
  } else {
    return e;
  }
  return journal_->locked([&](Value& j) -> std::optional<Value> {
    Value* x = find_entry(j, entry_id);
    if (!x) return std::nullopt;
    if (x->str("status") != e.str("status")) return *x;
    update(*x);
    return *x;
  });
}

size_t Executor::reconcile_all() {
  std::vector<std::string> open;
  for (const auto& e : journal_->entries())
    if (!is_final(e)) open.push_back(e.str("id"));
  for (const auto& id : open) {
    try {
      reconcile_entry(id);
    } catch (const Error& err) {
      Value d = Value::object();
      d.set("entry", id);
      d.set("code", err.code);
      controls_->log("reconcile_failed", d);
    }
  }
  return open.size();
}

void Executor::report() {
  if (!client_) return;
  for (const auto& e : journal_->entries()) {
    std::string status = e.str("status"), report_status = e["report"].str("status"), flurbo = e["report"].str("flurboStatus");
    bool landed = !e.str("hash").empty() && (status == "broadcast" || status == "confirmed" || status == "reverted" || status == "mismatch");
    bool done = report_status == "rejected" ||
                (report_status == "accepted" && (flurbo == "confirmed" || flurbo == "reverted" || flurbo == "mismatch" || flurbo == "attributed-elsewhere"));
    if (!landed || done) continue;
    std::string next_status;
    Value next_flurbo;
    bool stop = false;
    try {
      Value r;
      if (report_status == "accepted") {
        r = client_->execution(e.str("hash"));
      } else {
        Value body = Value::object(), sdk = Value::object();
        sdk.set("language", SDK_LANGUAGE);
        sdk.set("version", SDK_VERSION);
        body.set("namespace", e["namespace"]);
        body.set("hash", e["hash"]);
        body.set("intent", report_intent(e));
        body.set("decisionId", e["decisionId"]);
        body.set("nonce", e["nonce"]);
        body.set("sdk", sdk);
        r = client_->report_execution(body);
      }
      next_status = "accepted";
      next_flurbo = r["status"].is_string() ? r["status"] : Value();
    } catch (const Error& err) {
      next_status = err.api_code == "HASH_CONFLICT" ? "rejected" : "pending";
      next_flurbo = err.api_code.empty() ? Value() : Value(err.api_code);
      stop = is_stop(err);
      if (stop) controls_->stop(err.api_code);
    }
    journal_->locked([&](Value& j) {
      if (Value* x = find_entry(j, e.str("id"))) {
        Value rep = Value::object();
        rep.set("status", next_status);
        rep.set("attempts", (*x)["report"].integer("attempts") + 1);
        rep.set("flurboStatus", next_flurbo);
        x->set("report", rep);
      }
    });
    if (stop) return;
  }
}

std::optional<Value> Executor::wait_for(const std::string& entry_id) {
  auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(wait_ms_);
  for (;;) {
    auto e = reconcile_entry(entry_id);
    if (!e || is_final(*e) || std::chrono::steady_clock::now() > until) return e;
    sleep_ms(poll_ms);
  }
}

Outcome Executor::run(const Deployment& d, const Intent& intent, const std::string& decision_id, const std::optional<Block>& quote_block, int64_t slippage_bps) {
  Planned p = plan(d, intent, decision_id, quote_block, slippage_bps);
  if (p.status == "rejected_by_policy") return {"rejected_by_policy", "", p.violations, "", "", std::nullopt};
  if (p.status == "simulation_failed") return {"simulation_failed", p.detail, {}, "", "", std::nullopt};
  auto signed_entry = sign(p.entry.str("id"), d);
  if (!signed_entry) {
    std::string reason = controls_->live_allowed().second;
    return {"blocked", reason.empty() ? "not_planned" : reason, {}, "", "", std::nullopt};
  }
  broadcast(*signed_entry);
  report();
  auto done = wait_for(signed_entry->str("id"));
  report();
  Outcome o{done && is_final(*done) ? done->str("status") : "pending", "", {}, signed_entry->str("id"), signed_entry->str("hash"), std::nullopt};
  if (done && (*done)["costAtoms"].is_string()) o.cost_atoms = (*done)["costAtoms"].as_string();
  return o;
}

std::vector<std::string> Executor::precheck(const Deployment& d, const Claim& c, i128 quantity, i128 limit, const Block& quote_block, i128 slippage_bps) {
  bool resolved = chain_->resolved(d.pool);
  Block head = chain_->block();
  PolicyInput in;
  in.policy = controls_->policy();
  in.now = controls_->now();
  in.market = {d.namespace_, d.pool, d.event_count, static_cast<int64_t>(d.closes_at), !resolved && head.timestamp < static_cast<int64_t>(d.closes_at), resolved};
  in.holdings = {{ClaimRef::of(c.scope, c.mask), static_cast<i128>(chain_->holdings(d.pool, wallet, c.scope, c.mask))}};
  in.journal = policy_entries(journal_->read());
  in.candidate = {"buy", d.namespace_, ClaimRef::of(c.scope, c.mask), quantity, limit, static_cast<int64_t>(slippage_bps), quote_block.timestamp, 0, 0};
  std::vector<std::string> out;
  for (const auto& v : evaluate_policy(in))
    if (v != "GAS_FEE_LIMIT" && v != "GAS_RESERVE") out.push_back(v);
  return out;
}

Outcome Executor::execute(const ExecutionRequest& c) {
  auto [allowed, reason] = controls_->live_allowed();
  if (!allowed) return {"blocked", reason.empty() ? "blocked" : reason, {}, "", "", std::nullopt};
  const Deployment& d = c.deployment;
  auto deadline_for = [&](const Block& b) { return std::min<uint64_t>(static_cast<uint64_t>(b.timestamp + 300), d.closes_at - 1); };
  int64_t slippage = static_cast<int64_t>(c.slippage_bps);
  if (c.action == "redeem") return run(d, Intent::redeem(c.claim, c.quantity_atoms), c.decision_id, std::nullopt, 0);
  if (c.action == "sell")
    return run(d, Intent::sell(c.claim, c.quantity_atoms, sell_minimum(c.quote_atoms, c.slippage_bps), deadline_for(c.quote_block)), c.decision_id, c.quote_block, slippage);
  auto semantic = semantic_check(d, c.claim, c.quantity_atoms);
  if (!semantic.empty()) return {"blocked", semantic, {}, "", "", std::nullopt};
  i128 limit = buy_limit(c.quote_atoms, c.slippage_bps);
  Block quote_block = c.quote_block;
  for (const auto& e : journal_->entries())
    if (e.str("action") == "approve" && e.str("pool") == d.pool && !is_final(e))
      return {"approval_pending", "An approval for this pool is still being confirmed.", {}, "", "", std::nullopt};
  auto early = precheck(d, c.claim, c.quantity_atoms, limit, quote_block, c.slippage_bps);
  if (!early.empty()) return {"rejected_by_policy", "", early, "", "", std::nullopt};
  auto allowance = chain_->allowance(wallet, d.pool).to_u128();
  if (allowance && static_cast<i128>(*allowance) < limit) {
    Outcome approval = run(d, Intent::approve(limit), c.decision_id, std::nullopt, 0);
    if (approval.status != "confirmed") {
      if (approval.status == "rejected_by_policy") return approval;
      return {"approval_pending", "Approval " + approval.status + "; the purchase waits for the next cycle.", {}, "", "", std::nullopt};
    }
    quote_block = chain_->block();  // re-quote; a higher cost is never accepted to force the fill
    auto again = chain_->quote(d.pool, "buy", c.claim.scope, c.claim.mask, static_cast<u128>(c.quantity_atoms), quote_block);
    if (!again) return {"quote_unavailable", "The pool no longer quotes this claim at this size.", {}, "", "", std::nullopt};
    i128 again_limit = buy_limit(static_cast<i128>(*again), c.slippage_bps);
    if (again_limit > limit) return {"price_moved", "The price rose after the approval; the next cycle decides again.", {}, "", "", std::nullopt};
    limit = again_limit;
  }
  return run(d, Intent::buy(c.claim, c.quantity_atoms, limit, deadline_for(quote_block)), c.decision_id, quote_block, slippage);
}

}  // namespace flurbo
