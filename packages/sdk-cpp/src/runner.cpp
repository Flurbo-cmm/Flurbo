// The agent loop, same configuration format (flurbo.agent-config.v1) and behavior as the TypeScript runtime:
// research -> validated forecast -> strategy -> policy -> quote and simulation -> journal -> sign -> broadcast
// -> receipt -> verify -> report. Paper mode never constructs a signer.
#include <chrono>
#include <cstdio>
#include <filesystem>

#include <algorithm>

#include "flurbo/runtime.hpp"
#include <set>

namespace flurbo {

using json::Value;

// ---- configuration ----
Value default_config() {
  return json::parse(R"({
  "schema": "flurbo.agent-config.v1",
  "api": {"baseUrl": "https://flurbo.singu.online", "credentialEnv": "FLURBO_AGENT_TOKEN"},
  "chain": {"rpcUrl": "https://testnet-rpc.monad.xyz"},
  "signer": {"kind": "local-key", "keyEnv": "FLURBO_AGENT_PRIVATE_KEY"},
  "stateDir": ".flurbo-agent", "mode": "paper", "markets": ["pilot"],
  "schedule": {"intervalSeconds": 300, "heartbeatSeconds": 30, "waitSeconds": 90},
  "research": {"retriever": {"kind": "http", "allowHosts": ["github.com"]}, "provider": {"kind": "none"}, "perCycle": 2, "perHour": 20, "maxEvidenceAgeDays": 14},
  "strategy": {"id": "joint-edge", "quantityAtoms": "1000000", "slippageBps": 50, "minEdgeBps": 500, "minEdgeAtoms": "10000", "maxCostAtoms": "2000000", "includeSingles": true, "minEvidence": 1},
  "policy": {"markets": ["pilot"], "maxQuantityAtoms": "2000000", "maxTradeCostAtoms": "2000000", "maxSlippageBps": 50,
             "spend": {"totalAtoms": "20000000", "windows": [{"seconds": 86400, "atoms": "10000000"}]}, "maxPositionAtoms": "5000000", "maxWorstCaseLossAtoms": "10000000",
             "gas": {"maxFeeWei": "100000000000000000", "reserveWei": "200000000000000000"}, "quoteMaxAgeSeconds": 30, "minSecondsBeforeClose": 120, "maxPending": 2,
             "allowSell": false, "allowRedeem": false},
  "policyMaxAgeSeconds": 120, "paperBudgetAtoms": "50000000"
})");
}

static bool env_name(const std::string& s) {
  if (s.empty() || !(std::isupper(static_cast<unsigned char>(s[0])) || s[0] == '_')) return false;
  return std::all_of(s.begin(), s.end(), [](char c) { return std::isupper(static_cast<unsigned char>(c)) || std::isdigit(static_cast<unsigned char>(c)) || c == '_'; });
}

static bool has_key_material(const std::string& t) {
  for (size_t i = 0; i + 66 <= t.size(); ++i) {
    if (t[i] != '0' || t[i + 1] != 'x') continue;
    bool hex = std::all_of(t.begin() + static_cast<long>(i) + 2, t.begin() + static_cast<long>(i) + 66, [](char c) { return std::isxdigit(static_cast<unsigned char>(c)); });
    if (hex && (i + 66 == t.size() || !std::isxdigit(static_cast<unsigned char>(t[i + 66])))) return true;
  }
  return false;
}

Value parse_config(const Value& c) {
  auto bad = [](const std::string& m) { return invalid("Configuration: " + m); };
  if (c.str("schema") != "flurbo.agent-config.v1") throw bad("schema must be flurbo.agent-config.v1.");
  std::string mode = c.str("mode");
  if (mode != "paper" && mode != "live") throw bad("mode must be paper or live.");
  if (!c["markets"].is_array() || c["markets"].size() == 0) throw bad("list at least one market.");
  try {
    Policy p = Policy::from_json(c["policy"]);
    for (const auto& m : p.markets)
      if (std::none_of(c["markets"].as_array().begin(), c["markets"].as_array().end(), [&](const Value& x) { return x == Value(m); }))
        throw bad("policy.markets must be a subset of markets.");
    int64_t s = c["strategy"]["slippageBps"].as_int();
    auto ok = [](int64_t v) { return v == 10 || v == 50 || v == 100; };
    if (!ok(p.max_slippage_bps) || !ok(s) || s > p.max_slippage_bps) throw bad("slippage must be 10, 50 or 100 and within the policy.");
    for (const char* k : {"quantityAtoms", "minEdgeAtoms", "maxCostAtoms"}) parse_atoms(c["strategy"].str(k), "strategy amount");
    parse_atoms(c.str("paperBudgetAtoms"), "paper budget");
    c["schedule"]["intervalSeconds"].as_int();
    c["research"]["perCycle"].as_int();
  } catch (const Error& e) {
    if (e.code == "invalid_input" && std::string(e.what()).rfind("Configuration:", 0) == 0) throw;
    throw bad("a required setting is missing or has the wrong type.");
  }
  if (!env_name(c["api"].str("credentialEnv")) || !env_name(c["signer"].str("keyEnv"))) throw bad("credential and key settings must name environment variables.");
  std::string text = c.dump(), low = lower(text);
  if (has_key_material(text) && (low.find("\"privatekey\"") != std::string::npos || low.find("\"secret\"") != std::string::npos))
    throw bad("secrets do not belong in the configuration file.");
  if (c["schedule"].integer("intervalSeconds") < 10 || c["schedule"].integer("heartbeatSeconds") < 5) throw bad("schedule too aggressive.");
  if (c["research"].has("evidenceRequirements")) {
    const auto& requirements = c["research"]["evidenceRequirements"];
    if (!requirements.is_object()) throw bad("research.evidenceRequirements must map namespaces to lists.");
    for (const auto& [name, list] : requirements.members()) {
      if (std::none_of(c["markets"].as_array().begin(), c["markets"].as_array().end(), [&](const Value& m) { return m == Value(name); }) || !list.is_array()) throw bad("invalid evidence requirements namespace.");
      std::set<int64_t> seen;
      for (const auto& r : list.as_array()) if (!r["event"].is_integer() || r["event"].as_int() < 0 || r["event"].as_int() > 3
        || !seen.insert(r["event"].as_int()).second || (r.str("freshness") != "release" && r.str("freshness") != "background")) throw bad("invalid or duplicate evidence requirement.");
    }
  }
  return c;
}

