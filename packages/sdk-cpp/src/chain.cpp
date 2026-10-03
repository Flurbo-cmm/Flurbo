// JSON-RPC, chain reads and the headless Flurbo API client. Provider and upstream error text can contain
// endpoint details or keys, so it is never surfaced: callers get a kind and a safe message.
#include <algorithm>

#include "flurbo/runtime.hpp"

namespace flurbo {

using json::Value;

static Error rpc_error(const std::string& kind, const std::string& message) {
  Error e(kind == "timeout" ? "timeout" : "network", message);
  e.rpc_kind = kind;
  return e;
}

JsonRpc::JsonRpc(const std::string& url, int timeout_ms) : url_(url), timeout_ms_(timeout_ms) {
  auto u = parse_url(url);
  if (!u || (u->scheme != "http" && u->scheme != "https")) throw invalid("The RPC URL must use HTTP or HTTPS.");
  if (u->scheme == "http" && !is_loopback(u->host)) throw invalid("Plain HTTP is only allowed for a local chain.");
}

Value JsonRpc::call(const std::string& method, const Value& params) {
  uint64_t id = ids_++;
  Value request = Value::object();
  request.set("jsonrpc", "2.0");
  request.set("id", static_cast<int64_t>(id));
  request.set("method", method);
  request.set("params", params);
  HttpResponse r;
  try {
    r = capacity_http_request({"POST", url_, {{"Content-Type", "application/json"}}, request.dump(), timeout_ms_},true);
  } catch (const Error& e) {
    if (e.code == "rate_limited") throw;
    if (e.code == "timeout") throw rpc_error("timeout", "The chain did not answer " + method + " in time.");
    throw rpc_error("unavailable", "The chain endpoint could not be reached for " + method + ".");
  }
  if(r.status==429)throw Error("rate_limited","RPC rate limited. Retry after the cooldown.");
  Value body;
  try {
    body = json::parse(r.body);
  } catch (const Error&) {
    throw rpc_error("unavailable", "The chain endpoint failed " + method + ".");
  }
  if (body.has("error") && !body["error"].is_null()) throw rpc_error("rejected", "The chain rejected " + method + ".");
  if (!body["id"].is_integer() || static_cast<uint64_t>(body["id"].as_int()) != id || !body.has("result"))
    throw rpc_error("unavailable", "The chain endpoint failed " + method + ".");
  return body["result"];
}

u128 hex_u128(const Value& v) {
  if (!v.is_string() || v.as_string().rfind("0x", 0) != 0) throw Error("invalid_response", "The chain returned an unexpected number.");
  std::string h = v.as_string().substr(2);
  if (h.empty()) return 0;
  auto w = U256::from_hex(h);
  if (!w || w->bits() > 128) throw Error("invalid_response", "The chain returned an unexpected number.");
  return *w->to_u128();
}

std::string hex_of(u128 n) {
  if (n == 0) return "0x0";
  std::string s;
  while (n) {
    s += "0123456789abcdef"[static_cast<int>(n & 15)];
    n >>= 4;
  }
  return "0x" + std::string(s.rbegin(), s.rend());
}

static Value params(std::initializer_list<Value> items) { return Value(json::Array(items)); }
static Value call_object(const std::string& to, const std::string& data) {
  Value o = Value::object();
  o.set("to", to);
  o.set("data", data);
  return o;
}

U256 ChainReader::word(const std::string& to, const std::string& data, const std::string& tag) {
  Value r = rpc_->call("eth_call", params({call_object(to, data), tag}));
  return decode_words(r.is_string() ? r.as_string() : "", 1)[0];
}

u128 ChainReader::small(const std::string& to, const std::string& data, const std::string& tag) {
  auto v = word(to, data, tag).to_u128();
  if (!v) throw Error("invalid_response", "The chain returned an out-of-range value.");
  return *v;
}

Block ChainReader::block(std::optional<uint64_t> number) {
  Value b = rpc_->call("eth_getBlockByNumber", params({number ? Value(hex_of(*number)) : Value("latest"), false}));
  if (!b["hash"].is_string()) throw Error("invalid_response", "The chain returned no block.");
  return {static_cast<uint64_t>(hex_u128(b["number"])), lower(b["hash"].as_string()), static_cast<int64_t>(hex_u128(b["timestamp"]))};
}

uint64_t ChainReader::chain_id() { return static_cast<uint64_t>(hex_u128(rpc_->call("eth_chainId", Value::array()))); }

void ChainReader::verify_deployment(const Deployment& d) {
  auto fail = [&](const std::string& what) { return Error("invalid_response", "Unsupported deployment " + d.namespace_ + ": " + what + "."); };
  if (chain_id() != 10143) throw fail("the RPC is not Monad testnet (10143)");
  std::string head = hex_of(block().number);
  for (const auto& [address, expected] : {std::make_pair(d.pool, d.pool_code_hash), std::make_pair(d.resolver, d.resolver_code_hash)}) {
    Value code = rpc_->call("eth_getCode", params({address, head}));
    std::string c = code.is_string() ? code.as_string() : "0x";
    if (c == "0x" || keccak_hex(c) != expected) throw fail("contract code differs from the published deployment");
  }
  if ("0x" + word(d.pool, encode_call("settlementRulesHash", {}), head).word_hex() != d.rules_hash) throw fail("settlement rules differ");
  if (small(d.pool, encode_call("closesAt", {}), head) != d.closes_at) throw fail("close time differs");
  if (small(d.pool, encode_call("eventCount", {}), head) != d.event_count) throw fail("event count differs");
  if (word(d.pool, encode_call("collateral", {}), head).address() != COLLATERAL) throw fail("collateral differs");
  if (small(COLLATERAL, encode_call("decimals", {}), head) != 6) throw fail("collateral decimals differ");
}

std::optional<u128> ChainReader::quote(const std::string& pool, const std::string& side, unsigned scope, unsigned mask, u128 quantity, const Block& at) {
  try {
    return small(pool, encode_call(side == "buy" ? "quoteBuy" : "quoteSell", {Arg(scope), Arg(mask), Arg(quantity)}), hex_of(at.number));
  } catch (const Error& e) {
    if (e.rpc_kind == "rejected") return std::nullopt;
    throw;
  }
}

bool ChainReader::resolved(const std::string& pool) { return !word(pool, encode_call("resolved", {}), "latest").is_zero(); }

u128 ChainReader::holdings(const std::string& pool, const std::string& owner, unsigned scope, unsigned mask) {
  return small(pool, encode_call("holdings", {Arg(owner), Arg(scope), Arg(mask)}), "latest");
}

U256 ChainReader::allowance(const std::string& owner, const std::string& spender, const std::string& tag) {
  return word(COLLATERAL, encode_call("allowance", {Arg(owner), Arg(spender)}), tag);
}

u128 ChainReader::native_balance(const std::string& owner) { return hex_u128(rpc_->call("eth_getBalance", params({owner, "latest"}))); }

uint64_t ChainReader::nonce(const std::string& owner, const std::string& tag) {
  return static_cast<uint64_t>(hex_u128(rpc_->call("eth_getTransactionCount", params({owner, tag}))));
}

static Value tx_object(const std::string& from, const std::string& to, const std::string& data) {
  Value o = Value::object();
  o.set("from", from);
  o.set("to", to);
  o.set("data", data);
  o.set("value", "0x0");
  return o;
}

Value ChainReader::simulate(const std::string& from, const std::string& to, const std::string& data) {
  return rpc_->call("eth_call", params({tx_object(from, to, data), "latest"}));
}

u128 ChainReader::estimate_gas(const std::string& from, const std::string& to, const std::string& data) {
  return hex_u128(rpc_->call("eth_estimateGas", params({tx_object(from, to, data)})));
}

Fees ChainReader::fees() {
  u128 price = hex_u128(rpc_->call("eth_gasPrice", Value::array()));
  u128 priority = 0;
  try {
    priority = hex_u128(rpc_->call("eth_maxPriorityFeePerGas", Value::array()));
  } catch (const Error&) {
  }
  u128 max_fee = price * 120 / 100;
  return {max_fee, std::min(priority, max_fee)};
}

Value ChainReader::send_raw(const std::string& raw) { return rpc_->call("eth_sendRawTransaction", params({raw})); }

bool ChainReader::transaction_found(const std::string& hash) { return !rpc_->call("eth_getTransactionByHash", params({hash})).is_null(); }

std::optional<Receipt> ChainReader::receipt(const std::string& hash) {
  Value r = rpc_->call("eth_getTransactionReceipt", params({hash}));
  if (r.is_null()) return std::nullopt;
  Receipt out;
  out.status = hex_u128(r["status"]) == 1 ? 1 : 0;
  out.block_number = static_cast<uint64_t>(hex_u128(r["blockNumber"]));
  out.block_hash = lower(r.str("blockHash"));
  out.gas_used = r["gasUsed"].is_null() ? 0 : hex_u128(r["gasUsed"]);
  if (!r["effectiveGasPrice"].is_null()) out.effective_gas_price = hex_u128(r["effectiveGasPrice"]);
  if (r["logs"].is_array())
    for (const auto& l : r["logs"].as_array()) {
      Log log = Log::from_json(l);
      log.address = lower(log.address);
      log.data = lower(log.data);
      for (auto& t : log.topics) t = lower(t);
      out.logs.push_back(log);
    }
  return out;
}

// ---- headless API ----
bool token_ok(const std::string& t) {
  if (t.size() != 5 + 16 + 1 + 43 || t.rfind("fla1_", 0) != 0 || t[21] != '_') return false;
  for (size_t i = 5; i < 21; ++i)
    if (!((t[i] >= '0' && t[i] <= '9') || (t[i] >= 'a' && t[i] <= 'f'))) return false;
  for (size_t i = 22; i < t.size(); ++i)
    if (!(std::isalnum(static_cast<unsigned char>(t[i])) || t[i] == '_' || t[i] == '-')) return false;
  return true;
}

bool is_stop(const Error& e) {
  return std::any_of(std::begin(STOP_CODES), std::end(STOP_CODES), [&](const char* c) { return e.api_code == c; });
}

static Error api_error(const std::string& api_code, const std::string& message, std::optional<int> status) {
  std::string code = "unavailable";
  if (status == 401) code = "unauthenticated";
  else if (status == 403) code = "forbidden";
  else if (status == 404) code = "not_found";
  else if (status == 409) code = "conflict";
  else if (status == 429) code = "rate_limited";
  Error e(code, message);
  e.status = status;
  e.api_code = api_code;
  return e;
}

RuntimeClient::RuntimeClient(const std::string& base_url, const std::string& token) {
  auto u = parse_url(base_url);
  bool local = u && u->scheme == "http" && (u->host == "127.0.0.1" || u->host == "localhost");
  if (!u || (u->scheme != "https" && !local)) throw invalid("Use HTTPS for the Flurbo API.");
  if (!token_ok(token)) throw Error("unauthenticated", "The agent credential is missing or malformed.");
  origin_ = u->origin;
  token_ = token;
}

Value RuntimeClient::call(const std::string& method, const std::string& path, const std::optional<Value>& body) {
  HttpRequest req{method, origin_ + RUNTIME_API_BASE + path, {{"Authorization", "Bearer " + token_}, {PROTOCOL_HEADER, PROTOCOL_VERSION}}, "", 20000};
  if (body) {
    req.headers.emplace_back("Content-Type", "application/json");
    req.body = body->dump();
  }
  HttpResponse r;
  try {
    r = capacity_http_request(req);
  } catch (const Error& e) {
    if(e.code=="rate_limited")throw;
    throw api_error("NETWORK", "The Flurbo API could not be reached.", std::nullopt);
  }
  Value parsed;
  try {
    parsed = r.body.empty() ? Value() : json::parse(r.body);
  } catch (const Error&) {
    if (r.status < 400) throw api_error("NETWORK", "The Flurbo API could not be reached.", std::nullopt);
  }
  if (r.status >= 400) {
    std::string code = parsed["code"].is_string() ? parsed["code"].as_string() : "UNAVAILABLE";
    std::string message = parsed["error"].is_string() && parsed["error"].as_string().size() < 300 ? parsed["error"].as_string() : "The Flurbo API refused the request.";
    throw api_error(code, message, r.status);
  }
  return parsed;
}

Value RuntimeClient::session() { return call("GET", "/session", std::nullopt); }

std::vector<Deployment> RuntimeClient::deployments() {
  Value r = call("GET", "/deployments", std::nullopt);
  if (r.str("schema") != "flurbo.agent-deployments.v1" || !r["deployments"].is_array()) throw Error("invalid_response", "Unexpected deployments response.");
  std::vector<Deployment> out;
  for (const auto& d : r["deployments"].as_array()) out.push_back(parse_deployment(d));
  return out;
}

Value RuntimeClient::market(const std::string& ns) { return call("GET", "/markets/" + url_segment(ns), std::nullopt); }
Value RuntimeClient::validate_trade(const std::string& ns, unsigned scope, unsigned mask, const std::string& quantity) {
  Value body = Value::object();
  body.set("scope", static_cast<int64_t>(scope)); body.set("mask", std::to_string(mask)); body.set("quantityAtoms", quantity);
  return call("POST", "/markets/" + url_segment(ns) + "/validate-trade", body);
}
bool semantics_disabled(const Value& r) { return r.is_object() && r["mode"].is_string() && r.str("mode") == "disabled"; }
std::string semantic_error(const Value& r, const Deployment& d, unsigned scope, unsigned mask, const std::string& quantity, int64_t now) {
  const std::string unavailable = "SEMANTICS_UNAVAILABLE";
  if (d.event_count < 2 || d.event_count > 4) return unavailable;
  try {
    if (r.str("schema") != "flurbo.semantic-assessment.v1" || r.str("pool") != d.pool || r.str("rulesHash") != d.rules_hash || r.integer("scope") != scope
        || r.str("mask") != std::to_string(mask) || r.str("quantityAtoms") != quantity) return unavailable;
    auto is_digest = [](const std::string& h) { return h.size() == 64 && h.find_first_not_of("0123456789abcdef") == std::string::npos; };
    auto checked = r.integer("checkedAt"), expires = r.integer("expiresAt");
    if (checked < 0 || checked > now + 15 || expires <= now || expires < checked || expires - checked != 60
        || !r["configRevision"].is_string() || !is_digest(r.str("configRevision"))) return unavailable;
    // A valid, claim-bound "disabled" answer proceeds without semantic assurance; any other mode is unavailable.
    if (r["mode"].is_string() && r.str("mode") == "disabled") return "";
    if (!r["mode"].is_string() || r.str("mode") != "enforced") return unavailable;
    auto digest = r.str("rulesDigest"), status = r.str("status"), coverage = r.str("coverage");
    if (!is_digest(digest)
        || (status != "collision" && status != "unknown" && status != "no_declared_collision")
        || (coverage != "unknown" && coverage != "partial" && coverage != "complete")) return unavailable;
    const auto& rows = r["matrix"].as_array();
    if (rows.size() != (1u << d.event_count)) return unavailable;
    bool any = false, winning = false;
    unsigned count = 0;
    for (unsigned bit = 0; bit < d.event_count; ++bit) if (scope & (1u << bit)) ++count;
    for (unsigned state = 0; state < rows.size(); ++state) {
      const auto& row = rows[state];
      unsigned local = 0, index = 0;
      for (unsigned bit = 0; bit < d.event_count; ++bit) if (scope & (1u << bit)) { if (state & (1u << bit)) local |= 1u << index; ++index; }
      bool pays = (mask & (1u << local)) != 0;
      if (!row["state"].is_integer() || row.integer("state") != state || !row["admissible"].is_bool() || !row["pays"].is_bool() || row["pays"].as_bool() != pays) return unavailable;
      any |= row["admissible"].as_bool(); winning |= row["admissible"].as_bool() && pays;
    }
    if (!any || (!winning) != (status == "collision")) return unavailable;
    if (!winning) return "SEMANTIC_COLLISION";
    if (count > 1 && (coverage != "complete" || status == "unknown")) return "SEMANTICS_UNKNOWN";
    return "";
  } catch (...) { return unavailable; }
}
Value RuntimeClient::policy() { return call("GET", "/policy", std::nullopt); }
Value RuntimeClient::heartbeat(const Value& beat) { return call("POST", "/heartbeat", beat); }
Value RuntimeClient::decision(const Value& d) { return call("POST", "/decisions", d); }
Value RuntimeClient::report_execution(const Value& r) { return call("POST", "/executions", r); }
Value RuntimeClient::execution(const std::string& hash) { return call("GET", "/executions/" + url_segment(hash), std::nullopt); }

}  // namespace flurbo
