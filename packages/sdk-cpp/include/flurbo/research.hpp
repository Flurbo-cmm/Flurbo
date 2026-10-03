// Research (protocol/specs/research.md) and the reference strategy joint-edge v1. Retrieved text is untrusted
// data; model output is validated and never repaired. Expected value assumes no VOID outcome and excludes
// gas; edge is a model estimate, not a promised profit.
#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "flurbo/core.hpp"

namespace flurbo {

constexpr const char* MODEL_SCHEMA = "flurbo.agent-model-forecast.v1";
constexpr const char* EVIDENCE_SCHEMA = "flurbo.agent-evidence.v2";
extern const char* const MODEL_ABSTAIN_REASONS[5];

struct Evidence {
  std::string id, url;
  std::optional<std::string> title, publisher;
  int64_t retrieved_at = 0;
  std::optional<int64_t> publisher_released_at, http_last_modified;
  std::string content_sha256, excerpt;
  std::string schema, requested_url, final_url;
  bool complete_document = false, valid_fields = true;
  int64_t captured_bytes = 0;
  std::vector<unsigned> event_ids;
  static Evidence from_json(const json::Value& v);
};

struct PromptEvent {
  unsigned index = 0;
  std::string question, yes_rule, no_rule;
  int64_t observation_ends_at = 0;
  static PromptEvent from_json(const json::Value& v);
};

struct ModelOutput {
  std::vector<unsigned> events;
  std::vector<i128> states_ppm;
  std::vector<std::string> evidence_ids, assumptions;
  std::string uncertainty, explanation;
};

struct Validation {
  bool ok = false;
  ModelOutput output;
  std::string reason;        // when not ok
  std::string model_reason;  // when the model itself abstained
};

struct ValidationContext {
  std::vector<unsigned> requested_events;
  std::vector<Evidence> evidence;
  int64_t now = 0;
  int64_t max_evidence_age_seconds = 0;
  unsigned event_count = 4;
  json::Value evidence_requirements;
};

Validation validate_model_output(const std::string& reply, const ValidationContext& ctx);
bool citable_evidence(const Evidence& e, int64_t now, unsigned event_count);
std::string evidence_failure(const std::vector<Evidence>& cited, const ValidationContext& ctx);
std::optional<int64_t> evidence_observed_at(const Evidence& e, const std::vector<unsigned>& requested_events, const json::Value& requirements = json::Value());

struct Provenance {
  std::string kind, name;  // kind: model, fixture or custom
  json::Value to_json() const;
};

// A validated output as a flurbo.agent-forecast.v1 document. Evidence comes from retrieval records.
json::Value forecast_from_model(const ModelOutput& o, const std::string& pool, const std::vector<Evidence>& evidence, const Provenance& p, int64_t now,
                                const json::Value& requirements = json::Value());

struct Prompt {
  std::string system, user;
};
// Evidence text is escaped so it cannot close its own block. The model has no tools or wallet access.
Prompt build_research_prompt(const std::string& title, const std::vector<PromptEvent>& events, const std::vector<Evidence>& evidence, int64_t now,
                            const json::Value& requirements = json::Value(), unsigned event_count = 4);
// Evidence ids cited in a prompt's user text, in order (for custom rule-based research).
std::vector<std::string> prompt_evidence_ids(const std::string& user);

// ---- joint-edge v1 ----
constexpr const char* STRATEGY_ID = "joint-edge";
constexpr const char* STRATEGY_VERSION = "1.0.0";

struct StrategyMarket {
  std::string pool;
  unsigned event_count = 0;
  bool open = false, resolved = false;
  int64_t closes_at = 0;
  std::string snapshot_block_hash;
};
struct JointForecast {
  std::vector<unsigned> events;
  std::vector<i128> states_ppm;
  unsigned fresh_evidence = 0;
};
struct StrategyConfig {
  i128 quantity_atoms = 0, slippage_bps = 0, min_edge_bps = 0, min_edge_atoms = 0, max_cost_atoms = 0;
  unsigned min_evidence = 0;
  bool include_singles = false;
};
struct Quote {
  i128 amount_atoms = 0;
  int64_t expires_at = 0;
  std::string block_hash;
};
struct Evaluation {
  unsigned scope = 0, mask = 0;
  i128 forecast_ppm = 0;
  std::string status;
  std::optional<i128> quote_atoms, worst_cost_atoms, expected_payout_atoms, edge_atoms, edge_bps;
};
struct Proposal {
  unsigned scope = 0, mask = 0;
  i128 quantity_atoms = 0, quote_atoms = 0, worst_cost_atoms = 0, expected_payout_atoms = 0, edge_atoms = 0, edge_bps = 0, slippage_bps = 0, forecast_ppm = 0;
};
struct Decision {
  std::string outcome;  // propose or abstain
  std::vector<std::string> reasons;
  std::optional<Proposal> proposal;
  std::vector<Evaluation> evaluations;
};

std::vector<std::pair<unsigned, unsigned>> candidate_claims(const std::string& pool, unsigned event_count, const std::vector<unsigned>& joint_events, bool include_singles);
// quotes: claim_key to quote, for the claims the pool quoted at this size.
Decision decide(const StrategyMarket& m, const JointForecast& f, const StrategyConfig& c, int64_t now, const std::map<std::string, Quote>& quotes);

}  // namespace flurbo
