// The autonomous pipeline, offline and deterministic: research -> validated forecast -> strategy ->
// deterministic policy -> the transaction that would be signed. No network, no keys, no signer. The
// forecaster is a FIXTURE (a fixed reply), not AI; ai_agent.cpp uses a real model provider.
//
//   build/offline_pipeline
#include <cstdio>

#include "flurbo/runtime.hpp"

using namespace flurbo;

int main() {
  const int64_t now = 1790500010;
  const std::string pool = "0x00000000000000000000000000000000f1c7a0e0";
  std::vector<PromptEvent> events = {{0, "Will project A ship 1.0? (fixture)", "YES if released.", "NO otherwise.", 1791000000},
                                     {1, "Will project B ship 2.0? (fixture)", "YES if released.", "NO otherwise.", 1791000000}};
  Evidence e;
  e.id = "src-1";
  e.url = "https://example.org/fixture-release-notes";
  e.title = "Fixture release notes";
  e.publisher = "example.org";
  e.publisher_released_at = now - 3600;
  e.schema = EVIDENCE_SCHEMA; e.requested_url = e.url; e.final_url = e.url; e.complete_document = true; e.event_ids = {0, 1};
  e.content_sha256 = std::string(64, '0');
  e.excerpt = "Both release branches were tagged on the same day (fixture text).";
  e.captured_bytes = static_cast<int64_t>(e.excerpt.size()); e.content_sha256 = sha256_hex(e.excerpt);
  std::string reply = R"({"schema":"flurbo.agent-model-forecast.v1","abstain":false,"abstainReason":null,"events":[0,1],"statesPpm":[250000,100000,100000,550000],)"
                      R"("evidenceIds":["src-1"],"assumptions":["The two releases share a dependency."],"uncertainty":"A late fix could split them.",)"
                      R"("explanation":"Fixture reasoning: both branches were tagged together, so both releases are likely and linked."})";
  Researcher researcher(std::make_shared<FixtureRetriever>(std::vector<Evidence>{e}), FixtureForecaster::fixed(reply, "offline-fixture (not AI)"), 14 * 86400, 2, 10);
  ResearchResult found = researcher.research(pool, "Fixture market", events, {}, now);
  if (!found.ok) {
    std::printf("Abstained: %s\n", found.reason.c_str());
    return 0;
  }
  std::string states;
  for (i128 p : found.output.states_ppm) states += (states.empty() ? "" : ", ") + to_string(p);
  std::printf("Forecast source: %s %s; joint ppm [%s]\n", found.provenance->kind.c_str(), found.provenance->name.c_str(), states.c_str());

  // Fixture quotes stand in for pool.quoteBuy: an independent 50/50 market price plus a small spread.
  QuoteFn quote = [&](const std::vector<std::pair<unsigned, unsigned>>& claims, i128 quantity) {
    std::map<std::string, Quote> out;
    for (const auto& [scope, mask] : claims)
      out[claim_key(10143, pool, scope, mask)] = {quantity * __builtin_popcount(mask) / (i128{1} << __builtin_popcount(scope)) + 20000, now + 50, "0x" + std::string(64, 'f')};
    return out;
  };
  json::Value config = parse_config(default_config());
  StrategyMarket market{pool, 2, true, false, 1790900000, "0x" + std::string(64, 'f')};
  JointForecast forecast{found.output.events, found.output.states_ppm, found.fresh_evidence};
  JointEdgeStrategy strategy(JointEdgeStrategy::config_of(config));
  StrategyDecision decision = strategy.decide({market, forecast, now, quote});
  std::printf("Decision: %s. %s\n", decision.outcome.c_str(), decision.explanation.c_str());
  if (!decision.proposal) return 0;
  const auto& p = *decision.proposal;
  i128 limit = buy_limit(p.quote_atoms, p.slippage_bps);
  std::string ns = "practice-" + pool.substr(2);
  PolicyInput in;
  in.policy = Policy::from_json(config["policy"]);
  in.policy.markets = {ns};
  in.now = now;
  in.market = {ns, pool, 2, 1790900000, true, false};
  in.native_balance_wei = static_cast<i128>(1'000'000'000'000'000'000LL);
  in.candidate = {"buy", ns, ClaimRef::of(p.scope, p.mask), p.quantity_atoms, limit, static_cast<int64_t>(p.slippage_bps), now - 5, 250000, 100'000'000'000};
  auto violations = evaluate_policy(in);
  std::string verdict = "passes";
  if (!violations.empty()) {
    verdict = "rejected (";
    for (size_t i = 0; i < violations.size(); ++i) verdict += (i ? ", " : "") + violations[i];
    verdict += ")";
  }
  std::printf("Policy: %s\n", verdict.c_str());
  Deployment d;
  d.namespace_ = ns;
  d.pool = pool;
  d.closes_at = 1790900000;
  d.event_count = 2;
  UnsignedCall tx = build_transaction(Intent::buy({p.scope, p.mask}, p.quantity_atoms, limit, static_cast<uint64_t>(now + 300)), d, "0x" + std::string(40, '1'));
  std::printf("Would sign: buy %s atoms of claim %u/%u, paying at most %s atoms, calldata %s... (offline: nothing signed)\n", to_string(p.quantity_atoms).c_str(), p.scope,
              p.mask, to_string(limit).c_str(), tx.data.substr(0, 18).c_str());
}