Value load_config(const std::string& path) {
  auto text = read_file(path);
  if (!text) throw invalid("No configuration at " + path + ". Run init first.");
  Value c;
  try {
    c = json::parse(*text);
  } catch (const Error&) {
    throw invalid("The configuration is not valid JSON.");
  }
  c = parse_config(c);
  auto dir = std::filesystem::absolute(std::filesystem::u8path(path)).parent_path();
  c.set("stateDir", utf8((dir / std::filesystem::u8path(c.str("stateDir"))).lexically_normal()));
  return c;
}

// ---- the reference strategy ----
StrategyConfig JointEdgeStrategy::config_of(const Value& c) {
  const Value& s = c["strategy"];
  return {parse_i128(s.str("quantityAtoms")), s["slippageBps"].as_int(), s["minEdgeBps"].as_int(), parse_i128(s.str("minEdgeAtoms")), parse_i128(s.str("maxCostAtoms")),
          static_cast<unsigned>(s["minEvidence"].as_int()), s["includeSingles"].as_bool()};
}

StrategyDecision JointEdgeStrategy::decide(const StrategyContext& ctx) {
  auto claims = candidate_claims(ctx.market.pool, ctx.market.event_count, ctx.forecast.events, config.include_singles);
  Decision d = flurbo::decide(ctx.market, ctx.forecast, config, ctx.now, ctx.quote(claims, config.quantity_atoms));
  StrategyDecision out{d.outcome, d.reasons, "No covered claim clears the edge threshold after the quoted cost and slippage allowance.", std::nullopt};
  if (d.proposal) {
    const auto& p = *d.proposal;
    i128 tenths = (p.forecast_ppm + 500) / 1000;
    out.explanation = "Forecast " + to_string(tenths / 10) + "." + to_string(tenths % 10) + "% that the claim pays; quoted cost " + to_string(p.quote_atoms) +
                      " atoms, at most " + to_string(p.worst_cost_atoms) + " with slippage; estimated edge " + to_string(p.edge_atoms) + " atoms before gas.";
    out.proposal = StrategyProposal{p.scope, p.mask, p.quantity_atoms, p.quote_atoms, p.slippage_bps, p.edge_atoms, p.edge_bps};
  }
  return out;
}

// ---- runner state the executor consults ----
struct AgentRunner::Shared : Controls {
  Value config;
  std::string stop_file;
  // Set only for the final heartbeat when a run ends, so Flurbo shows the runtime as stopped.
  std::atomic<bool> stopped{false};
  std::mutex m;
  std::optional<FlurboPolicy> flurbo;
  std::optional<int64_t> read_at;
  std::optional<std::string> blocked_by, last_error;
  LogFn log_fn;
  std::function<int64_t()> clock;

  EffectivePolicy effective() {
    Policy p = Policy::from_json(config["policy"]);
    std::lock_guard<std::mutex> g(m);
    return effective_policy({config.str("mode"), p.max_trade_cost_atoms, p.windows}, flurbo, read_at, clock(), config.integer("policyMaxAgeSeconds", 120));
  }
  Policy policy() override {
    EffectivePolicy e = effective();
    Policy p = Policy::from_json(config["policy"]);
    p.max_trade_cost_atoms = e.max_trade_cost_atoms;
    p.windows = e.windows;
    return p;
  }
  std::pair<bool, std::string> live_allowed() override {
    {
      std::lock_guard<std::mutex> g(m);
      if (blocked_by) return {false, *blocked_by};
    }
    if (file_exists(stop_file)) return {false, "stop_requested"};
    EffectivePolicy e = effective();
    return {e.live_allowed, e.reason.value_or("")};
  }
  int64_t now() override { return clock(); }
  void log(const std::string& event, const Value& detail) override { log_fn(event, detail); }
  void stop(const std::string& code) override {
    bool first;
    {
      std::lock_guard<std::mutex> g(m);
      first = !blocked_by;
      blocked_by = code;
    }
    if (first) {
      Value d = Value::object();
      d.set("code", code);
      log_fn("stopped_new_actions", d);
    }
  }
};

