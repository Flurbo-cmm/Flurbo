#include "flurbo/core.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <set>

namespace flurbo {

// ---- numbers ----
std::string to_string_u(u128 v) {
  if (v == 0) return "0";
  std::string s;
  while (v) {
    s += static_cast<char>('0' + static_cast<int>(v % 10));
    v /= 10;
  }
  return {s.rbegin(), s.rend()};
}

std::string to_string(i128 v) {
  if (v < 0) return "-" + to_string_u(static_cast<u128>(-(v + 1)) + 1);
  return to_string_u(static_cast<u128>(v));
}

static bool digits(const std::string& s) {
  return !s.empty() && std::all_of(s.begin(), s.end(), [](char c) { return c >= '0' && c <= '9'; });
}

i128 parse_i128(const std::string& text) {
  bool neg = !text.empty() && text[0] == '-';
  std::string d = neg ? text.substr(1) : text;
  if (!digits(d) || d.size() > 38 || (d.size() > 1 && d[0] == '0')) throw invalid("Invalid integer.");
  i128 v = 0;
  for (char c : d) v = v * 10 + (c - '0');
  return neg ? -v : v;
}

i128 num(const json::Value& v) {
  if (v.is_string()) return parse_i128(v.as_string());
  return v.as_int();
}

// ---- U256 ----
U256 U256::from_u128(u128 v) {
  U256 r;
  for (int i = 31; i >= 16; --i, v >>= 8) r.b[i] = static_cast<uint8_t>(v & 0xff);
  return r;
}

std::optional<U256> U256::from_dec(const std::string& s) {
  if (!digits(s) || (s.size() > 1 && s[0] == '0')) return std::nullopt;
  U256 r;
  for (char c : s) {
    unsigned carry = static_cast<unsigned>(c - '0');
    for (int i = 31; i >= 0; --i) {
      unsigned v = r.b[i] * 10u + carry;
      r.b[i] = static_cast<uint8_t>(v);
      carry = v >> 8;
    }
    if (carry) return std::nullopt;
  }
  return r;
}

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

std::optional<U256> U256::from_hex(const std::string& s) {
  std::string h = s.rfind("0x", 0) == 0 ? s.substr(2) : s;
  if (h.empty() || h.size() > 64) return std::nullopt;
  for (char c : h)
    if (hexval(c) < 0) return std::nullopt;
  h = std::string(64 - h.size(), '0') + h;
  U256 r;
  for (int i = 0; i < 32; ++i) r.b[i] = static_cast<uint8_t>(hexval(h[2 * i]) * 16 + hexval(h[2 * i + 1]));
  return r;
}

unsigned U256::bits() const {
  for (int i = 0; i < 32; ++i)
    if (b[i]) {
      unsigned lead = 0;
      for (int k = 7; k >= 0 && !(b[i] & (1 << k)); --k) ++lead;
      return (32 - i) * 8 - lead;
    }
  return 0;
}

std::optional<u128> U256::to_u128() const {
  if (bits() > 128) return std::nullopt;
  u128 v = 0;
  for (int i = 16; i < 32; ++i) v = (v << 8) | b[i];
  return v;
}

std::string U256::word_hex() const {
  static const char* hex = "0123456789abcdef";
  std::string s;
  for (auto x : b) {
    s += hex[x >> 4];
    s += hex[x & 15];
  }
  return s;
}

std::string U256::address() const { return "0x" + word_hex().substr(24); }

std::string U256::dec() const {
  std::array<uint8_t, 32> n = b;
  std::string out;
  while (std::any_of(n.begin(), n.end(), [](uint8_t x) { return x != 0; })) {
    unsigned rem = 0;
    for (auto& x : n) {
      unsigned v = (rem << 8) | x;
      x = static_cast<uint8_t>(v / 10);
      rem = v % 10;
    }
    out += static_cast<char>('0' + rem);
  }
  if (out.empty()) return "0";
  return {out.rbegin(), out.rend()};
}

// ---- amounts ----
u128 parse_atoms(const std::string& value, const std::string& label) {
  if (!digits(value) || value.size() > 39 || (value.size() > 1 && value[0] == '0')) throw invalid("Invalid " + label + ".");
  auto v = U256::from_dec(value);
  if (!v || v->bits() > 128) throw invalid("Invalid " + label + ".");
  return *v->to_u128();
}

i128 parse_decimal(const std::string& value, unsigned decimals) {
  std::string v = trim(value);
  auto dot = v.find('.');
  std::string whole = dot == std::string::npos ? v : v.substr(0, dot);
  bool has_fraction = dot != std::string::npos;
  std::string fraction = has_fraction ? v.substr(dot + 1) : "";
  bool whole_ok = digits(whole) && whole.size() <= 31 && (whole == "0" || whole[0] != '0');
  if (!whole_ok || (has_fraction && !digits(fraction))) throw invalid("Enter a positive decimal amount.");
  if (fraction.size() > decimals) throw invalid("At most " + std::to_string(decimals) + " decimal places are supported.");
  fraction += std::string(decimals - fraction.size(), '0');
  i128 scale = 1;
  for (unsigned k = 0; k < decimals; ++k) scale *= 10;
  return parse_i128(whole) * scale + (fraction.empty() ? 0 : parse_i128(std::to_string(std::stoll(fraction))));
}

i128 percent_to_ppm(const std::string& text) {
  i128 ppm = parse_decimal(text, 4);
  if (ppm > PPM) throw Error("invalid_forecast", "Percentages cannot exceed 100.");
  return ppm;
}

i128 ceil_div(i128 a, i128 b) {
  if (b <= 0 || a < 0) throw invalid("Invalid division.");
  return (a + b - 1) / b;
}

std::pair<i128, i128> frechet_bounds(i128 p_a, i128 p_b) {
  for (i128 p : {p_a, p_b})
    if (p < 0 || p > PPM) throw Error("invalid_forecast", "Probabilities must be between 0% and 100%.");
  return {std::max<i128>(0, p_a + p_b - PPM), std::min(p_a, p_b)};
}

std::pair<std::vector<unsigned>, std::vector<i128>> joint_from_pair(unsigned a, unsigned b, i128 p_a, i128 p_b, i128 p_both) {
  if (a == b) throw Error("invalid_forecast", "Choose two different events.");
  auto [low, high] = frechet_bounds(p_a, p_b);
  if (p_both < low || p_both > high) throw Error("invalid_forecast", "The chance of both is outside what the two chances allow.");
  unsigned first = a < b ? a : b, second = a < b ? b : a;
  i128 p_first = a < b ? p_a : p_b, p_second = a < b ? p_b : p_a;
  return {{first, second}, {PPM - p_first - p_second + p_both, p_first - p_both, p_second - p_both, p_both}};
}

// ---- claims ----
const char* const CLAIM_RULES[4] = {"AND", "OR", "EXACTLY_ONE", "AT_LEAST_TWO"};

static bool known_rule(const std::string& r) {
  return std::any_of(std::begin(CLAIM_RULES), std::end(CLAIM_RULES), [&](const char* x) { return r == x; });
}
static Error unsupported(const std::string& m) { return Error("unsupported_claim", m); }

unsigned ClaimRef::mask_u() const { return static_cast<unsigned>(std::stoul(mask)); }
json::Value ClaimRef::to_json() const {
  json::Value v = json::Value::object();
  v.set("scope", static_cast<int64_t>(scope));
  v.set("mask", mask);
  return v;
}
ClaimRef ClaimRef::from_json(const json::Value& v) { return {static_cast<unsigned>(v["scope"].as_int()), v["mask"].as_string()}; }

bool rule_matches(const std::string& rule, const std::vector<bool>& matches) {
  if (!known_rule(rule) || matches.empty()) throw unsupported("Unsupported payout rule.");
  size_t count = std::count(matches.begin(), matches.end(), true);
  if (rule == "AND") return count == matches.size();
  if (rule == "OR") return count > 0;
  if (rule == "EXACTLY_ONE") return count == 1;
  return count >= 2;
}

std::vector<unsigned> validate_claim(int64_t scope, const std::string& mask, int64_t events) {
  bool mask_ok = !mask.empty() && mask.size() <= 3 && mask[0] != '0' && digits(mask);
  if (events < 2 || events > 4 || !mask_ok) throw unsupported("Invalid claim.");
  if (scope <= 0 || scope >= 16) throw unsupported("Invalid claim scope.");
  std::vector<unsigned> legs;
  for (unsigned i = 0; i < 4; ++i)
    if (scope & (1 << i)) legs.push_back(i);
  uint64_t m = std::stoull(mask);
  if (scope >= (int64_t{1} << events) || legs.size() > 3 || m >= (uint64_t{1} << (1u << legs.size())) - 1) throw unsupported("Unsupported claim.");
  return legs;
}

bool claim_valid(int64_t scope, const std::string& mask, int64_t events) {
  try {
    validate_claim(scope, mask, events);
    return true;
  } catch (const Error&) {
    return false;
  }
}

std::pair<unsigned, unsigned> encode_claim(int64_t events, std::vector<Leg> legs, const std::string& rule) {
  if (legs.empty() || legs.size() > 3 || !known_rule(rule)) throw unsupported("Choose one to three answers.");
  std::stable_sort(legs.begin(), legs.end(), [](const Leg& a, const Leg& b) { return a.event < b.event; });
  for (size_t i = 0; i < legs.size(); ++i)
    if ((i && legs[i].event == legs[i - 1].event) || legs[i].event < 0 || legs[i].event >= events) throw unsupported("Invalid claim answers.");
  if (rule == "AT_LEAST_TWO" && legs.size() < 2) throw unsupported("Choose at least two answers.");
  unsigned scope = 0, mask = 0;
  for (const auto& l : legs) scope |= 1u << l.event;
  for (unsigned state = 0; state < (1u << legs.size()); ++state) {
    std::vector<bool> matches;
    for (size_t i = 0; i < legs.size(); ++i) matches.push_back(((state >> i) & 1u) == static_cast<unsigned>(legs[i].yes));
    if (rule_matches(rule, matches)) mask |= 1u << state;
  }
  validate_claim(scope, std::to_string(mask), events);
  return {scope, mask};
}

std::optional<std::pair<std::string, std::vector<Leg>>> decode_claim(int64_t scope, const std::string& mask, int64_t events) {
  auto selected = validate_claim(scope, mask, events);
  unsigned target = static_cast<unsigned>(std::stoul(mask));
  for (const char* rule : CLAIM_RULES) {
    if (std::string(rule) == "AT_LEAST_TWO" && selected.size() < 2) continue;
    for (int state = (1 << selected.size()) - 1; state >= 0; --state) {
      std::vector<Leg> legs;
      for (size_t i = 0; i < selected.size(); ++i) legs.push_back({selected[i], ((state >> i) & 1) != 0});
      if (encode_claim(events, legs, rule).second == target) return std::make_pair(std::string(rule), legs);
    }
  }
  return std::nullopt;
}

std::string lower(std::string s) {
  for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

std::string claim_key(uint64_t chain_id, const std::string& pool, unsigned scope, unsigned mask) {
  return std::to_string(chain_id) + ":" + lower(pool) + ":" + std::to_string(scope) + ":" + std::to_string(mask);
}

std::vector<unsigned> scope_events(unsigned scope) {
  std::vector<unsigned> out;
  for (unsigned i = 0; i < 31; ++i)
    if (scope & (1u << i)) out.push_back(i);
  return out;
}

bool pays_in(unsigned scope, unsigned mask, unsigned state) {
  unsigned local = 0, index = 0;
  for (unsigned e : scope_events(scope)) {
    if (state & (1u << e)) local |= 1u << index;
    ++index;
  }
  return local < 32 && (mask & (1u << local));
}

std::pair<uint64_t, uint64_t> payout_fraction(unsigned scope, unsigned mask, unsigned event_count, unsigned yes_mask, unsigned void_mask) {
  unsigned full = (1u << event_count) - 1;
  if ((yes_mask & void_mask) || yes_mask > full || void_mask > full) throw invalid("Invalid resolution.");
  unsigned known = full ^ void_mask;
  uint64_t n = 0, d = 0;
  for (unsigned state = 0; state <= full; ++state) {
    if ((state & known) != yes_mask) continue;
    ++d;
    if (pays_in(scope, mask, state)) ++n;
  }
  return {n, d};
}

static size_t position(const std::vector<unsigned>& events, unsigned e) {
  auto it = std::find(events.begin(), events.end(), e);
  if (it == events.end()) throw invalid("The joint forecast does not cover the claim.");
  return static_cast<size_t>(it - events.begin());
}

i128 claim_probability(const std::vector<unsigned>& joint_events, const std::vector<i128>& states, unsigned scope, unsigned mask) {
  std::vector<size_t> positions;
  for (unsigned e : scope_events(scope)) positions.push_back(position(joint_events, e));
  i128 total = 0;
  for (size_t s = 0; s < states.size(); ++s) {
    unsigned local = 0;
    for (size_t j = 0; j < positions.size(); ++j)
      if (s & (size_t{1} << positions[j])) local |= 1u << j;
    if (mask & (1u << local)) total += states[s];
  }
  return total;
}

bool covers(const std::vector<unsigned>& joint_events, unsigned scope) {
  for (unsigned e : scope_events(scope))
    if (std::find(joint_events.begin(), joint_events.end(), e) == joint_events.end()) return false;
  return true;
}

i128 marginal(const std::vector<unsigned>& joint_events, const std::vector<i128>& states, unsigned event) {
  size_t bit = size_t{1} << position(joint_events, event);
  i128 total = 0;
  for (size_t s = 0; s < states.size(); ++s)
    if (s & bit) total += states[s];
  return total;
}

// ---- ABI ----
const std::vector<std::pair<std::string, std::string>> SELECTORS = {
    {"buy", "0x3e6b6cde"}, {"sell", "0xc39849c5"}, {"redeem", "0xdf992423"}, {"quoteBuy", "0xa6a83dde"}, {"quoteSell", "0xf29d0ba9"},
    {"holdings", "0x90fc2c7b"}, {"payoutFraction", "0xf0f54950"}, {"closesAt", "0x39a3a99a"}, {"eventCount", "0x71be2e4a"}, {"collateral", "0xd8dfeb45"},
    {"collateralDecimals", "0xec9c6c30"}, {"settlementRulesHash", "0x03a79426"}, {"resolved", "0x3f6fa655"}, {"resolvedState", "0x1bb51c6a"},
    {"voidMask", "0x91187684"}, {"funded", "0xf3a504f2"}, {"approve", "0x095ea7b3"}, {"allowance", "0xdd62ed3e"}, {"balanceOf", "0x70a08231"}, {"decimals", "0x313ce567"},
};
const char* const TOPIC_TRADED = "0xfafd4a382ead0cb54fe827af5995137a1a8b433ebfd5a8d13def35a83adfb9b5";
const char* const TOPIC_REDEEMED = "0x3e24bbc5ae535f3f571a815b8ba9fc70c94ad494d812f0210c3da99fad2173ae";

static std::vector<std::string> signature(const std::string& name) {
  if (name == "buy" || name == "sell") return {"uint32", "uint256", "uint128", "uint128", "uint256"};
  if (name == "redeem" || name == "quoteBuy" || name == "quoteSell") return {"uint32", "uint256", "uint128"};
  if (name == "holdings") return {"address", "uint32", "uint256"};
  if (name == "payoutFraction") return {"uint32", "uint256"};
  if (name == "approve") return {"address", "uint256"};
  if (name == "allowance") return {"address", "address"};
  if (name == "balanceOf") return {"address"};
  return {};
}

static unsigned kind_bits(const std::string& k) {
  if (k == "uint8") return 8;
  if (k == "uint32") return 32;
  if (k == "uint128") return 128;
  if (k == "address") return 160;
  if (k == "bool") return 1;
  return 256;
}

std::optional<std::string> selector(const std::string& name) {
  for (const auto& [n, s] : SELECTORS)
    if (n == name) return s;
  return std::nullopt;
}

bool is_address(const std::string& s) {
  return s.size() == 42 && s.rfind("0x", 0) == 0 && std::all_of(s.begin() + 2, s.end(), [](char c) { return hexval(c) >= 0; });
}

static std::string word(const std::string& kind, const Arg& a) {
  U256 n;
  if (kind == "address") {
    if (a.kind != Arg::Kind::Text || !is_address(a.text)) throw invalid("Invalid address.");
    n = *U256::from_hex(a.text);
  } else if (kind == "bool") {
    if (a.kind != Arg::Kind::Bool) throw invalid("Invalid boolean.");
    n = U256::from_u128(a.flag ? 1 : 0);
  } else if (a.kind == Arg::Kind::Uint) {
    n = a.uint;
  } else if (a.kind == Arg::Kind::Text) {
    auto v = U256::from_dec(a.text);
    if (!v) {
      if (digits(a.text) && a.text[0] != '0') throw invalid("Value out of range for " + kind + ".");
      throw invalid("Invalid " + kind + ".");
    }
    n = *v;
  } else {
    throw invalid("Invalid " + kind + ".");
  }
  if (n.bits() > kind_bits(kind)) throw invalid("Value out of range for " + kind + ".");
  return n.word_hex();
}

std::string encode_call(const std::string& name, const std::vector<Arg>& args) {
  auto sel = selector(name);
  if (!sel) throw invalid("Unsupported function.");
  auto kinds = signature(name);
  if (args.size() != kinds.size()) throw invalid(name + " takes " + std::to_string(kinds.size()) + " arguments.");
  std::string out = *sel;
  for (size_t i = 0; i < kinds.size(); ++i) out += word(kinds[i], args[i]);
  return out;
}

static bool hex_data(const std::string& d) {
  return d.rfind("0x", 0) == 0 && std::all_of(d.begin() + 2, d.end(), [](char c) { return hexval(c) >= 0; });
}

std::pair<std::string, std::vector<U256>> decode_call(const std::string& data) {
  std::string d = lower(data);
  if (!hex_data(d) || d.size() < 10) throw invalid("Invalid calldata.");
  std::string name;
  for (const auto& [n, s] : SELECTORS)
    if (s == d.substr(0, 10)) name = n;
  if (name.empty()) throw invalid("Unsupported function.");
  auto kinds = signature(name);
  std::string body = d.substr(10);
  if (body.size() != kinds.size() * 64) throw invalid("Invalid calldata length.");
  std::vector<U256> args;
  for (size_t i = 0; i < kinds.size(); ++i) {
    U256 v = *U256::from_hex(body.substr(i * 64, 64));
    if (v.bits() > kind_bits(kinds[i])) throw invalid("Non-canonical calldata.");
    args.push_back(v);
  }
  return {name, args};
}

std::vector<U256> decode_words(const std::string& data, size_t count) {
  std::string d = lower(data);
  if (!hex_data(d) || d.size() != 2 + count * 64) throw Error("invalid_response", "Unexpected contract return data.");
  std::vector<U256> out;
  for (size_t i = 0; i < count; ++i) out.push_back(*U256::from_hex(d.substr(2 + i * 64, 64)));
  return out;
}

Log Log::from_json(const json::Value& v) {
  Log l{v.str("address"), {}, v.str("data")};
  for (const auto& t : v["topics"].is_array() ? v["topics"].as_array() : json::Array{})
    if (t.is_string()) l.topics.push_back(t.as_string());
  return l;
}

std::optional<PoolEvent> decode_pool_log(const Log& log) {
  std::vector<std::string> topics;
  for (const auto& t : log.topics) topics.push_back(lower(t));
  if (topics.size() != 4) return std::nullopt;
  for (const auto& t : topics)
    if (!(t.size() == 66 && hex_data(t))) return std::nullopt;
  U256 who = *U256::from_hex(topics[1]), scope = *U256::from_hex(topics[2]), mask = *U256::from_hex(topics[3]);
  if (who.bits() > 160 || scope.bits() > 32) return std::nullopt;
  PoolEvent e;
  e.address = lower(log.address);
  e.who = who.address();
  e.scope = static_cast<unsigned>(*scope.to_u128());
  e.mask = mask;
  try {
    if (topics[0] == TOPIC_TRADED) {
      auto w = decode_words(log.data, 3);
      if (w[0].bits() > 1 || w[1].bits() > 128 || w[2].bits() > 128) return std::nullopt;
      e.event = "Traded";
      e.is_buy = !w[0].is_zero();
      e.quantity = *w[1].to_u128();
      e.collateral_amount = *w[2].to_u128();
      return e;
    }
    if (topics[0] == TOPIC_REDEEMED) {
      auto w = decode_words(log.data, 2);
      if (w[0].bits() > 128 || w[1].bits() > 128) return std::nullopt;
      e.event = "Redeemed";
      e.quantity = *w[0].to_u128();
      e.collateral_amount = *w[1].to_u128();
      return e;
    }
  } catch (const Error&) {
  }
  return std::nullopt;
}

// ---- protocol ----
const char* const STOP_CODES[6] = {"UNAUTHENTICATED", "CREDENTIAL_EXPIRED", "CREDENTIAL_REVOKED", "INVITE_REQUIRED", "AGENT_ARCHIVED", "SCOPE_REQUIRED"};

bool is_lower_hex(const std::string& s, size_t n) {
  return s.size() == n + 2 && s.rfind("0x", 0) == 0 && std::all_of(s.begin() + 2, s.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

static bool namespace_ok(const std::string& s) {
  if (s == "pilot") return true;
  return s.rfind("practice-", 0) == 0 && is_lower_hex("0x" + s.substr(9), 40);
}

Deployment parse_deployment(const json::Value& d) {
  auto bad = [](const std::string& what) { return Error("invalid_response", "Unsupported deployment: " + what + "."); };
  if (d.str("schema") != "flurbo.agent-deployment.v1") throw bad("schema");
  if (d.str("interface") != "flurbo.pilot-pool.v1") throw bad("interface");
  if (!d["chainId"].is_integer() || d["chainId"].as_int() != 10143) throw bad("chain");
  if (!namespace_ok(d.str("namespace"))) throw bad("namespace");
  if (d["collateral"].str("address") != COLLATERAL || d["collateral"].integer("decimals", -1) != 6) throw bad("collateral");
  Deployment out;
  out.namespace_ = d.str("namespace");
  out.pool = d.str("pool");
  out.resolver = d.str("resolver");
  if (!is_lower_hex(out.pool, 40)) throw bad("pool");
  if (!is_lower_hex(out.resolver, 40)) throw bad("resolver");
  out.pool_code_hash = d["codeHashes"].str("pool");
  out.resolver_code_hash = d["codeHashes"].str("resolver");
  out.rules_hash = d.str("rulesHash");
  for (const auto& h : {out.pool_code_hash, out.resolver_code_hash, out.rules_hash})
    if (!is_lower_hex(h, 64)) throw bad("hashes");
  int64_t events = d.integer("eventCount", 0);
  if (!d["closesAt"].is_integer() || d["closesAt"].as_int() < 0 || events < 2 || events > 4) throw bad("market shape");
  out.closes_at = static_cast<uint64_t>(d["closesAt"].as_int());
  out.event_count = static_cast<unsigned>(events);
  const auto& l = d["limits"];
  json::Value slippage(json::Array{json::Value(10), json::Value(50), json::Value(100)});
  if (l.str("maxQuantityAtoms") != "100000000" || l.str("maxLimitAtoms") != "100000000" || l["slippageBps"] != slippage || l.integer("maxDeadlineSeconds", 0) != 300)
    throw bad("service limits");
  return out;
}

// ---- transactions ----
static Error refuse(const std::string& m) { return invalid("Refusing to sign: " + m + "."); }
static Arg amount(i128 v) {
  if (v < 0) throw refuse("negative amount");
  return Arg(static_cast<u128>(v));
}

UnsignedCall build_transaction(const Intent& in, const Deployment& d, const std::string& wallet) {
  UnsignedCall tx;
  tx.from = lower(wallet);
  if (in.action == "approve") {
    tx.to = COLLATERAL;
    tx.data = encode_call("approve", {Arg(d.pool), amount(in.limit_atoms)});
  } else if (in.action == "redeem") {
    tx.to = d.pool;
    tx.data = encode_call("redeem", {Arg(in.claim.scope), Arg(in.claim.mask), amount(in.quantity_atoms)});
  } else if (in.action == "buy" || in.action == "sell") {
    tx.to = d.pool;
    tx.data = encode_call(in.action, {Arg(in.claim.scope), Arg(in.claim.mask), amount(in.quantity_atoms), amount(in.limit_atoms), Arg(in.deadline)});
  } else {
    throw refuse("unknown action");
  }
  validate_transaction(tx, in, d, wallet);
  return tx;
}

static bool eq(const U256& w, i128 v) { return v >= 0 && w == U256::from_u128(static_cast<u128>(v)); }

void validate_transaction(const UnsignedCall& tx, const Intent& in, const Deployment& d, const std::string& wallet) {
  if (tx.chain_id != 10143 || d.chain_id != 10143) throw refuse("not Monad testnet");
  if (tx.value != 0) throw refuse("value must be zero");
  if (lower(tx.from) != lower(wallet)) throw refuse("the signer is not the agent wallet");
  auto [name, args] = decode_call(tx.data);
  if (name != in.action) throw refuse("the method differs from the intent");
  U256 max = U256::from_u128(static_cast<u128>(SERVICE_MAX_ATOMS));
  if (in.action == "approve") {
    if (lower(tx.to) != COLLATERAL) throw refuse("approvals are only for test AUSD");
    if (args[0].address() != d.pool) throw refuse("the spender is not the pool");
    if (!eq(args[1], in.limit_atoms) || args[1].is_zero() || args[1] > max) throw refuse("the approval amount is outside the service limit");
    return;
  }
  if (lower(tx.to) != d.pool) throw refuse("the contract is not the published pool");
  if (!(args[0] == U256::from_u128(in.claim.scope)) || !(args[1] == U256::from_u128(in.claim.mask)) || !eq(args[2], in.quantity_atoms))
    throw refuse("the claim or quantity differs from the intent");
  if (!claim_valid(in.claim.scope, std::to_string(in.claim.mask), d.event_count)) throw refuse("the claim is not supported in this pool");
  if (args[2].is_zero() || args[2] > max) throw refuse("the quantity is outside the service limit");
  if (in.action == "buy" || in.action == "sell") {
    if (!eq(args[3], in.limit_atoms) || args[3] > max || (in.action == "buy" && args[3].is_zero())) throw refuse("the limit differs from the intent or the service limit");
    if (!(args[4] == U256::from_u128(in.deadline)) || in.deadline >= d.closes_at) throw refuse("the deadline differs from the intent or is after the close");
  }
}

// ---- text and time ----
size_t js_len(const std::string& s) {
  size_t n = 0;
  for (unsigned char c : s) {
    if ((c & 0xC0) != 0x80) n += (c >= 0xF0) ? 2 : 1;
  }
  return n;
}

std::string js_slice(const std::string& s, size_t units) {
  size_t used = 0, i = 0;
  while (i < s.size()) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    size_t len = c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
    size_t u = c >= 0xF0 ? 2 : 1;
    if (used + u > units) break;
    used += u;
    i += len;
  }
  return s.substr(0, std::min(i, s.size()));
}

std::string trim(const std::string& s) {
  auto ws = [](unsigned char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; };
  size_t a = 0, b = s.size();
  while (a < b && ws(static_cast<unsigned char>(s[a]))) ++a;
  while (b > a && ws(static_cast<unsigned char>(s[b - 1]))) --b;
  return s.substr(a, b - a);
}

static void civil(int64_t z, int64_t& y, unsigned& m, unsigned& d) {
  z += 719468;
  int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  int64_t doe = z - era * 146097;
  int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  int64_t mp = (5 * doy + 2) / 153;
  d = static_cast<unsigned>(doy - (153 * mp + 2) / 5 + 1);
  m = static_cast<unsigned>(mp < 10 ? mp + 3 : mp - 9);
  y = yoe + era * 400 + (m <= 2);
}

static int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  int64_t era = (y >= 0 ? y : y - 399) / 400;
  int64_t yoe = y - era * 400;
  int64_t doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
  int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}

std::string iso(int64_t seconds) {
  int64_t days = seconds >= 0 ? seconds / 86400 : (seconds - 86399) / 86400;
  int64_t rest = seconds - days * 86400, y;
  unsigned m, d;
  civil(days, y, m, d);
  char buf[40];
  std::snprintf(buf, sizeof buf, "%04lld-%02u-%02uT%02lld:%02lld:%02lld.000Z", static_cast<long long>(y), m, d, static_cast<long long>(rest / 3600),
                static_cast<long long>(rest % 3600 / 60), static_cast<long long>(rest % 60));
  return buf;
}

std::optional<int64_t> parse_http_date(const std::string& s) {
  char wd[8] = {0}, mon[8] = {0}, zone[8] = {0};
  int day, year, h, mi, se;
  if (std::sscanf(s.c_str(), "%3s, %d %3s %d %d:%d:%d %3s", wd, &day, mon, &year, &h, &mi, &se, zone) != 8 || std::string(zone) != "GMT") return std::nullopt;
  static const char* months[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
  for (unsigned k = 0; k < 12; ++k)
    if (std::string(mon) == months[k]) {
      if (day < 1 || day > 31 || h > 23 || mi > 59 || se > 60) return std::nullopt;
      return days_from_civil(year, k + 1, static_cast<unsigned>(day)) * 86400 + h * 3600 + mi * 60 + se;
    }
  return std::nullopt;
}

int64_t now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}
int64_t now_millis() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

}  // namespace flurbo
