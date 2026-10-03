// The protocol core (protocol/specs): exact integer amounts, canonical claims, ABI encoding, deployment
// validation and the only transactions a runtime may sign. No I/O. Amounts are 128-bit integers
// (GCC and Clang `__int128`); ABI words are 256-bit.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "flurbo/error.hpp"
#include "flurbo/json.hpp"

namespace flurbo {

using i128 = __int128;
using u128 = unsigned __int128;

std::string to_string(i128 v);
std::string to_string_u(u128 v);
// A canonical decimal integer (optional leading minus); throws invalid_input otherwise.
i128 parse_i128(const std::string& s);
// A JSON number or decimal string as i128.
i128 num(const json::Value& v);

// ---- 256-bit ABI words ----
struct U256 {
  std::array<uint8_t, 32> b{};
  static U256 from_u128(u128 v);
  static std::optional<U256> from_dec(const std::string& s);
  static std::optional<U256> from_hex(const std::string& s);
  unsigned bits() const;
  bool is_zero() const { return bits() == 0; }
  std::optional<u128> to_u128() const;
  std::string word_hex() const;
  std::string address() const;
  std::string dec() const;
  bool operator==(const U256& o) const { return b == o.b; }
  bool operator<(const U256& o) const { return b < o.b; }
  bool operator>(const U256& o) const { return o < *this; }
};

// ---- amounts (protocol/specs/numbers.md) ----
constexpr i128 PPM = 1'000'000;
u128 parse_atoms(const std::string& value, const std::string& label = "amount");
i128 parse_decimal(const std::string& value, unsigned decimals);
i128 percent_to_ppm(const std::string& text);
i128 ceil_div(i128 a, i128 b);
inline i128 trunc_div(i128 a, i128 b) { return a / b; }
inline i128 buy_limit(i128 quote, i128 bps) { return (quote * (10'000 + bps) + 9'999) / 10'000; }
inline i128 sell_minimum(i128 quote, i128 bps) { return quote * (10'000 - bps) / 10'000; }
std::pair<i128, i128> frechet_bounds(i128 p_a, i128 p_b);
// Two events from marginals and their joint. Contradictory input is rejected, never repaired.
std::pair<std::vector<unsigned>, std::vector<i128>> joint_from_pair(unsigned a, unsigned b, i128 p_a, i128 p_b, i128 p_both);

// ---- claims, flurbo.claim.v1 (protocol/specs/claims.md) ----
struct Leg {
  int64_t event;
  bool yes;
};
struct ClaimRef {  // as in JSON: the mask is a decimal string
  unsigned scope = 0;
  std::string mask;
  unsigned mask_u() const;
  json::Value to_json() const;
  static ClaimRef of(unsigned scope, unsigned mask) { return {scope, std::to_string(mask)}; }
  static ClaimRef from_json(const json::Value& v);
  bool operator==(const ClaimRef& o) const { return scope == o.scope && mask == o.mask; }
};
extern const char* const CLAIM_RULES[4];
bool rule_matches(const std::string& rule, const std::vector<bool>& matches);
std::vector<unsigned> validate_claim(int64_t scope, const std::string& mask, int64_t events);
bool claim_valid(int64_t scope, const std::string& mask, int64_t events);
std::pair<unsigned, unsigned> encode_claim(int64_t events, std::vector<Leg> legs, const std::string& rule);
// The named rule that encodes to exactly this mask, or nothing. Masks are never rewritten.
std::optional<std::pair<std::string, std::vector<Leg>>> decode_claim(int64_t scope, const std::string& mask, int64_t events);
std::string claim_key(uint64_t chain_id, const std::string& pool, unsigned scope, unsigned mask);
std::vector<unsigned> scope_events(unsigned scope);
bool pays_in(unsigned scope, unsigned mask, unsigned state);
std::pair<uint64_t, uint64_t> payout_fraction(unsigned scope, unsigned mask, unsigned event_count, unsigned yes_mask, unsigned void_mask);
i128 claim_probability(const std::vector<unsigned>& joint_events, const std::vector<i128>& states, unsigned scope, unsigned mask);
bool covers(const std::vector<unsigned>& joint_events, unsigned scope);
i128 marginal(const std::vector<unsigned>& joint_events, const std::vector<i128>& states, unsigned event);

// ---- ABI (protocol/specs/contracts.md) ----
extern const std::vector<std::pair<std::string, std::string>> SELECTORS;
extern const char* const TOPIC_TRADED;
extern const char* const TOPIC_REDEEMED;
std::optional<std::string> selector(const std::string& name);
struct Arg {  // a number, a canonical decimal string, an address or a boolean
  enum class Kind { Uint, Text, Bool } kind;
  U256 uint;
  std::string text;
  bool flag = false;
  Arg(U256 v) : kind(Kind::Uint), uint(v) {}
  Arg(u128 v) : kind(Kind::Uint), uint(U256::from_u128(v)) {}
  Arg(uint64_t v) : Arg(static_cast<u128>(v)) {}
  Arg(unsigned v) : Arg(static_cast<u128>(v)) {}
  Arg(int v) : Arg(static_cast<u128>(v)) {}
  Arg(std::string s) : kind(Kind::Text), text(std::move(s)) {}
  Arg(const char* s) : kind(Kind::Text), text(s) {}
  static Arg boolean(bool b) {
    Arg a(0u);
    a.kind = Kind::Bool;
    a.flag = b;
    return a;
  }
};
bool is_address(const std::string& s);
std::string encode_call(const std::string& name, const std::vector<Arg>& args);
std::pair<std::string, std::vector<U256>> decode_call(const std::string& data);
std::vector<U256> decode_words(const std::string& data, size_t count);
struct Log {
  std::string address;
  std::vector<std::string> topics;
  std::string data;
  static Log from_json(const json::Value& v);
};
struct PoolEvent {
  std::string event;  // Traded or Redeemed
  std::string address, who;  // who: trader or owner
  unsigned scope = 0;
  U256 mask;
  bool is_buy = false;
  u128 quantity = 0, collateral_amount = 0;
};
std::optional<PoolEvent> decode_pool_log(const Log& log);

// ---- protocol version 1 ----
constexpr const char* PROTOCOL_VERSION = "1";
constexpr const char* PROTOCOL_HEADER = "Flurbo-Agent-Protocol";
constexpr const char* RUNTIME_API_BASE = "/api/agent-runtime/v1";
constexpr uint64_t CHAIN_ID = 10143;
constexpr const char* COLLATERAL = "0xa9012a055bd4e0edff8ce09f960291c09d5322dc";
constexpr i128 SERVICE_MAX_ATOMS = 100'000'000;
extern const char* const STOP_CODES[6];
struct Deployment {
  std::string namespace_, pool, resolver, pool_code_hash, resolver_code_hash, rules_hash;
  uint64_t chain_id = CHAIN_ID;
  uint64_t closes_at = 0;
  unsigned event_count = 0;
};
// Validates a flurbo.agent-deployment.v1 record. Limits looser than the protocol's are refused.
Deployment parse_deployment(const json::Value& d);

// ---- transactions ----
struct Claim {
  unsigned scope = 0, mask = 0;
};
struct Intent {
  std::string action;  // approve, buy, sell or redeem
  Claim claim;
  i128 quantity_atoms = 0, limit_atoms = 0;  // approve: limit_atoms is the amount
  uint64_t deadline = 0;
  static Intent approve(i128 amount) { return {"approve", {}, 0, amount, 0}; }
  static Intent buy(Claim c, i128 q, i128 limit, uint64_t deadline) { return {"buy", c, q, limit, deadline}; }
  static Intent sell(Claim c, i128 q, i128 limit, uint64_t deadline) { return {"sell", c, q, limit, deadline}; }
  static Intent redeem(Claim c, i128 q) { return {"redeem", c, q, 0, 0}; }
};
struct UnsignedCall {
  uint64_t chain_id = CHAIN_ID;
  std::string from, to, data;
  u128 value = 0;
};
UnsignedCall build_transaction(const Intent& intent, const Deployment& d, const std::string& wallet);
// Validated on the final bytes before signing: chain, contract, token, method, amounts and beneficiary.
void validate_transaction(const UnsignedCall& tx, const Intent& intent, const Deployment& d, const std::string& wallet);

// ---- helpers ----
std::string lower(std::string s);
bool is_lower_hex(const std::string& s, size_t digits);
// UTF-16 length and prefix, as the TypeScript reference counts text.
size_t js_len(const std::string& s);
std::string js_slice(const std::string& s, size_t units);
std::string trim(const std::string& s);
std::string iso(int64_t seconds);
std::optional<int64_t> parse_http_date(const std::string& s);
int64_t now_seconds();
int64_t now_millis();

}  // namespace flurbo