static void default_log(const std::string& event, const Value& detail) {
  Value line = Value::object();
  line.set("at", iso(now_seconds()));
  line.set("event", event);
  if (detail.is_object())
    for (const auto& [k, v] : detail.members()) line.set(k, v);
  std::printf("%s\n", line.dump().c_str());
  std::fflush(stdout);
}

AgentRunner::AgentRunner(Value config, RunnerOptions o) : config_(std::move(config)) {
  auto lookup = [&](const std::string& k) -> std::optional<std::string> {
    if (o.env) {
      auto it = o.env->find(k);
      if (it == o.env->end() || trim(it->second).empty()) return std::nullopt;
      return trim(it->second);
    }
    return get_env(k);
  };
  dir_ = config_.str("stateDir");
  make_dirs(dir_);
  if (auto text = read_file(path_join(dir_, "runtime.json"))) try {
      saved_ = json::parse(*text);
    } catch (const Error&) {
    }
  if (!saved_.is_object()) saved_ = Value::object();
  runtime_id = saved_.str("runtimeId", "rt-" + uuid4());
  shared_ = std::make_shared<Shared>();
  shared_->config = config_;
  shared_->stop_file = path_join(dir_, "stop.request");
  shared_->log_fn = o.log ? o.log : LogFn(default_log);
  shared_->clock = o.now ? o.now : std::function<int64_t()>(now_seconds);
  started_at_ = shared_->clock();
  client_ = o.client;
  if (!client_)
    if (auto token = lookup(config_["api"].str("credentialEnv"))) client_ = std::make_shared<RuntimeClient>(config_["api"].str("baseUrl"), *token);
  chain_ = o.chain ? o.chain : std::make_shared<ChainReader>(std::make_shared<JsonRpc>(config_["chain"].str("rpcUrl")));
  if (config_.str("mode") == "live") {  // paper mode never constructs a signer
    signer = o.signer;
    if (!signer) {
      std::string var = config_["signer"].str("keyEnv");
      auto key = lookup(var);
      if (!key) throw invalid("Set " + var + " to the dedicated agent wallet key (testnet only). Never use a deployer, settlement, reviewer or personal wallet.");
      signer = std::make_shared<LocalKeySigner>(*key);
    }
  }
  journal = std::make_shared<FileJournal>(dir_, signer ? signer->address() : "0x" + std::string(40, '0'));
  const Value& r = config_["research"];
  std::shared_ptr<Forecaster> forecaster = o.forecaster;
  std::optional<Error> unconfigured;
  if (!forecaster) {
    const Value& p = r["provider"];
    std::string kind = p.str("kind");
    int timeout = static_cast<int>(p.integer("timeoutMs", 60000));
    int retries = static_cast<int>(p.integer("maxRetries", 2));
    try {
      if (kind == "openai-compatible") {
        std::optional<std::string> key = p["apiKeyEnv"].is_string() ? lookup(p.str("apiKeyEnv")) : std::nullopt;
        forecaster = std::make_shared<OpenAiCompatible>(p.str("baseUrl"), p.str("model"), key, timeout, retries);
      } else if (kind == "anthropic") {
        forecaster = std::make_shared<AnthropicMessages>(p.str("model"), lookup(p.str("apiKeyEnv")), timeout, retries);
      } else if (kind == "fixture") {
        std::string path = path_join(path_join(dir_, ".."), p.str("replyFile"));
        forecaster = std::make_shared<FixtureForecaster>(
            [path](const Prompt&) {
              auto t = read_file(path);
              if (!t) throw Error("provider_unavailable", "The fixture reply file could not be read.");
              return *t;
            },
            "fixture:" + utf8(std::filesystem::u8path(p.str("replyFile")).filename()));
      } else {
        unconfigured = Error("provider_not_configured", "No research provider is configured. Set research.provider in the configuration.");
      }
    } catch (const Error& e) {
      unconfigured = e;
    }
  }
  std::shared_ptr<Retriever> retriever = o.retriever;
  if (!retriever) {
    std::vector<std::string> hosts;
    if (r["retriever"]["allowHosts"].is_array())
      for (const auto& h : r["retriever"]["allowHosts"].as_array()) hosts.push_back(h.as_string());
    retriever = std::make_shared<HttpRetriever>(hosts, r["retriever"]["allowLocalHttp"].is_bool() && r["retriever"]["allowLocalHttp"].as_bool());
  }
  researcher_ = std::make_unique<Researcher>(retriever, forecaster, r.integer("maxEvidenceAgeDays", 14) * 86400, static_cast<unsigned>(r.integer("perCycle", 2)),
                                             static_cast<size_t>(r.integer("perHour", 20)), unconfigured);
  strategy_ = o.strategy ? o.strategy : std::make_shared<JointEdgeStrategy>(JointEdgeStrategy::config_of(config_));
  if (signer)
    executor_ = std::make_unique<Executor>(chain_, signer, journal, client_, shared_, static_cast<int>(config_["schedule"].integer("waitSeconds", 90) * 1000));
}

