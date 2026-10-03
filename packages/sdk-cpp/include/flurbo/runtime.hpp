// The runtime on the operator's own machine: HTTP and JSON-RPC clients, chain reads, the headless API client,
// the journal, execution and recovery, research adapters, the agent loop and the command line. It never
// uploads keys, prints secrets or runs anything on Flurbo's servers.
#pragma once

#include <atomic>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "flurbo/core.hpp"
#include "flurbo/crypto.hpp"
#include "flurbo/policy.hpp"
#include "flurbo/research.hpp"

namespace flurbo {

// ---- HTTP (plain HTTP to this machine, HTTPS with certificate and host verification elsewhere) ----
using Headers = std::vector<std::pair<std::string, std::string>>;
struct HttpRequest {
  std::string method = "GET", url;
  Headers headers;
  std::string body;
  int timeout_ms = 20000;
  size_t max_body = 8 * 1024 * 1024;
};
struct HttpResponse {
  int status = 0;
  Headers headers;
  std::string body;
  std::optional<std::string> header(const std::string& name) const;
};
struct Url {
  std::string scheme, host, port, path, origin;
  bool userinfo = false;
};
std::optional<Url> parse_url(const std::string& url);
bool is_loopback(const std::string& host);
std::string join_url(const std::string& base, const std::string& location);
std::string url_segment(const std::string& s);
// Throws Error("timeout") or Error("network") with a safe message; never follows redirects.
HttpResponse http_request(const HttpRequest& request);
HttpResponse capacity_http_request(const HttpRequest& request, bool rpc = false);

namespace net {  // minimal sockets, for the local test servers
int listen_local(int& port);
int accept_one(int listener);
std::string read_request(int socket);
void write_all(int socket, const std::string& data);
void close_socket(int socket);
}  // namespace net

// ---- JSON-RPC to the operator's own chain endpoint ----
class Rpc {
 public:
  virtual ~Rpc() = default;
  virtual json::Value call(const std::string& method, const json::Value& params) = 0;
};
class JsonRpc : public Rpc {
 public:
  JsonRpc(const std::string& url, int timeout_ms = 15000);
  json::Value call(const std::string& method, const json::Value& params) override;

 private:
  std::string url_;
  int timeout_ms_;
  std::atomic<uint64_t> ids_{1};
};
u128 hex_u128(const json::Value& v);
std::string hex_of(u128 n);

struct Block {
  uint64_t number = 0;
  std::string hash;
  int64_t timestamp = 0;
};
struct Receipt {
  int status = 0;
  uint64_t block_number = 0;
  std::string block_hash;
  u128 gas_used = 0;
  std::optional<u128> effective_gas_price;
  std::vector<Log> logs;
};
struct Fees {
  u128 max_fee_per_gas = 0, max_priority_fee_per_gas = 0;
};

class ChainReader {
 public:
  explicit ChainReader(std::shared_ptr<Rpc> rpc) : rpc_(std::move(rpc)) {}
  Block block(std::optional<uint64_t> number = std::nullopt);
  uint64_t chain_id();
  // protocol/specs/contracts.md: every check before trading on a deployment.
  void verify_deployment(const Deployment& d);
  // Nothing when the pool refuses to quote this claim at this size.
  std::optional<u128> quote(const std::string& pool, const std::string& side, unsigned scope, unsigned mask, u128 quantity, const Block& at);
  bool resolved(const std::string& pool);
  u128 holdings(const std::string& pool, const std::string& owner, unsigned scope, unsigned mask);
  U256 allowance(const std::string& owner, const std::string& spender, const std::string& tag = "latest");
  u128 native_balance(const std::string& owner);
  uint64_t nonce(const std::string& owner, const std::string& tag);
  json::Value simulate(const std::string& from, const std::string& to, const std::string& data);
  u128 estimate_gas(const std::string& from, const std::string& to, const std::string& data);
  Fees fees();
  json::Value send_raw(const std::string& raw);
  bool transaction_found(const std::string& hash);
  std::optional<Receipt> receipt(const std::string& hash);
  Rpc& rpc() { return *rpc_; }

