#include "flurbo/policy.hpp"

#include <algorithm>
#include <map>
#include <set>

namespace flurbo {

const char* const VIOLATIONS[18] = {"SERVICE_LIMIT", "MARKET_NOT_ALLOWED", "MARKET_CLOSED", "MARKET_NOT_RESOLVED", "TOO_CLOSE_TO_CLOSE", "ACTION_DISABLED",
                                    "HOLDINGS_INSUFFICIENT", "QUANTITY_LIMIT", "TRADE_COST_LIMIT", "SLIPPAGE_LIMIT", "QUOTE_STALE", "TOTAL_SPEND_LIMIT",
                                    "WINDOW_SPEND_LIMIT", "POSITION_LIMIT", "WORST_CASE_LOSS_LIMIT", "GAS_FEE_LIMIT", "GAS_RESERVE", "PENDING_LIMIT"};

bool unfinished(const std::string& s) { return s == "planned" || s == "signed" || s == "broadcast"; }
bool final_status(const std::string& s) { return !unfinished(s); }

json::Value Window::to_json() const {
  json::Value v = json::Value::object();
  v.set("seconds", seconds);
  v.set("atoms", to_string(atoms));
  return v;
}

static std::vector<Window> windows_of(const json::Value& a) {
  std::vector<Window> out;
  if (a.is_array())
    for (const auto& w : a.as_array()) out.push_back({w["seconds"].as_int(), num(w["atoms"])});
  return out;
}

Policy Policy::from_json(const json::Value& v) {
  Policy p;
  for (const auto& m : v["markets"].as_array()) p.markets.push_back(m.as_string());
  p.max_quantity_atoms = num(v["maxQuantityAtoms"]);
  p.max_trade_cost_atoms = num(v["maxTradeCostAtoms"]);
  p.max_slippage_bps = v["maxSlippageBps"].as_int();
  p.total_atoms = num(v["spend"]["totalAtoms"]);
  p.windows = windows_of(v["spend"]["windows"]);
  p.max_position_atoms = num(v["maxPositionAtoms"]);
  p.max_worst_case_loss_atoms = num(v["maxWorstCaseLossAtoms"]);
  p.max_fee_wei = num(v["gas"]["maxFeeWei"]);
  p.reserve_wei = num(v["gas"]["reserveWei"]);
  p.quote_max_age_seconds = v["quoteMaxAgeSeconds"].as_int();
  p.min_seconds_before_close = v["minSecondsBeforeClose"].as_int();
  p.max_pending = static_cast<size_t>(v["maxPending"].as_int());
  p.allow_sell = v["allowSell"].as_bool();
  p.allow_redeem = v["allowRedeem"].as_bool();
  return p;
}

json::Value Policy::to_json() const {
  json::Value v = json::Value::object(), m = json::Value::array(), w = json::Value::array();
  for (const auto& x : markets) m.push(x);
  for (const auto& x : windows) w.push(x.to_json());
  json::Value spend = json::Value::object(), gas = json::Value::object();
  spend.set("totalAtoms", to_string(total_atoms));
  spend.set("windows", w);
  gas.set("maxFeeWei", to_string(max_fee_wei));
  gas.set("reserveWei", to_string(reserve_wei));
  v.set("markets", m);
  v.set("maxQuantityAtoms", to_string(max_quantity_atoms));
  v.set("maxTradeCostAtoms", to_string(max_trade_cost_atoms));
  v.set("maxSlippageBps", max_slippage_bps);
  v.set("spend", spend);
  v.set("maxPositionAtoms", to_string(max_position_atoms));
  v.set("maxWorstCaseLossAtoms", to_string(max_worst_case_loss_atoms));
  v.set("gas", gas);
  v.set("quoteMaxAgeSeconds", quote_max_age_seconds);
  v.set("minSecondsBeforeClose", min_seconds_before_close);
  v.set("maxPending", static_cast<int64_t>(max_pending));
  v.set("allowSell", allow_sell);
  v.set("allowRedeem", allow_redeem);
  return v;
}

PolicyEntry PolicyEntry::from_json(const json::Value& v) {
  PolicyEntry e;
  e.id = v.str("id");
  e.action = v.str("action");
  e.namespace_ = v.str("namespace");
  e.status = v.str("status");
  if (v["claim"].is_object()) e.claim = ClaimRef::from_json(v["claim"]);
  e.quantity_atoms = num(v["quantityAtoms"]);
  e.limit_atoms = num(v["limitAtoms"]);
  if (!v["costAtoms"].is_null()) e.cost_atoms = num(v["costAtoms"]);
  e.planned_at = v["plannedAt"].as_int();
  return e;
}

PolicyInput PolicyInput::from_json(const json::Value& v) {
  PolicyInput in;
  in.policy = Policy::from_json(v["policy"]);
  in.now = v["now"].as_int();
  const auto& m = v["market"];
  in.market = {m.str("namespace"), m.str("pool"), static_cast<unsigned>(m["eventCount"].as_int()), m["closesAt"].as_int(), m["open"].as_bool(), m["resolved"].as_bool()};
  in.native_balance_wei = num(v["wallet"]["nativeBalanceWei"]);
  for (const auto& h : v["wallet"]["holdings"].as_array()) in.holdings.push_back({ClaimRef::from_json(h), num(h["quantityAtoms"])});
  for (const auto& e : v["journal"].as_array()) in.journal.push_back(PolicyEntry::from_json(e));
  const auto& c = v["candidate"];
  in.candidate = {c.str("action"), c.str("namespace"), ClaimRef::from_json(c["claim"]), num(c["quantityAtoms"]), num(c["limitAtoms"]),
                  c["slippageBps"].as_int(), c["quoteBlockTimestamp"].as_int(), num(c["gasLimit"]), num(c["maxFeePerGas"])};
  return in;
}

i128 spend_of(const PolicyEntry& e) {
  if (e.action != "buy") return 0;
  if (e.status == "confirmed") return e.cost_atoms.value_or(0);
  if (unfinished(e.status) || e.status == "mismatch") return e.limit_atoms;
  return 0;
}

i128 worst_case_loss(const PolicyInput& in) {
  std::map<std::pair<unsigned, unsigned>, i128> positions;
  i128 cost = 0;
  auto add = [&](const ClaimRef& c, i128 q) { positions[{c.scope, c.mask_u()}] += q; };
  for (const auto& e : in.journal) {
    if (e.namespace_ != in.market.namespace_ || !e.claim) continue;
    if (e.action == "buy" && e.status == "confirmed") {
      add(*e.claim, e.quantity_atoms);
      cost += e.cost_atoms.value_or(0);
    } else if (e.action == "buy" && unfinished(e.status)) {
      add(*e.claim, e.quantity_atoms);
      cost += e.limit_atoms;
    } else if ((e.action == "sell" || e.action == "redeem") && e.status == "confirmed") {
      add(*e.claim, -e.quantity_atoms);
    }
  }
  add(in.candidate.claim, in.candidate.quantity_atoms);
  cost += in.candidate.limit_atoms;
  std::optional<i128> floor;
  for (unsigned state = 0; state < (1u << in.market.event_count); ++state) {
    i128 payout = 0;
    for (const auto& [k, q] : positions)
      if (q > 0 && pays_in(k.first, k.second, state)) payout += q;
    if (!floor || payout < *floor) floor = payout;
  }
  return cost - floor.value_or(0);
}

std::vector<std::string> evaluate_policy(const PolicyInput& in) {
  const auto& p = in.policy;
  const auto& c = in.candidate;
  const auto& market = in.market;
  std::set<std::string> found;
  bool buy = c.action == "buy", trade = buy || c.action == "sell";
  bool slippage_ok = c.slippage_bps == 10 || c.slippage_bps == 50 || c.slippage_bps == 100;
  if (c.quantity_atoms < 1 || c.quantity_atoms > SERVICE_MAX_ATOMS || c.limit_atoms > SERVICE_MAX_ATOMS || (trade && !slippage_ok)) found.insert("SERVICE_LIMIT");
  if (std::find(p.markets.begin(), p.markets.end(), c.namespace_) == p.markets.end() || c.namespace_ != market.namespace_) found.insert("MARKET_NOT_ALLOWED");
  bool closed = !market.open || in.now >= market.closes_at;
  if (trade && closed) found.insert("MARKET_CLOSED");
  if (c.action == "redeem" && !market.resolved) found.insert("MARKET_NOT_RESOLVED");
  if (trade && !closed && market.closes_at - in.now < p.min_seconds_before_close) found.insert("TOO_CLOSE_TO_CLOSE");
  if ((c.action == "sell" && !p.allow_sell) || (c.action == "redeem" && !p.allow_redeem)) found.insert("ACTION_DISABLED");
  i128 held = 0;
  for (const auto& h : in.holdings)
    if (h.claim == c.claim) held += h.quantity_atoms;
  if (!buy && held < c.quantity_atoms) found.insert("HOLDINGS_INSUFFICIENT");
  if (c.quantity_atoms > p.max_quantity_atoms) found.insert("QUANTITY_LIMIT");
  if (buy && c.limit_atoms > p.max_trade_cost_atoms) found.insert("TRADE_COST_LIMIT");
  if (trade && c.slippage_bps > p.max_slippage_bps) found.insert("SLIPPAGE_LIMIT");
  if (trade && in.now - c.quote_block_timestamp > p.quote_max_age_seconds) found.insert("QUOTE_STALE");
  if (buy) {
    i128 total = 0;
    for (const auto& e : in.journal) total += spend_of(e);
    if (total + c.limit_atoms > p.total_atoms) found.insert("TOTAL_SPEND_LIMIT");
    for (const auto& w : p.windows) {
      i128 spent = 0;
      for (const auto& e : in.journal)
        if (e.planned_at >= in.now - w.seconds) spent += spend_of(e);
      if (spent + c.limit_atoms > w.atoms) found.insert("WINDOW_SPEND_LIMIT");
    }
    i128 pending_same = 0;
    for (const auto& e : in.journal)
      if (e.action == "buy" && unfinished(e.status) && e.namespace_ == c.namespace_ && e.claim && *e.claim == c.claim) pending_same += e.quantity_atoms;
    if (held + pending_same + c.quantity_atoms > p.max_position_atoms) found.insert("POSITION_LIMIT");
    if (worst_case_loss(in) > p.max_worst_case_loss_atoms) found.insert("WORST_CASE_LOSS_LIMIT");
  }
  i128 fee = c.gas_limit * c.max_fee_per_gas;
  if (fee > p.max_fee_wei) found.insert("GAS_FEE_LIMIT");
  if (in.native_balance_wei - fee < p.reserve_wei) found.insert("GAS_RESERVE");
  size_t pending = std::count_if(in.journal.begin(), in.journal.end(), [](const PolicyEntry& e) { return unfinished(e.status); });
  if (pending >= p.max_pending) found.insert("PENDING_LIMIT");
  std::vector<std::string> out;
  for (const char* v : VIOLATIONS)
    if (found.count(v)) out.push_back(v);
  return out;
}

FlurboPolicy FlurboPolicy::from_json(const json::Value& v) {
  FlurboPolicy f;
  f.version = v["version"].as_int();
  f.paused = v["paused"].as_bool();
  f.live_enabled = v["liveEnabled"].as_bool();
  if (!v["limits"]["maxTradeCostAtoms"].is_null()) f.max_trade_cost_atoms = num(v["limits"]["maxTradeCostAtoms"]);
  f.windows = windows_of(v["limits"]["windows"]);
  return f;
}

json::Value EffectivePolicy::to_json() const {
  json::Value v = json::Value::object(), w = json::Value::array();
  for (const auto& x : windows) w.push(x.to_json());
  v.set("maxTradeCostAtoms", to_string(max_trade_cost_atoms));
  v.set("windows", w);
  v.set("liveAllowed", live_allowed);
  v.set("reason", reason ? json::Value(*reason) : json::Value());
  return v;
}

EffectivePolicy effective_policy(const LocalPolicy& local, const std::optional<FlurboPolicy>& flurbo, std::optional<int64_t> read_at, int64_t now, int64_t max_age) {
  EffectivePolicy e;
  e.max_trade_cost_atoms = local.max_trade_cost_atoms;
  if (flurbo && flurbo->max_trade_cost_atoms && *flurbo->max_trade_cost_atoms < local.max_trade_cost_atoms) e.max_trade_cost_atoms = *flurbo->max_trade_cost_atoms;
  e.windows = local.windows;
  if (flurbo) e.windows.insert(e.windows.end(), flurbo->windows.begin(), flurbo->windows.end());
  bool stale = !read_at || now - *read_at > max_age;
  if (local.mode != "live") e.reason = "local_paper_mode";
  else if (!flurbo) e.reason = "policy_stale";
  else if (!flurbo->live_enabled) e.reason = "live_disabled";
  else if (flurbo->paused) e.reason = "paused";
  else if (stale) e.reason = "policy_stale";
  e.live_allowed = !e.reason;
  return e;
}

Step recovery_step(const RecoveryEntry& e, const ChainView& chain, int64_t now) {
  if (final_status(e.status)) return {e.status, "none"};
  if (e.status == "planned") return {"abandoned", "release"};  // nothing was signed
  if (chain.receipt_status == 1) return {"broadcast", "verify"};
  if (chain.receipt_status == 0) return {"reverted", "release"};
  if (chain.tx_found) return {"broadcast", "poll"};
  if (e.nonce && chain.nonce_latest > *e.nonce) return {"replaced", "release"};
  if (e.deadline && now > *e.deadline) return {"expired", "release"};
  // Same signed bytes, same hash: sending again cannot create a second transaction.
  return {e.status, "rebroadcast"};
}

Effect verify_effect(const EffectIntent& in, int receipt_status, const std::vector<Log>& logs, const std::optional<std::string>& allowance_after) {
  const Effect mismatch{"mismatch", std::nullopt};
  if (receipt_status != 1) return mismatch;
  std::string wallet = lower(in.wallet), pool = lower(in.pool);
  if (in.action == "approve") {
    auto a = allowance_after ? U256::from_dec(*allowance_after) : std::nullopt;
    bool ok = a && !(*a < U256::from_u128(static_cast<u128>(std::max<i128>(in.limit_atoms, 0))));
    return ok ? Effect{"confirmed", std::nullopt} : mismatch;
  }
  if (!in.claim) return mismatch;
  auto mask = U256::from_dec(in.claim->mask);
  if (!mask) return mismatch;
  for (const auto& log : logs) {
    if (lower(log.address) != pool) continue;
    auto e = decode_pool_log(log);
    if (!e || e->scope != in.claim->scope || !(e->mask == *mask) || static_cast<i128>(e->quantity) != in.quantity_atoms) continue;
    i128 amount = static_cast<i128>(e->collateral_amount);
    if (e->event == "Traded" && e->who == wallet) {
      if (in.action == "buy" && e->is_buy && amount <= in.limit_atoms) return {"confirmed", amount};
      if (in.action == "sell" && !e->is_buy && amount >= in.limit_atoms) return {"confirmed", amount};
    }
    if (e->event == "Redeemed" && in.action == "redeem" && e->who == wallet) return {"confirmed", amount};
  }
  return mismatch;
}

}  // namespace flurbo