std::string AgentRunner::wallet() const { return signer ? signer->address() : "paper"; }

std::optional<std::string> AgentRunner::blocked_by() const {
  std::lock_guard<std::mutex> g(shared_->m);
  return shared_->blocked_by;
}

bool AgentRunner::stop_requested() const { return file_exists(shared_->stop_file); }

std::string AgentRunner::state() const {
  if (shared_->stopped) return "stopped";
  if (stop_requested()) return "stopping";
  if (blocked_by()) return "blocked";
  std::lock_guard<std::mutex> g(shared_->m);
  return shared_->flurbo && shared_->flurbo->paused ? "paused" : "running";
}

template <typename F>
auto AgentRunner::api(F f) -> std::optional<decltype(f(std::declval<RuntimeClient&>()))> {
  if (!client_) return std::nullopt;
  try {
    return f(*client_);
  } catch (const Error& e) {
    {
      std::lock_guard<std::mutex> g(shared_->m);
      shared_->last_error = e.api_code.empty() ? e.code : e.api_code;
    }
    if (is_stop(e)) shared_->stop(e.api_code);
    return std::nullopt;
  }
}

void AgentRunner::accept(const Value& p) {
  try {
    FlurboPolicy f = FlurboPolicy::from_json(p);
    std::lock_guard<std::mutex> g(shared_->m);
    shared_->flurbo = f;
    shared_->read_at = shared_->clock();
  } catch (const Error&) {
  }
}

void AgentRunner::refresh_policy() {
  if (auto p = api([](RuntimeClient& c) { return c.policy(); })) accept(*p);
}

void AgentRunner::heartbeat() {
  size_t pending = 0;
  try {
    for (const auto& e : journal->entries()) pending += !is_final(e);
  } catch (const Error&) {
  }
  Policy policy = shared_->policy();
  Value hashed = Value::object();
  hashed.set("mode", config_["mode"]);
  hashed.set("policy", policy.to_json());
  hashed.set("strategy", config_["strategy"]);
  Value windows = Value::array();
  for (const auto& w : policy.windows) windows.push(w.to_json());
  Value summary = Value::object(), pol = Value::object(), sdk = Value::object(), beat = Value::object();
  summary.set("maxTradeCostAtoms", to_string(policy.max_trade_cost_atoms));
  summary.set("windows", windows);
  summary.set("totalAtoms", to_string(policy.total_atoms));
  summary.set("maxPending", static_cast<int64_t>(policy.max_pending));
  std::optional<int64_t> version;
  std::optional<std::string> last_error;
  {
    std::lock_guard<std::mutex> g(shared_->m);
    if (shared_->flurbo) version = shared_->flurbo->version;
    last_error = shared_->last_error;
  }
  pol.set("hash", sha256_hex(hashed.dump()));
  pol.set("flurboVersion", version ? Value(*version) : Value());
  pol.set("summary", summary);
  sdk.set("language", SDK_LANGUAGE);
  sdk.set("version", SDK_VERSION);
  beat.set("runtimeId", runtime_id);
  beat.set("sdk", sdk);
  beat.set("mode", config_["mode"]);
  beat.set("state", state());
  beat.set("policy", pol);
  beat.set("pending", static_cast<int64_t>(pending));
  beat.set("startedAt", started_at_);
  beat.set("lastCycleAt", last_cycle_at_ ? Value(*last_cycle_at_) : Value());
  beat.set("lastErrorCode", last_error ? Value(*last_error) : Value());
  if (auto r = api([&](RuntimeClient& c) { return c.heartbeat(beat); })) accept(*r);
}

// Decisions are reported as self-reported records; failed reports wait in a local outbox.
void AgentRunner::report_decision(const Value& decision) {
  std::string file = path_join(dir_, "outbox.json");
  Value outbox = Value::array();
  if (auto text = read_file(file)) try {
      outbox = json::parse(*text);
    } catch (const Error&) {
    }
  if (!outbox.is_array()) outbox = Value::array();
  outbox.push(decision);
  Value remaining = Value::array();
  for (const auto& item : outbox.as_array()) {
    if (remaining.size() == 0 && api([&](RuntimeClient& c) { return c.decision(item); })) continue;
    remaining.push(item);
  }
  Value keep = Value::array();
  size_t start = remaining.size() > 200 ? remaining.size() - 200 : 0;
  for (size_t i = start; i < remaining.size(); ++i) keep.push(remaining[i]);
  write_file(file, keep.dump());
}