 private:
  std::shared_ptr<Rpc> rpc_;
  U256 word(const std::string& to, const std::string& data, const std::string& tag);
  u128 small(const std::string& to, const std::string& data, const std::string& tag);
};

// ---- the Flurbo agent runtime API (credential only in the Authorization header) ----
bool token_ok(const std::string& token);
bool is_stop(const Error& e);
std::string semantic_error(const json::Value& result, const Deployment& deployment, unsigned scope, unsigned mask, const std::string& quantity, int64_t now);
// Only meaningful after semantic_error returned "": checks are switched off, so nothing was verified.
bool semantics_disabled(const json::Value& result);
class RuntimeClient {
 public:
  RuntimeClient(const std::string& base_url, const std::string& token);
  json::Value session();
  std::vector<Deployment> deployments();
  json::Value market(const std::string& ns);
  json::Value validate_trade(const std::string& ns, unsigned scope, unsigned mask, const std::string& quantity);
  json::Value policy();
  json::Value heartbeat(const json::Value& beat);
  json::Value decision(const json::Value& d);
  json::Value report_execution(const json::Value& r);
  json::Value execution(const std::string& hash);
  std::string describe() const { return "RuntimeClient(" + origin_ + ")"; }

 private:
  std::string origin_, token_;
  json::Value call(const std::string& method, const std::string& path, const std::optional<json::Value>& body);
};

// ---- journal (same format and lock file as the TypeScript, Python and Rust runtimes) ----
std::string hostname();
json::Value owner();
bool is_final(const json::Value& entry);
std::vector<PolicyEntry> policy_entries(const json::Value& journal);
class FileJournal {
 public:
  FileJournal(const std::string& dir, const std::string& wallet);
  json::Value read() const;
  // A copy of the entries, safe to iterate after the call.
  json::Array entries() const { return read()["entries"].as_array(); }
  // Runs f on the journal under the lock; if it returns normally the journal is written atomically.
  template <typename F>
  auto locked(F f) -> decltype(f(std::declval<json::Value&>())) {
    Held held(*this);
    json::Value j = read();
    if constexpr (std::is_void_v<decltype(f(j))>) {
      f(j);
      write(j);
    } else {
      auto r = f(j);
      write(j);
      return r;
    }
  }
  template <typename F>
  auto with_lock(F f) -> decltype(f()) {
    Held held(*this);
    return f();
  }
  std::string dir, wallet, file, lock_file;
  int lock_timeout_ms = 20000, stale_ms = 30000;

 private:
  struct Held {
    explicit Held(const FileJournal& j);
    ~Held();
    const FileJournal& j;
  };
  void write(const json::Value& j) const;
  void acquire() const;
  void release() const;
};

// ---- execution ----
constexpr const char* SDK_LANGUAGE = "cpp";
constexpr const char* SDK_VERSION = "0.2.0";

// What the executor asks its runner.
class Controls {
 public:
  virtual ~Controls() = default;
  virtual Policy policy() = 0;
  virtual std::pair<bool, std::string> live_allowed() = 0;
  virtual int64_t now() = 0;
  virtual void log(const std::string& event, const json::Value& detail) = 0;
  virtual void stop(const std::string& code) = 0;
};
class FixedControls : public Controls {
 public:
  FixedControls(Policy p, bool allowed) : policy_(std::move(p)), allowed_(allowed) {}
  Policy policy() override { return policy_; }
  std::pair<bool, std::string> live_allowed() override { return {allowed_, allowed_ ? "" : "blocked"}; }
  int64_t now() override { return now_seconds(); }
  void log(const std::string&, const json::Value&) override {}
  void stop(const std::string&) override {}

 private:
  Policy policy_;
  bool allowed_;
};

struct Planned {
  std::string status;  // planned, rejected_by_policy or simulation_failed
  json::Value entry;
  std::vector<std::string> violations;
  std::string detail;
};
struct Outcome {
  std::string status, reason;
  std::vector<std::string> violations;
  std::string entry_id, hash;
  std::optional<std::string> cost_atoms;
};
struct ExecutionRequest {
  std::string decision_id;
  Deployment deployment;
  std::string action;  // buy, sell or redeem
  Claim claim;
  i128 quantity_atoms = 0, slippage_bps = 0, quote_atoms = 0;
  Block quote_block;
};

class Executor {
 public:
  Executor(std::shared_ptr<ChainReader> chain, std::shared_ptr<Signer> signer, std::shared_ptr<FileJournal> journal, std::shared_ptr<RuntimeClient> client,
           std::shared_ptr<Controls> controls, int wait_ms = 60000);
  Planned plan(const Deployment& d, const Intent& intent, const std::string& decision_id, const std::optional<Block>& quote_block, int64_t slippage_bps);
  std::optional<json::Value> sign(const std::string& entry_id, const Deployment& d);
  void broadcast(const json::Value& entry);
  std::optional<json::Value> reconcile_entry(const std::string& entry_id);
  size_t reconcile_all();
  void report();
  std::optional<json::Value> wait_for(const std::string& entry_id);
  Outcome execute(const ExecutionRequest& request);
  int poll_ms = 1000;
  std::string wallet;

