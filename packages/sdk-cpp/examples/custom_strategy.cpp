// Replacing the reference strategy and research without changing the SDK. The runner accepts any `Strategy`
// (id, version, decide) or `Forecaster` (kind, name, complete); policy checks, signing, the journal and
// recovery stay the SDK's.
//
//   build/custom_strategy flurbo-agent.json [--once]
//
// This strategy only trades relationships: it ignores single-event claims, requires the forecast to say the
// two events are related, and buys the combination with the largest edge per unit of worst-case cost.
#include <cstdio>

#include "flurbo/runtime.hpp"

using namespace flurbo;

class RelationshipOnly : public Strategy {
 public:
  std::string id() const override { return "relationship-only"; }
  std::string version() const override { return "1.0.0"; }
  StrategyDecision decide(const StrategyContext& ctx) override {
    const auto& m = ctx.market;
    const auto& f = ctx.forecast;
    unsigned a = f.events[0], b = f.events[1];
    i128 p_a = marginal(f.events, f.states_ppm, a), p_b = marginal(f.events, f.states_ppm, b), p_ab = f.states_ppm[3];
    i128 gap = p_ab - p_a * p_b / PPM;
    if ((gap < 0 ? -gap : gap) < 50000) return StrategyDecision::abstain("no_relationship_edge", "The forecast treats the events as nearly independent.");
    std::vector<std::pair<unsigned, unsigned>> claims;
    auto leg = [](unsigned e, bool yes) { return Leg{static_cast<int64_t>(e), yes}; };
    for (bool ya : {true, false})
      for (bool yb : {true, false}) claims.push_back(encode_claim(m.event_count, {leg(a, ya), leg(b, yb)}, "AND"));
    for (const char* rule : {"OR", "EXACTLY_ONE"}) claims.push_back(encode_claim(m.event_count, {leg(a, true), leg(b, true)}, rule));
    const i128 quantity = 1'000'000;
    auto quotes = ctx.quote(claims, quantity);
    std::optional<StrategyProposal> best;
    for (const auto& [scope, mask] : claims) {
      auto q = quotes.find(claim_key(10143, m.pool, scope, mask));
      if (q == quotes.end()) continue;
      i128 worst = buy_limit(q->second.amount_atoms, 50);
      i128 edge = quantity * claim_probability(f.events, f.states_ppm, scope, mask) / PPM - worst;
      i128 score = edge * 10000 / worst;
      if (edge > 20000 && score >= 1000 && worst <= 1500000 && (!best || score > *best->edge_bps))
        best = StrategyProposal{scope, mask, quantity, q->second.amount_atoms, 50, edge, score};
    }
    if (!best) return StrategyDecision::abstain("edge_below_threshold", "No combination clears 10% edge per unit of worst-case cost.");
    return {"propose", {}, "Relationship trade: edge " + to_string(*best->edge_atoms) + " atoms, " + to_string(*best->edge_bps) + " bps of worst-case cost.", best};
  }
};

// Custom research (not a language model): keyword rules over the retrieved text. Labelled custom, never AI.
class KeywordResearch : public Forecaster {
 public:
  std::string kind() const override { return "custom"; }
  std::string name() const override { return "keyword-rules"; }
  std::string complete(const Prompt& prompt) override {
    std::string text = lower(prompt.user);
    auto ids = prompt_evidence_ids(prompt.user);
    int64_t tagged = 0;
    for (const char* w : {"tagged", "released", "published"})
      for (size_t at = text.find(w); at != std::string::npos; at = text.find(w, at + 1)) ++tagged;
    bool together = text.find("same day") != std::string::npos || text.find("together") != std::string::npos || text.find("shared") != std::string::npos;
    int64_t p_both = std::min<int64_t>(800000, 300000 + tagged * 100000 + (together ? 150000 : 0)), p_one = (1000000 - p_both) / 3;
    json::Value out = json::Value::object(), evidence = json::Value::array(), states = json::Value::array();
    for (size_t i = 0; i < ids.size() && i < 3; ++i) evidence.push(ids[i]);
    for (int64_t p : {1000000 - p_both - 2 * p_one, p_one, p_one, p_both}) states.push(p);
    out.set("schema", MODEL_SCHEMA);
    out.set("abstain", ids.empty());
    out.set("abstainReason", ids.empty() ? json::Value("insufficient_evidence") : json::Value());
    out.set("events", json::Value(json::Array{json::Value(0), json::Value(1)}));
    out.set("statesPpm", states);
    out.set("evidenceIds", evidence);
    out.set("assumptions", json::Value(json::Array{json::Value("Keyword counts reflect release progress.")}));
    out.set("uncertainty", "Keyword rules ignore context.");
    out.set("explanation", "Rule-based: " + std::to_string(tagged) + " release keywords" + (together ? ", shared schedule" : "") + ".");
    return out.dump();
  }
};

int main(int argc, char** argv) {
  std::string path = "flurbo-agent.json";
  bool once = false;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--once") once = true;
    else path = a;
  }
  try {
    RunnerOptions o;
    o.strategy = std::make_shared<RelationshipOnly>();
    o.forecaster = std::make_shared<KeywordResearch>();
    AgentRunner(load_config(path), o).run(once);
    return 0;
  } catch (const Error& e) {
    std::fprintf(stderr, "%s: %s\n", e.code.c_str(), e.what());
    return 1;
  }
}