void AgentRunner::market_cycle(const Deployment& d) {
  std::string key = d.namespace_ + d.pool_code_hash;
  if (std::find(verified_.begin(), verified_.end(), key) == verified_.end()) {
    chain_->verify_deployment(d);
    verified_.push_back(key);
  }
  auto detail = api([&](RuntimeClient& c) { return c.market(d.namespace_); });
  if (!detail) return;
  Block head = chain_->block();
  bool resolved = chain_->resolved(d.pool);
  StrategyMarket market{d.pool, d.event_count, !resolved && head.timestamp < static_cast<int64_t>(d.closes_at), resolved, static_cast<int64_t>(d.closes_at), head.hash};
  Value ns = Value::object();
  ns.set("namespace", d.namespace_);
  if (!market.open) return shared_->log("market_closed", ns);
  if (static_cast<int64_t>(d.closes_at) - shared_->now() < config_["policy"].integer("minSecondsBeforeClose")) return shared_->log("too_close_to_close", ns);
  std::vector<PromptEvent> events;
  if ((*detail)["events"].is_array())
    for (const auto& e : (*detail)["events"].as_array()) try {
        events.push_back(PromptEvent::from_json(e));
      } catch (const Error&) {
      }
  for (size_t a = 0; a < events.size(); ++a)
    for (size_t b = a + 1; b < events.size(); ++b) {
      if (blocked_by() || stop_requested()) return;
      decide_pair(d, *detail, events, a, b, market, head);
    }
}

static Value with(const Value& base, std::initializer_list<std::pair<const char*, Value>> extra) {
  Value v = base;
  for (const auto& [k, x] : extra) v.set(k, x);
  return v;
}

static Value strings(const std::vector<std::string>& v) {
  Value a = Value::array();
  for (const auto& x : v) a.push(x);
  return a;
}

