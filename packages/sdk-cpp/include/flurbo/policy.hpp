// Deterministic execution policy, recovery steps and receipt effects (protocol/specs/transactions.md).
// Software checks in a compliant runtime: they bound what this runtime does, not what the wallet key can do.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "flurbo/core.hpp"

namespace flurbo {

extern const char* const VIOLATIONS[18];
bool unfinished(const std::string& status);
bool final_status(const std::string& status);

struct Window {
  int64_t seconds = 0;
  i128 atoms = 0;
  json::Value to_json() const;
};

struct Policy {
  std::vector<std::string> markets;
  i128 max_quantity_atoms = 0, max_trade_cost_atoms = 0;
  int64_t max_slippage_bps = 0;
  i128 total_atoms = 0;
  std::vector<Window> windows;
  i128 max_position_atoms = 0, max_worst_case_loss_atoms = 0;
  i128 max_fee_wei = 0, reserve_wei = 0;
  int64_t quote_max_age_seconds = 0, min_seconds_before_close = 0;
  size_t max_pending = 0;
  bool allow_sell = false, allow_redeem = false;
  static Policy from_json(const json::Value& v);
  json::Value to_json() const;
};

struct PolicyMarket {
  std::string namespace_, pool;
  unsigned event_count = 0;
  int64_t closes_at = 0;
  bool open = false, resolved = false;
};

struct Holding {
  ClaimRef claim;
  i128 quantity_atoms = 0;
};

// The fields of a journal entry the policy reads.
struct PolicyEntry {
  std::string id, action, namespace_, status;
  std::optional<ClaimRef> claim;
  i128 quantity_atoms = 0, limit_atoms = 0;
  std::optional<i128> cost_atoms;
  int64_t planned_at = 0;
  static PolicyEntry from_json(const json::Value& v);
};

struct Candidate {
  std::string action, namespace_;
  ClaimRef claim;
  i128 quantity_atoms = 0, limit_atoms = 0;
  int64_t slippage_bps = 0, quote_block_timestamp = 0;
  i128 gas_limit = 0, max_fee_per_gas = 0;
};

struct PolicyInput {
  Policy policy;
  int64_t now = 0;
  PolicyMarket market;
  i128 native_balance_wei = 0;
  std::vector<Holding> holdings;
  std::vector<PolicyEntry> journal;
  Candidate candidate;
  static PolicyInput from_json(const json::Value& v);
};

i128 spend_of(const PolicyEntry& e);
i128 worst_case_loss(const PolicyInput& in);
// Violations in the protocol's fixed order; empty means the candidate passes.
std::vector<std::string> evaluate_policy(const PolicyInput& in);

struct FlurboPolicy {
  int64_t version = 0;
  bool paused = false, live_enabled = false;
  std::optional<i128> max_trade_cost_atoms;
  std::vector<Window> windows;
  static FlurboPolicy from_json(const json::Value& v);
};
struct LocalPolicy {
  std::string mode;
  i128 max_trade_cost_atoms = 0;
  std::vector<Window> windows;
};
struct EffectivePolicy {
  i128 max_trade_cost_atoms = 0;
  std::vector<Window> windows;
  bool live_allowed = false;
  std::optional<std::string> reason;
  json::Value to_json() const;
};
// Flurbo's published policy tightens the local configuration; it never loosens it.
EffectivePolicy effective_policy(const LocalPolicy& local, const std::optional<FlurboPolicy>& flurbo, std::optional<int64_t> read_at, int64_t now, int64_t max_age);

// ---- recovery ----
struct RecoveryEntry {
  std::string status;
  std::optional<uint64_t> nonce;
  std::optional<int64_t> deadline;
};
struct ChainView {
  bool tx_found = false;
  std::optional<int> receipt_status;
  uint64_t nonce_latest = 0;
};
struct Step {
  std::string status, action;
};
// One pure recovery step: the caller supplies what the chain shows.
Step recovery_step(const RecoveryEntry& e, const ChainView& chain, int64_t now);

// ---- effects ----
struct EffectIntent {
  std::string action, wallet, pool;
  std::optional<ClaimRef> claim;
  i128 quantity_atoms = 0, limit_atoms = 0;
};
struct Effect {
  std::string status;  // confirmed or mismatch
  std::optional<i128> collateral_atoms;
};
// Whether a mined receipt shows exactly the reported intent.
Effect verify_effect(const EffectIntent& in, int receipt_status, const std::vector<Log>& logs, const std::optional<std::string>& allowance_after);

}  // namespace flurbo
