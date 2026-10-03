// Conformance: the C++ SDK against the shared protocol fixtures (the same files every SDK runs).
#include <fstream>
#include <sstream>

#include "check.hpp"
#include "flurbo/core.hpp"
#include "flurbo/crypto.hpp"
#include "flurbo/policy.hpp"
#include "flurbo/research.hpp"
#include "flurbo/runtime.hpp"

using namespace flurbo;
using json::Value;

#ifndef FLURBO_FIXTURES
#define FLURBO_FIXTURES "../../protocol/fixtures"
#endif

static Value fixture(const std::string& name) {
  std::ifstream f(std::string(FLURBO_FIXTURES) + "/" + name + ".json", std::ios::binary);
  std::stringstream s;
  s << f.rdbuf();
  return json::parse(s.str());
}

static std::vector<Leg> legs(const Value& v) {
  std::vector<Leg> out;
  for (const auto& l : v.as_array()) out.push_back({l["event"].as_int(), l["yes"].as_bool()});
  return out;
}

static Value legs_json(const std::vector<Leg>& ls) {
  Value a = Value::array();
  for (const auto& l : ls) {
    Value o = Value::object();
    o.set("event", l.event);
    o.set("yes", l.yes);
    a.push(o);
  }
  return a;
}

static std::string s(i128 v) { return to_string(v); }

TEST(semantic_conformance) {
  auto f = fixture("semantics");
  Deployment d; d.pool=f["deployment"].str("pool"); d.rules_hash=f["deployment"].str("rulesHash"); d.event_count=2;
  for (const auto& c : f["cases"].as_array()) {
    const auto& claim=c["claim"];
    CHECK_EQ(semantic_error(c["result"], d, claim.integer("scope"), std::stoul(claim.str("mask")), claim.str("quantityAtoms"), f.integer("now")), c.str("error"));
  }
}

TEST(claims) {
  Value f = fixture("claims");
  for (const auto& c : f["encode"].as_array()) {
    auto [scope, mask] = encode_claim(c["events"].as_int(), legs(c["legs"]), c["rule"].as_string());
    CHECK_EQ(static_cast<int64_t>(scope), c["scope"].as_int());
    CHECK_EQ(std::to_string(mask), c["mask"].as_string());
  }
  for (const auto& c : f["invalidEncode"].as_array()) CHECK_THROWS(encode_claim(c["events"].as_int(), legs(c["legs"]), c["rule"].as_string()));
  for (const auto& c : f["validate"].as_array()) CHECK_EQ(claim_valid(c["scope"].as_int(), c["mask"].as_string(), c["events"].as_int()), c["valid"].as_bool());
  for (const auto& c : f["decode"].as_array()) {
    auto named = decode_claim(c["scope"].as_int(), c["mask"].as_string(), c["events"].as_int());
    CHECK_EQ(named ? named->first : std::string("OTHER"), c["rule"].as_string());
    CHECK((named ? legs_json(named->second) : Value()) == c["legs"]);
  }
  for (const auto& k : f["keys"].as_array())
    CHECK_EQ(claim_key(static_cast<uint64_t>(k["chainId"].as_int()), k["pool"].as_string(), static_cast<unsigned>(k["scope"].as_int()), static_cast<unsigned>(num(k["mask"]))),
             k["key"].as_string());
  for (const auto& p : f["payouts"].as_array()) {
    auto u = [&](const char* key) { return static_cast<unsigned>(num(p[key])); };
    auto [n, d] = payout_fraction(u("scope"), u("mask"), u("events"), u("yesMask"), u("voidMask"));
    CHECK_EQ(std::to_string(n), p["numerator"].as_string());
    CHECK_EQ(std::to_string(d), p["denominator"].as_string());
    CHECK_EQ(s(num(p["quantityAtoms"]) * static_cast<i128>(n) / static_cast<i128>(d)), p["payoutAtoms"].as_string());
  }
}