void AgentRunner::decide_pair(const Deployment& d, const Value& detail, const std::vector<PromptEvent>& events, size_t a, size_t b, const StrategyMarket& market,
                              const Block& head) {
  unsigned ia = events[a].index, ib = events[b].index;
  std::string decision_id = "d-" + uuid4();
  std::vector<Source> sources;
  for (const auto& e : detail["events"].as_array()) {
    int64_t index = e.integer("index", -1);
    if ((index == ia || index == ib) && e["source"]["referenceUrl"].is_string()) sources.push_back({static_cast<unsigned>(index), e["source"]["referenceUrl"].as_string()});
  }
  const Value& extra = config_["research"]["retriever"]["extraSources"][d.namespace_];
  if (extra.is_array())
    for (const auto& s : extra.as_array())
      if (s.integer("event", -1) == ia || s.integer("event", -1) == ib) sources.push_back({static_cast<unsigned>(s.integer("event")), s.str("url")});
  Value base = Value::object();
  base.set("schema", "flurbo.agent-runtime-decision.v1");
  base.set("decisionId", decision_id);
  base.set("namespace", d.namespace_);
  base.set("createdAt", shared_->now());
  Value pair = Value(json::Array{Value(static_cast<int64_t>(ia)), Value(static_cast<int64_t>(ib))});
  ResearchResult found = researcher_->research(d.pool, detail.str("title"), {events[a], events[b]}, sources, shared_->now(),
                                               config_["research"]["evidenceRequirements"][d.namespace_], d.event_count);
  Provenance provenance = found.provenance.value_or(Provenance{"custom", "unconfigured"});
  if (provenance.kind != "model" && provenance.kind != "fixture" && provenance.kind != "custom") provenance.kind = "custom";
  if (!found.ok) {
    shared_->log("research_abstained", with(Value::object(), {{"namespace", d.namespace_}, {"events", pair}, {"reason", found.reason}}));
    report_decision(with(base, {{"outcome", "abstain"}, {"reasons", strings({found.reason})}, {"provenance", provenance.to_json()}, {"summary", js_slice(found.detail, 600)}}));
    return;
  }
  auto chain = chain_;
  std::string pool = d.pool;
  QuoteFn quote = [chain, pool, head](const std::vector<std::pair<unsigned, unsigned>>& claims, i128 quantity) {
    std::map<std::string, Quote> out;
    for (const auto& [scope, mask] : claims) {
      try {
        auto amount = chain->quote(pool, "buy", scope, mask, static_cast<u128>(std::max<i128>(quantity, 0)), head);
        if (amount && *amount > 0 && static_cast<i128>(*amount) <= quantity) out[claim_key(10143, pool, scope, mask)] = {static_cast<i128>(*amount), head.timestamp + 60, head.hash};
      } catch (const Error&) {
      }
    }
    return out;
  };
  JointForecast forecast{found.output.events, found.output.states_ppm, found.fresh_evidence};
  StrategyDecision decision = strategy_->decide({market, forecast, shared_->now(), quote});
  std::string summary = js_slice(decision.explanation, 600);
  if (decision.outcome != "propose" || !decision.proposal) {
    auto reasons = decision.reasons.empty() ? std::vector<std::string>{"strategy_abstained"} : decision.reasons;
    shared_->log("strategy_abstained", with(Value::object(), {{"namespace", d.namespace_}, {"events", pair}, {"reasons", strings(reasons)}}));
    report_decision(with(base, {{"outcome", "abstain"}, {"reasons", strings(reasons)}, {"provenance", provenance.to_json()}, {"forecast", found.forecast}, {"summary", summary}}));
    return;
  }
  const StrategyProposal& p = *decision.proposal;
  if (p.slippage_bps != 10 && p.slippage_bps != 50 && p.slippage_bps != 100) throw invalid("The strategy chose an unsupported slippage.");
  Value claim = ClaimRef::of(p.scope, p.mask).to_json();
  Value candidate = with(Value::object(), {{"claim", claim},
                                            {"quantityAtoms", to_string(p.quantity_atoms)},
                                            {"quoteAtoms", to_string(p.quote_atoms)},
                                            {"slippageBps", static_cast<int64_t>(p.slippage_bps)},
                                            {"edgeAtoms", p.edge_atoms ? Value(to_string(*p.edge_atoms)) : Value()},
                                            {"edgeBps", p.edge_bps ? Value(static_cast<int64_t>(*p.edge_bps)) : Value()},
                                            {"quoteBlock", std::to_string(head.number)}});
  if (config_.str("mode") == "paper") {
    std::string reason="SEMANTICS_UNAVAILABLE";
    try {
      if(client_) {
        auto assessment=client_->validate_trade(d.namespace_,p.scope,p.mask,to_string(p.quantity_atoms));
        reason=semantic_error(assessment,d,p.scope,p.mask,to_string(p.quantity_atoms),shared_->now());
        if(reason.empty()&&semantics_disabled(assessment)) shared_->log("SEMANTICS_DISABLED",with(Value::object(),{{"namespace",d.namespace_}}));
      }
    } catch (...) {}
    if(!reason.empty()) {
      shared_->log(reason,with(Value::object(),{{"namespace",d.namespace_}}));
      report_decision(with(base,{{"outcome","abstain"},{"reasons",strings({reason})},{"provenance",provenance.to_json()},{"forecast",found.forecast},{"candidate",candidate},{"summary","The purchase did not pass outcome compatibility checks."}}));
      return;
    }
    std::string file = path_join(dir_, "paper.json");
    i128 budget = parse_i128(config_.str("paperBudgetAtoms"));
    std::string skipped = journal->with_lock([&]() -> std::string {
      Value book = Value::object();
      if (auto t = read_file(file)) try {
          book = json::parse(*t);
        } catch (const Error&) {
        }
      Value fills = book["fills"].is_array() ? book["fills"] : Value::array();
      i128 spent = 0;
      for (const auto& f : fills.as_array()) {
        if (f.str("decisionId") == decision_id) return "already_filled";
        if (f["claim"] == claim && f.str("namespace") == d.namespace_ && parse_i128(f.str("snapshotBlock")) >= static_cast<i128>(head.number)) return "same_quote_block";
        spent += parse_i128(f.str("costAtoms"));
      }
      if (spent + p.quote_atoms > budget) return "paper_budget";
      fills.push(with(Value::object(), {{"id", uuid4()},
                                         {"decisionId", decision_id},
                                         {"namespace", d.namespace_},
                                         {"claim", claim},
                                         {"quantityAtoms", to_string(p.quantity_atoms)},
                                         {"costAtoms", to_string(p.quote_atoms)},
                                         {"snapshotBlock", std::to_string(head.number)},
                                         {"filledAt", shared_->now()}}));
      write_file(file, with(Value::object(), {{"schema", "flurbo.agent-paper.v1"}, {"model", "quote-at-snapshot-no-impact-v1"}, {"fills", fills}}).dump(1));
      return "";
    });
    shared_->log(skipped.empty() ? "paper_trade" : "paper_skipped", with(Value::object(), {{"namespace", d.namespace_}, {"claim", claim}}));
    report_decision(with(base, {{"outcome", skipped.empty() ? "paper" : "abstain"},
                                {"reasons", skipped.empty() ? Value::array() : strings({skipped})},
                                {"provenance", provenance.to_json()},
                                {"forecast", found.forecast},
                                {"candidate", candidate},
                                {"summary", summary}}));
    return;
  }
  refresh_policy();
  if (!executor_) throw invalid("Live mode needs a signer.");
  Outcome result = executor_->execute({decision_id, d, "buy", Claim{p.scope, p.mask}, p.quantity_atoms, p.slippage_bps, p.quote_atoms, head});
  Value logged = with(Value::object(), {{"namespace", d.namespace_}, {"status", result.status}});
  if (!result.hash.empty()) logged.set("hash", result.hash);
  if (!result.violations.empty()) logged.set("violations", strings(result.violations));
  shared_->log("execution", logged);
  bool rejected = result.status == "rejected_by_policy" || result.status == "blocked";
  std::vector<std::string> reasons = !result.violations.empty() ? result.violations : result.status == "blocked" ? std::vector<std::string>{result.reason} : std::vector<std::string>{};
  Value report = with(base, {{"outcome", rejected ? "rejected_by_policy" : "trade"},
                             {"reasons", strings(reasons)},
                             {"provenance", provenance.to_json()},
                             {"forecast", found.forecast},
                             {"candidate", candidate},
                             {"summary", summary}});
  if (!result.violations.empty()) report.set("violations", strings(result.violations));
  if (!result.hash.empty()) report.set("execution", with(Value::object(), {{"hash", result.hash}, {"status", result.status}}));
  report_decision(report);
}