 private:
  std::shared_ptr<ChainReader> chain_;
  std::shared_ptr<Signer> signer_;
  std::shared_ptr<FileJournal> journal_;
  std::shared_ptr<RuntimeClient> client_;
  std::shared_ptr<Controls> controls_;
  int wait_ms_;
  std::string semantic_check(const Deployment& d, const Claim& claim, i128 quantity);
  Outcome run(const Deployment& d, const Intent& intent, const std::string& decision_id, const std::optional<Block>& quote_block, int64_t slippage_bps);
  std::vector<std::string> precheck(const Deployment& d, const Claim& c, i128 quantity, i128 limit, const Block& quote_block, i128 slippage_bps);
};

// ---- research on the operator's machine ----
struct Source {
  unsigned event = 0;
  std::string url;
};
class Retriever {
 public:
  virtual ~Retriever() = default;
  virtual std::vector<Evidence> retrieve(const std::vector<Source>& sources, int64_t now) = 0;
};
class Forecaster {
 public:
  virtual ~Forecaster() = default;
  // "model", "fixture" or "custom". A fixture or custom rule is never reported as a model.
  virtual std::string kind() const = 0;
  virtual std::string name() const = 0;
  // Throws Error with code provider_not_configured, provider_unavailable, rate_limited, timeout or malformed_output.
  virtual std::string complete(const Prompt& prompt) = 0;
};
std::string extract_text(const std::string& body, const std::string& content_type);
class HttpRetriever : public Retriever {
 public:
  HttpRetriever(std::vector<std::string> allow_hosts, bool allow_local_http);
  std::vector<Evidence> retrieve(const std::vector<Source>& sources, int64_t now) override;

 private:
  std::vector<std::string> allow_;
  bool local_;
  bool allowed(const std::string& url) const;
};
class FixtureRetriever : public Retriever {
 public:
  explicit FixtureRetriever(std::vector<Evidence> records) : records_(std::move(records)) {}
  std::vector<Evidence> retrieve(const std::vector<Source>&, int64_t now) override;

 private:
  std::vector<Evidence> records_;
};
class OpenAiCompatible : public Forecaster {
 public:
  OpenAiCompatible(const std::string& base_url, std::string model, std::optional<std::string> api_key, int timeout_ms = 60000, int max_retries = 2);
  std::string kind() const override { return "model"; }
  std::string name() const override { return name_; }
  std::string complete(const Prompt& prompt) override;

 private:
  std::string base_, model_, name_;
  std::optional<std::string> key_;
  int timeout_ms_, max_retries_;
};
class AnthropicMessages : public Forecaster {
 public:
  AnthropicMessages(std::string model, std::optional<std::string> api_key, int timeout_ms = 60000, int max_retries = 2,
                    std::string base_url = "https://api.anthropic.com/");
  std::string kind() const override { return "model"; }
  std::string name() const override { return "anthropic/" + model_; }
  std::string complete(const Prompt& prompt) override;

 private:
  std::string model_, key_, base_;
  int timeout_ms_, max_retries_;
};
class FixtureForecaster : public Forecaster {
 public:
  FixtureForecaster(std::function<std::string(const Prompt&)> reply, std::string name) : reply_(std::move(reply)), name_(std::move(name)) {}
  static std::shared_ptr<FixtureForecaster> fixed(const std::string& reply, const std::string& name) {
    return std::make_shared<FixtureForecaster>([reply](const Prompt&) { return reply; }, name);
  }
  std::string kind() const override { return "fixture"; }
  std::string name() const override { return name_; }
  std::string complete(const Prompt& p) override { return reply_(p); }

 private:
  std::function<std::string(const Prompt&)> reply_;
  std::string name_;
};

struct ResearchResult {
  bool ok = false;
  ModelOutput output;
  unsigned fresh_evidence = 0;
  json::Value forecast;
  std::vector<Evidence> evidence;
  std::optional<Provenance> provenance;
  std::string reason, detail, model_reason;
};
// Request budgets: per cycle (reset by the runner) and per rolling hour, counted in this process.
class Researcher {
 public:
  // A null forecaster means no provider is configured: every call abstains with `unconfigured`.
  Researcher(std::shared_ptr<Retriever> retriever, std::shared_ptr<Forecaster> forecaster, int64_t max_age, unsigned per_cycle, size_t per_hour,
             std::optional<Error> unconfigured = std::nullopt);
  void reset_cycle();
  ResearchResult research(const std::string& pool, const std::string& title, const std::vector<PromptEvent>& events, const std::vector<Source>& sources, int64_t now,
                          const json::Value& requirements = json::Value(), unsigned event_count = 4);