static Arg arg(const Value& v) {
  if (v.is_string()) return Arg(v.as_string());
  if (v.is_bool()) return Arg::boolean(v.as_bool());
  return Arg(static_cast<u128>(v.as_int()));
}

static U256 word_of(const Value& v) {
  if (v.is_string()) return v.as_string().rfind("0x", 0) == 0 ? *U256::from_hex(v.as_string()) : *U256::from_dec(v.as_string());
  return U256::from_u128(static_cast<u128>(v.as_int()));
}

static std::string message_of(const std::function<void()>& f) {
  try {
    f();
  } catch (const std::exception& e) {
    return e.what();
  }
  return "";
}

TEST(calldata_returns_and_events) {
  Value f = fixture("calldata");
  for (const auto& c : f["calls"].as_array()) {
    std::vector<Arg> args;
    for (const auto& a : c["args"].as_array()) args.push_back(arg(a));
    CHECK_EQ(encode_call(c["function"].as_string(), args), c["data"].as_string());
    auto [name, words] = decode_call(c["data"].as_string());
    CHECK_EQ(name, c["function"].as_string());
    CHECK_EQ(words.size(), c["args"].size());
    for (size_t i = 0; i < words.size(); ++i) CHECK(words[i] == word_of(c["args"][i]));
  }
  for (const auto& [name, sel] : f["selectors"].members()) CHECK_EQ(selector(name).value_or(""), sel.as_string());
  std::string first = f["calls"][0]["data"].as_string();
  CHECK(message_of([&] { decode_call(first + "00"); }).find("length") != std::string::npos);
  CHECK(message_of([&] { decode_call("0x3e6b6cde" + std::string(64, 'f') + first.substr(74)); }).find("Non-canonical") != std::string::npos);
  CHECK(message_of([&] { encode_call("buy", {Arg(3u), Arg(8u), Arg("340282366920938463463374607431768211456"), Arg(1u), Arg(1u)}); }).find("out of range") != std::string::npos);
  for (const auto& r : f["returns"].as_array()) {
    std::string fn = r["function"].as_string(), data = r["data"].as_string();
    if (fn == "payoutFraction") {
      auto w = decode_words(data, 2);
      CHECK_EQ(w[0].dec(), r["value"][0].as_string());
      CHECK_EQ(w[1].dec(), r["value"][1].as_string());
    } else if (fn == "resolved") {
      CHECK_EQ(!decode_words(data, 1)[0].is_zero(), r["value"].as_bool());
    } else {
      CHECK_EQ(decode_words(data, 1)[0].dec(), r["value"].as_string());
    }
  }
  for (const auto& e : f["events"].as_array()) {
    auto d = decode_pool_log(Log::from_json(e));
    CHECK(d.has_value());
    const Value& x = e["decoded"];
    CHECK_EQ(d->event, x["event"].as_string());
    CHECK_EQ(d->who, x.str(d->event == "Traded" ? "trader" : "owner"));
    CHECK_EQ(static_cast<int64_t>(d->scope), x["scope"].as_int());
    CHECK_EQ(d->mask.dec(), x["mask"].as_string());
    CHECK_EQ(to_string_u(d->quantity), x["quantity"].as_string());
    CHECK_EQ(to_string_u(d->collateral_amount), x["collateralAmount"].as_string());
    if (d->event == "Traded") CHECK_EQ(d->is_buy, x["isBuy"].as_bool());
  }
}