void AgentRunner::cycle() {
  researcher_->reset_cycle();
  refresh_policy();
  heartbeat();
  if (executor_) {
    try {
      executor_->reconcile_all();
      executor_->report();
    } catch (const Error& e) {
      shared_->log("reconcile_failed", with(Value::object(), {{"code", e.code}}));
    }
  }
  if (!blocked_by() && !stop_requested() && client_) {
    auto deployments = api([](RuntimeClient& c) { return c.deployments(); }).value_or(std::vector<Deployment>{});
    for (const auto& d : deployments) {
      bool listed = false;
      for (const auto& m : config_["markets"].as_array()) listed = listed || m.as_string() == d.namespace_;
      if (!listed) continue;
      try {
        market_cycle(d);
      } catch (const Error& e) {
        {
          std::lock_guard<std::mutex> g(shared_->m);
          shared_->last_error = e.code;
        }
        shared_->log("market_cycle_failed", with(Value::object(), {{"namespace", d.namespace_}, {"code", e.code}}));
      }
    }
  }
  last_cycle_at_ = shared_->now();
  Value saved = saved_;
  auto blocked = blocked_by();
  std::optional<std::string> last_error;
  {
    std::lock_guard<std::mutex> g(shared_->m);
    last_error = shared_->last_error;
  }
  saved.set("runtimeId", runtime_id);
  saved.set("startedAt", started_at_);
  saved.set("lastCycleAt", *last_cycle_at_);
  saved.set("blockedBy", blocked ? Value(*blocked) : Value());
  saved.set("lastErrorCode", last_error ? Value(*last_error) : Value());
  write_file(path_join(dir_, "runtime.json"), saved.dump(1));
  heartbeat();
}

Value AgentRunner::recover() {
  refresh_policy();
  if (!executor_) return with(Value::object(), {{"reconciled", 0}, {"message", "Paper mode has no transactions to recover."}});
  size_t n = executor_->reconcile_all();
  executor_->report();
  int64_t open = 0;
  for (const auto& e : journal->entries()) open += !is_final(e);
  return with(Value::object(), {{"reconciled", static_cast<int64_t>(n)}, {"open", open}});
}

void AgentRunner::request_stop() { write_file(shared_->stop_file, std::to_string(shared_->now())); }

void AgentRunner::run(bool once) {
  remove_file(shared_->stop_file);
  Value markets = config_["markets"];
  shared_->log("started", with(Value::object(), {{"runtimeId", runtime_id}, {"mode", config_["mode"]}, {"wallet", wallet()}, {"markets", markets}}));
  auto last_beat = std::chrono::steady_clock::now();
  for (;;) {
    cycle();
    if (once || stop_requested()) break;
    auto until = std::chrono::steady_clock::now() + std::chrono::seconds(config_["schedule"].integer("intervalSeconds", 300));
    while (std::chrono::steady_clock::now() < until && !stop_requested()) {
      sleep_ms(500);
      if (std::chrono::steady_clock::now() - last_beat > std::chrono::seconds(config_["schedule"].integer("heartbeatSeconds", 30))) {
        heartbeat();
        last_beat = std::chrono::steady_clock::now();
      }
    }
    if (stop_requested()) break;
  }
  // Every ended run tells Flurbo it stopped, whether it was asked to stop or ran once, so the dashboard
  // never shows a finished runtime as running.
  if (stop_requested()) remove_file(shared_->stop_file);
  shared_->stopped = true;
  heartbeat();
  shared_->stopped = false;
  shared_->log("stopped", with(Value::object(), {{"runtimeId", runtime_id}}));
}

Value AgentRunner::status() {
  Value entries = Value::array();
  if (file_exists(path_join(dir_, "journal.json"))) try {
      entries = journal->read()["entries"];
    } catch (const Error&) {
    }
  Value pending = Value::array(), recent = Value::array();
  const auto& list = entries.as_array();
  for (const auto& e : list)
    if (!is_final(e)) pending.push(with(Value::object(), {{"id", e["id"]}, {"action", e["action"]}, {"status", e["status"]}, {"hash", e["hash"]}}));
  for (size_t i = list.size() > 10 ? list.size() - 10 : 0; i < list.size(); ++i)
    recent.push(with(Value::object(), {{"action", list[i]["action"]}, {"status", list[i]["status"]}, {"hash", list[i]["hash"]}, {"costAtoms", list[i]["costAtoms"]}}));
  int64_t fills = 0;
  if (auto t = read_file(path_join(dir_, "paper.json"))) try {
      fills = static_cast<int64_t>(json::parse(*t)["fills"].size());
    } catch (const Error&) {
    }
  const Value& blocked = saved_["blockedBy"];
  return with(Value::object(), {{"runtimeId", runtime_id},
                                {"mode", config_["mode"]},
                                {"wallet", wallet()},
                                {"stopRequested", stop_requested()},
                                {"locked", file_exists(path_join(dir_, "journal.lock"))},
                                {"pending", pending},
                                {"recent", recent},
                                {"paperFills", fills},
                                {"lastCycleAt", saved_["lastCycleAt"]},
                                {"state", stop_requested() ? "stopping" : !blocked.is_null() ? "blocked" : "ready"},
                                {"blockedBy", blocked},
                                {"lastErrorCode", saved_["lastErrorCode"]}});
}