 private:
  std::shared_ptr<Retriever> retriever_;
  std::shared_ptr<Forecaster> forecaster_;
  int64_t max_age_;
  unsigned per_cycle_;
  size_t per_hour_;
  std::optional<Error> unconfigured_;
  std::mutex m_;
  unsigned cycle_ = 0;
  std::vector<int64_t> hour_;
};

// ---- strategies ----
using QuoteFn = std::function<std::map<std::string, Quote>(const std::vector<std::pair<unsigned, unsigned>>&, i128)>;
struct StrategyContext {
  const StrategyMarket& market;
  const JointForecast& forecast;
  int64_t now;
  const QuoteFn& quote;
};
struct StrategyProposal {
  unsigned scope = 0, mask = 0;
  i128 quantity_atoms = 0, quote_atoms = 0, slippage_bps = 0;
  std::optional<i128> edge_atoms, edge_bps;
};
struct StrategyDecision {
  std::string outcome;  // propose or abstain
  std::vector<std::string> reasons;
  std::string explanation;
  std::optional<StrategyProposal> proposal;
  static StrategyDecision abstain(const std::string& reason, const std::string& explanation) { return {"abstain", {reason}, explanation, std::nullopt}; }
};
class Strategy {
 public:
  virtual ~Strategy() = default;
  virtual std::string id() const = 0;
  virtual std::string version() const = 0;
  virtual StrategyDecision decide(const StrategyContext& ctx) = 0;
};
class JointEdgeStrategy : public Strategy {
 public:
  explicit JointEdgeStrategy(StrategyConfig c) : config(c) {}
  static StrategyConfig config_of(const json::Value& agent_config);
  std::string id() const override { return STRATEGY_ID; }
  std::string version() const override { return STRATEGY_VERSION; }
  StrategyDecision decide(const StrategyContext& ctx) override;
  StrategyConfig config;
};

// ---- configuration (flurbo.agent-config.v1) and the agent loop ----
json::Value default_config();
// Validates the configuration. Secrets are never in it: it names the environment variables that hold them.
json::Value parse_config(const json::Value& c);
// Reads a configuration file; the state directory is resolved next to it.
json::Value load_config(const std::string& path);

using LogFn = std::function<void(const std::string&, const json::Value&)>;
struct RunnerOptions {
  std::optional<std::map<std::string, std::string>> env;
  std::shared_ptr<RuntimeClient> client;
  std::shared_ptr<ChainReader> chain;
  std::shared_ptr<Signer> signer;
  std::shared_ptr<Retriever> retriever;
  std::shared_ptr<Forecaster> forecaster;
  std::shared_ptr<Strategy> strategy;
  LogFn log;
  std::function<int64_t()> now;
};

class AgentRunner {
 public:
  AgentRunner(json::Value config, RunnerOptions options = {});
  void cycle();
  void run(bool once);
  json::Value recover();
  void request_stop();
  json::Value status();
  void heartbeat();
  void refresh_policy();
  std::string wallet() const;
  std::optional<std::string> blocked_by() const;
  std::shared_ptr<Signer> signer;
  std::shared_ptr<FileJournal> journal;
  std::string runtime_id;

 private:
  struct Shared;
  std::shared_ptr<Shared> shared_;
  json::Value config_, saved_;
  std::string dir_;
  std::shared_ptr<RuntimeClient> client_;
  std::shared_ptr<ChainReader> chain_;
  std::unique_ptr<Researcher> researcher_;
  std::shared_ptr<Strategy> strategy_;
  std::unique_ptr<Executor> executor_;
  int64_t started_at_ = 0;
  std::optional<int64_t> last_cycle_at_;
  std::vector<std::string> verified_;
  template <typename F>
  auto api(F f) -> std::optional<decltype(f(std::declval<RuntimeClient&>()))>;
  void accept(const json::Value& p);
  void report_decision(const json::Value& d);
  void market_cycle(const Deployment& d);
  void decide_pair(const Deployment& d, const json::Value& detail, const std::vector<PromptEvent>& events, size_t a, size_t b, const StrategyMarket& m, const Block& head);
  bool stop_requested() const;
  std::string state() const;
};

// The command line: returns the process exit code.
int cli_main(const std::vector<std::string>& argv, const std::function<void(const std::string&)>& out, const std::function<void(const std::string&)>& err);

// Portable helpers.
void set_env(const std::string& name, const std::string& value);
void unset_env(const std::string& name);
std::optional<std::string> get_env(const std::string& name);
void sleep_ms(int ms);
unsigned process_id();
bool file_exists(const std::string& path);
std::optional<std::string> read_file(const std::string& path);
void write_file(const std::string& path, const std::string& data);
void remove_file(const std::string& path);
void make_dirs(const std::string& path);
std::string path_join(const std::string& a, const std::string& b);
std::string utf8(const std::filesystem::path& p);

}  // namespace flurbo