TEST(amounts) {
  Value f = fixture("amounts");
  for (const auto& p : f["parse"].as_array()) {
    bool ok = message_of([&] { parse_atoms(p["text"].as_string()); }).empty();
    CHECK_EQ(ok, p["valid"].as_bool());
  }
  for (const auto& l : f["limits"].as_array()) {
    CHECK_EQ(s(buy_limit(num(l["quoteAtoms"]), num(l["slippageBps"]))), l["buyLimitAtoms"].as_string());
    CHECK_EQ(s(sell_minimum(num(l["quoteAtoms"]), num(l["slippageBps"]))), l["sellMinimumAtoms"].as_string());
  }
  for (const auto& e : f["edges"].as_array()) {
    i128 worst = buy_limit(num(e["quoteAtoms"]), num(e["slippageBps"]));
    i128 expected = num(e["quantityAtoms"]) * num(e["claimPpm"]) / PPM;
    i128 edge = expected - worst;
    CHECK_EQ(s(worst), e["worstCostAtoms"].as_string());
    CHECK_EQ(s(expected), e["expectedPayoutAtoms"].as_string());
    CHECK_EQ(s(edge), e["edgeAtoms"].as_string());
    CHECK_EQ(s(trunc_div(edge * 10'000, worst)), e["edgeBps"].as_string());
  }
  for (const auto& p : f["percent"].as_array()) {
    std::string got;
    try {
      got = s(percent_to_ppm(p["text"].as_string()));
    } catch (const Error&) {
      got = "null";
    }
    CHECK_EQ(got, p["ppm"].is_null() ? std::string("null") : p["ppm"].as_string());
  }
  for (const auto& c : f["frechet"].as_array()) {
    auto [low, high] = frechet_bounds(num(c["pA"]), num(c["pB"]));
    CHECK_EQ(s(low), c["lowPpm"].as_string());
    CHECK_EQ(s(high), c["highPpm"].as_string());
    bool valid = true;
    std::vector<i128> states;
    try {
      states = joint_from_pair(0, 1, num(c["pA"]), num(c["pB"]), num(c["pBoth"])).second;
    } catch (const Error&) {
      valid = false;
    }
    CHECK_EQ(valid, c["valid"].as_bool());
    for (size_t i = 0; valid && i < states.size(); ++i) CHECK_EQ(s(states[i]), c["statesPpm"][i].as_string());
  }
}

static Value strings(const std::vector<std::string>& v) {
  Value a = Value::array();
  for (const auto& x : v) a.push(x);
  return a;
}

TEST(policy) {
  Value f = fixture("policy");
  for (const auto& c : f["cases"].as_array()) {
    Value got = strings(evaluate_policy(PolicyInput::from_json(c["input"])));
    if (got != c["expect"]) check::fail(__FILE__, __LINE__, c.str("name") + ": " + got.dump());
  }
  for (const auto& e : f["effective"].as_array()) {
    const Value& l = e["local"];
    LocalPolicy local{l.str("mode"), num(l["maxTradeCostAtoms"]), {}};
    for (const auto& w : l["spend"]["windows"].as_array()) local.windows.push_back({w["seconds"].as_int(), num(w["atoms"])});
    std::optional<FlurboPolicy> flurbo;
    if (!e["flurbo"].is_null()) flurbo = FlurboPolicy::from_json(e["flurbo"]);
    std::optional<int64_t> read_at;
    if (!e["readAt"].is_null()) read_at = e["readAt"].as_int();
    Value got = effective_policy(local, flurbo, read_at, e["now"].as_int(), e["policyMaxAgeSeconds"].as_int()).to_json();
    if (got != e["expect"]) check::fail(__FILE__, __LINE__, e.str("name") + ": " + got.dump());
  }
}

TEST(recovery_and_effects) {
  Value f = fixture("recovery");
  for (const auto& t : f["transitions"].as_array()) {
    const Value& e = t["entry"];
    const Value& c = t["chain"];
    RecoveryEntry entry{e.str("status"), std::nullopt, std::nullopt};
    if (e["nonce"].is_integer()) entry.nonce = static_cast<uint64_t>(e["nonce"].as_int());
    if (e["deadline"].is_integer()) entry.deadline = e["deadline"].as_int();
    ChainView chain{c["txFound"].as_bool(), std::nullopt, static_cast<uint64_t>(c["nonceLatest"].as_int())};
    if (c["receiptStatus"].is_integer()) chain.receipt_status = static_cast<int>(c["receiptStatus"].as_int());
    Step step = recovery_step(entry, chain, t["now"].as_int());
    if (step.status != t["expect"].str("status") || step.action != t["expect"].str("action")) check::fail(__FILE__, __LINE__, t.str("name"));
  }
  for (const auto& e : f["effects"].as_array()) {
    const Value& i = e["intent"];
    EffectIntent intent{i.str("action"), i.str("wallet"), i.str("pool"), std::nullopt, num(i["quantityAtoms"]), num(i["limitAtoms"])};
    if (i["claim"].is_object()) intent.claim = ClaimRef::from_json(i["claim"]);
    std::vector<Log> logs;
    for (const auto& l : e["receipt"]["logs"].as_array()) logs.push_back(Log::from_json(l));
    std::optional<std::string> allowance;
    if (e["allowanceAfterAtoms"].is_string()) allowance = e["allowanceAfterAtoms"].as_string();
    Effect got = verify_effect(intent, static_cast<int>(e["receipt"]["status"].as_int()), logs, allowance);
    Value g = Value::object();
    g.set("status", got.status);
    if (got.status == "confirmed") g.set("collateralAtoms", got.collateral_atoms ? Value(s(*got.collateral_atoms)) : Value());
    if (g != e["expect"]) check::fail(__FILE__, __LINE__, e.str("name") + ": " + g.dump());
  }
}

TEST(research) {
  Value f = fixture("research");
  for (const auto& k : f["cases"].as_array()) {
    Value c = f["context"];
    if (k["context"].is_object()) for (const auto& [key, value] : k["context"].members()) c.set(key, value);
    ValidationContext ctx;
    for (const auto& x : c["requestedEvents"].as_array()) ctx.requested_events.push_back(static_cast<unsigned>(x.as_int()));
    for (const auto& x : c["evidence"].as_array()) ctx.evidence.push_back(Evidence::from_json(x));
    ctx.now = c["now"].as_int(); ctx.max_evidence_age_seconds = c["maxEvidenceAgeSeconds"].as_int();
    ctx.event_count = static_cast<unsigned>(c["eventCount"].as_int()); ctx.evidence_requirements = c["evidenceRequirements"];
    Validation v = validate_model_output(k["output"].as_string(), ctx);
    Value got = Value::object();
    if (v.ok) {
      Value states = Value::array();
      for (i128 p : v.output.states_ppm) states.push(static_cast<int64_t>(p));
      got.set("status", "ok");
      got.set("statesPpm", states);
      got.set("evidenceIds", strings(v.output.evidence_ids));
    } else {
      got.set("status", "abstain");
      got.set("reason", v.reason);
      if (!v.model_reason.empty()) got.set("modelReason", v.model_reason);
    }
    if (got != k["expect"]) check::fail(__FILE__, __LINE__, k.str("name") + ": " + got.dump());
  }
}

TEST(strategy) {
  Value f = fixture("strategy");
  for (const auto& c : f["cases"].as_array()) {
    const Value &m = c["market"], &fc = c["forecast"], &cfg = c["config"], &x = c["expect"];
    StrategyMarket market{m.str("pool"), static_cast<unsigned>(m["eventCount"].as_int()), m["open"].as_bool(), m["resolved"].as_bool(), m["closesAt"].as_int(),
                          m.str("snapshotBlockHash")};
    StrategyConfig config{num(cfg["quantityAtoms"]), num(cfg["slippageBps"]), num(cfg["minEdgeBps"]), num(cfg["minEdgeAtoms"]), num(cfg["maxCostAtoms"]),
                          static_cast<unsigned>(cfg["minEvidence"].as_int()), cfg["includeSingles"].as_bool()};
    JointForecast forecast;
    for (const auto& e : fc["events"].as_array()) forecast.events.push_back(static_cast<unsigned>(e.as_int()));
    for (const auto& p : fc["statesPpm"].as_array()) forecast.states_ppm.push_back(num(p));
    forecast.fresh_evidence = static_cast<unsigned>(fc["freshEvidence"].as_int());
    auto listed = candidate_claims(market.pool, market.event_count, forecast.events, config.include_singles);
    std::map<std::string, Quote> quotes;
    CHECK_EQ(listed.size(), c["candidates"].size());
    for (size_t i = 0; i < c["candidates"].size(); ++i) {
      const Value& q = c["candidates"][i];
      unsigned scope = static_cast<unsigned>(q["scope"].as_int()), mask = static_cast<unsigned>(num(q["mask"]));
      if (i < listed.size()) CHECK(listed[i] == std::make_pair(scope, mask));
      if (!q["amountAtoms"].is_null()) quotes[claim_key(10143, market.pool, scope, mask)] = {num(q["amountAtoms"]), q["expiresAt"].as_int(), market.snapshot_block_hash};
    }
    Decision d = decide(market, forecast, config, c["now"].as_int(), quotes);
    std::string name = c.str("name");
    if (d.outcome != x.str("outcome") || strings(d.reasons) != x["reasons"]) check::fail(__FILE__, __LINE__, name + ": outcome");
    if (d.proposal) {
      const auto& p = *d.proposal;
      Value claim = Value::object();
      claim.set("scope", static_cast<int64_t>(p.scope));
      claim.set("mask", std::to_string(p.mask));
      if (claim != x["claim"] || s(p.quote_atoms) != x.str("quoteAtoms") || s(p.worst_cost_atoms) != x.str("worstCostAtoms") ||
          s(p.expected_payout_atoms) != x.str("expectedPayoutAtoms") || s(p.edge_atoms) != x.str("edgeAtoms") || static_cast<int64_t>(p.edge_bps) != x["edgeBps"].as_int())
        check::fail(__FILE__, __LINE__, name + ": proposal");
    } else if (!x["claim"].is_null()) {
      check::fail(__FILE__, __LINE__, name + ": expected a proposal");
    }
    CHECK_EQ(d.evaluations.size(), x["evaluations"].size());
    for (size_t i = 0; i < d.evaluations.size() && i < x["evaluations"].size(); ++i) {
      const auto& e = d.evaluations[i];
      const Value& w = x["evaluations"][i];
      std::string edge = e.edge_atoms ? s(*e.edge_atoms) : "null";
      std::string want = w["edgeAtoms"].is_null() ? "null" : w["edgeAtoms"].as_string();
      if (static_cast<int64_t>(e.scope) != w["scope"].as_int() || std::to_string(e.mask) != w.str("mask") || e.status != w.str("status") || edge != want)
        check::fail(__FILE__, __LINE__, name + ": evaluation " + std::to_string(i));
    }
  }
}

TEST(signing_matches_byte_for_byte) {
  Value f = fixture("calldata");
  for (const auto& sg : f["signing"].as_array()) {
    LocalKeySigner signer(sg["privateKey"].as_string());
    const Value& t = sg["transaction"];
    Tx1559 tx{static_cast<uint64_t>(t["chainId"].as_int()), static_cast<uint64_t>(t["nonce"].as_int()), t.str("to"), t.str("data"), 0,
              static_cast<u128>(num(t["gas"])), static_cast<u128>(num(t["maxFeePerGas"])), static_cast<u128>(num(t["maxPriorityFeePerGas"]))};
    CHECK_EQ(to_hex(unsigned_serialized(tx)), sg["unsignedSerialized"].as_string());
    std::string raw = signer.sign_transaction(tx);
    CHECK_EQ(raw, sg["raw"].as_string());
    CHECK_EQ(transaction_hash(raw), sg["hash"].as_string());
    CHECK_EQ(signer.address(), sg["address"].as_string());
  }
  for (const auto& m : f["messages"].as_array()) CHECK_EQ(LocalKeySigner(m["privateKey"].as_string()).sign_message(m["message"].as_string()), m["signature"].as_string());
  CHECK_THROWS(LocalKeySigner("0x1234"));
  CHECK_THROWS(LocalKeySigner("0x" + std::string(64, '0')));
}

TEST_MAIN