// ---- command line ----
int cli_main(const std::vector<std::string>& argv, const std::function<void(const std::string&)>& out, const std::function<void(const std::string&)>& err) {
  const std::string usage = "usage: flurbo-agent-cpp <init [--markets A,B]|start [--once]|stop|status|recover|address|sign-message --file F> [--config flurbo-agent.json]";
  try {
    std::string command, config_path = "flurbo-agent.json", file, markets;
    bool has_markets = false;
    bool once = false;
    for (size_t i = 0; i < argv.size(); ++i) {
      const std::string& a = argv[i];
      if (a == "--config" && i + 1 < argv.size()) config_path = argv[++i];
      else if (a == "--file" && i + 1 < argv.size()) file = argv[++i];
      else if (a == "--once") once = true;
      else if (a == "--markets" && i + 1 < argv.size()) { markets = argv[++i]; has_markets = true; }
      else if (command.empty() && (a == "init" || a == "start" || a == "stop" || a == "status" || a == "recover" || a == "address" || a == "sign-message")) command = a;
      else throw invalid(usage);
    }
    if (command.empty()) throw invalid(usage);
    std::string path = utf8(std::filesystem::absolute(std::filesystem::u8path(config_path)));
    auto signer_of = [&] {
      Value c = load_config(path);
      return LocalKeySigner::from_env(c["signer"].str("keyEnv"));
    };
    if (command == "init") {
      if (file_exists(path)) throw Error("conflict", path + " already exists.");
      Value config = default_config();
      std::string names = "pilot";
      if (has_markets) {
        auto namespace_ok = [](const std::string& s) {
          return s == "pilot" || (s.size() == 49 && s.rfind("practice-", 0) == 0
            && std::all_of(s.begin() + 9, s.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }));
        };
        Value list = Value::array();
        names.clear();
        size_t start = 0;
        while (start <= markets.size()) {
          size_t end = markets.find(',', start);
          std::string m = markets.substr(start, end == std::string::npos ? std::string::npos : end - start);
          m.erase(0, m.find_first_not_of(' '));
          m.erase(m.find_last_not_of(' ') + 1);
          if (!m.empty()) {
            if (!namespace_ok(m)) throw invalid("Pass --markets as the comma separated market names shown on the agent page: pilot, or practice- followed by the pool address without 0x.");
            list.push(m);
            names += (names.empty() ? "" : ", ") + m;
          }
          if (end == std::string::npos) break;
          start = end + 1;
        }
        if (names.empty()) throw invalid("Pass --markets as the comma separated market names shown on the agent page: pilot, or practice- followed by the pool address without 0x.");
        config.set("markets", list);
        config.get_or_add("policy").set("markets", list);
        parse_config(config);
      }
      write_file(path, config.dump(2) + "\n");
      out("Wrote " + path + " (paper mode, markets " + names + "). Set FLURBO_AGENT_TOKEN, and FLURBO_AGENT_PRIVATE_KEY for live mode, in your environment. Never put them in the file.");
    } else if (command == "start") {
      AgentRunner(load_config(path)).run(once);
    } else if (command == "stop") {
      Value c = load_config(path);
      c.set("mode", "paper");
      AgentRunner(c).request_stop();
      out("Stop requested. A running agent stops after its current step.");
    } else if (command == "status") {
      out(AgentRunner(load_config(path)).status().dump(2));
    } else if (command == "recover") {
      out(AgentRunner(load_config(path)).recover().dump(2));
    } else if (command == "address") {
      out(signer_of()->address());
    } else if (command == "sign-message") {
      if (file.empty()) throw invalid("Pass --file with the association message copied from the agent page.");
      auto raw = read_file(file);
      if (!raw) throw invalid("The message file could not be read.");
      std::string message;
      for (size_t i = 0; i < raw->size(); ++i)
        if (!((*raw)[i] == '\r' && i + 1 < raw->size() && (*raw)[i + 1] == '\n')) message += (*raw)[i];
      while (!message.empty() && message.back() == '\n') message.pop_back();
      if (message.rfind("Flurbo agent wallet association\n", 0) != 0) throw invalid("This is not a Flurbo agent wallet association message.");
      auto signer = signer_of();
      if (message.find("Agent wallet: " + signer->address() + "\n") == std::string::npos) throw invalid("The message is for a different wallet than " + signer->address() + ".");
      out(signer->sign_message(message));
    }
    return 0;
  } catch (const Error& e) {
    err(e.code + ": " + e.what());
    return 1;
  } catch (const std::exception&) {
    err("Unexpected error. Nothing new was sent.");
    return 1;
  }
}

}  // namespace flurbo
