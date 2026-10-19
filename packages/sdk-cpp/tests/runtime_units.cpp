// Runtime pieces that need no chain: retrieval allowlist, model providers, request budgets, the headless
// client, the journal lock across separate processes, the signer and the command line.
#include <atomic>
#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <thread>

#include "check.hpp"
#include "flurbo/runtime.hpp"

using namespace flurbo;
using json::Value;

static const std::string TOKEN = "fla1_0123456789abcdef_" + std::string(43, 'A');
static const std::string NS = "practice-" + std::string(40, '2');
// The default configuration names no market; unit fixtures use the grammar-valid token pilot.
static Value configured() {
  Value c = default_config(), markets = Value::array();
  markets.push("pilot");
  c.set("markets", markets);
  c.get_or_add("policy").set("markets", markets);
  return c;
}
static std::string self_path;

struct Call {
  std::string path;
  std::map<std::string, std::string> headers;
};

// A local HTTP/1.1 server whose handler is a function (path, call number) -> (status, headers, body).
class Server {
 public:
  using Respond = std::function<std::tuple<int, Headers, std::string>(const std::string&, int)>;
  explicit Server(Respond respond) : respond_(std::move(respond)) {
    listener_ = net::listen_local(port_);
    url = "http://127.0.0.1:" + std::to_string(port_);
    thread_ = std::thread([this] {
      for (;;) {
        int s = net::accept_one(listener_);
        if (stopping_ || s < 0) {
          if (s >= 0) net::close_socket(s);
          return;
        }
        std::string raw = net::read_request(s);
        Call c;
        size_t sp1 = raw.find(' '), sp2 = raw.find(' ', sp1 + 1);
        c.path = raw.substr(sp1 + 1, sp2 - sp1 - 1);
        size_t head_end = raw.find("\r\n\r\n");
        for (size_t at = raw.find("\r\n"); at != std::string::npos && at < head_end;) {
          size_t next = raw.find("\r\n", at + 2);
          std::string line = raw.substr(at + 2, next - at - 2);
          auto colon = line.find(':');
          if (colon != std::string::npos) c.headers[lower(trim(line.substr(0, colon)))] = trim(line.substr(colon + 1));
          at = next;
        }
        int n;
        {
          std::lock_guard<std::mutex> g(m_);
          calls_.push_back(c);
          n = static_cast<int>(calls_.size());
        }
        auto [status, headers, body] = respond_(c.path, n);
        bool framed = std::any_of(headers.begin(), headers.end(), [](const auto& h) { return lower(h.first) == "content-length" || lower(h.first) == "transfer-encoding"; });
        std::string out = "HTTP/1.1 " + std::to_string(status) + " X\r\n" + (framed ? "" : "Content-Length: " + std::to_string(body.size()) + "\r\n") + "Connection: close\r\n";
        for (const auto& [k, v] : headers) out += k + ": " + v + "\r\n";
        try { net::write_all(s, out + "\r\n" + body); } catch (...) { /* Rejected captures can close the connection early. */ }
        net::close_socket(s);
      }
    });
  }
  ~Server() {
    stopping_ = true;
    try {
      http_request({"GET", url + "/stop", {}, "", 2000});
    } catch (...) {
    }
    thread_.join();
    net::close_socket(listener_);
  }
  std::vector<Call> calls() {
    std::lock_guard<std::mutex> g(m_);
    return calls_;
  }
  std::string url;

 private:
  Respond respond_;
  int listener_ = -1, port_ = 0;
  std::atomic<bool> stopping_{false};
  std::thread thread_;
  std::mutex m_;
  std::vector<Call> calls_;
};

static std::string message_of(const std::function<void()>& f) {
  try {
    f();
  } catch (const Error& e) {
    return e.code + ": " + e.what();
  }
  return "";
}

static Prompt prompt() { return {"s", "u"}; }

TEST(retrieval_allowlist_redirects_and_text) {
  Server server([](const std::string& path, int) -> std::tuple<int, Headers, std::string> {
    if (path == "/redirect") return {302, {{"Location", "https://evil.example/page"}}, ""};
    return {200, {{"Content-Type", "text/html"}, {"Last-Modified", "Sat, 26 Sep 2026 10:00:00 GMT"}},
            "<html><title>Release 1.0</title><script>steal()</script><p>Tagged &amp; released</p></html>"};
  });
  HttpRetriever local({}, true);
  auto got = local.retrieve({{0, server.url + "/a"}, {0, server.url + "/redirect"}}, 1790000000);
  CHECK_EQ(got.size(), size_t{1});  // a redirect to another host is never followed
  if (!got.empty()) {
    CHECK_EQ(got[0].id, std::string("src-1"));
    CHECK_EQ(got[0].title.value_or(""), std::string("Release 1.0"));
    CHECK_EQ(got[0].excerpt, std::string("Release 1.0 Tagged & released"));
    CHECK(!got[0].publisher_released_at);
    CHECK(got[0].http_last_modified == std::optional<int64_t>(1790416800));
    CHECK_EQ(got[0].schema, std::string(EVIDENCE_SCHEMA));
    CHECK(got[0].complete_document && got[0].captured_bytes > 0);
    CHECK(got[0].event_ids == std::vector<unsigned>{0});
  }
  CHECK(HttpRetriever({}, false).retrieve({{0, server.url + "/a"}}, 0).empty());  // plain HTTP only when allowed
  CHECK(HttpRetriever({"allowed.example"}, false).retrieve({{0, "https://other.example/x"}}, 0).empty());
  for (const auto& c : server.calls()) CHECK(c.path.find("evil") == std::string::npos);
  CHECK_EQ(extract_text("<style>x{}</style><b>a</b>  b", "text/html"), std::string("a b"));
}

TEST(retrieval_rejects_partial_empty_and_oversized_bodies) {
  Server server([](const std::string& path, int) -> std::tuple<int, Headers, std::string> {
    Headers type = {{"Content-Type", "text/plain"}};
    if (path == "/empty") return {200, type, ""};
    if (path == "/blank") return {200, type, "   "};
    if (path == "/oversize") return {200, type, std::string(2000001, 'x')};
    if (path == "/partial") return {206, type, "abc"};
    if (path == "/range") return {200, {{"Content-Type", "text/plain"}, {"Content-Range", "bytes 0-2/100"}}, "abc"};
    if (path == "/short") return {200, {{"Content-Type", "text/plain"}, {"Content-Length", "20"}}, "abc"};
    if (path == "/chunk-broken") return {200, {{"Content-Type", "text/plain"}, {"Transfer-Encoding", "chunked"}}, "3\r\nabc\r\n"};
    if (path == "/chunk-short") return {200, {{"Content-Type", "text/plain"}, {"Transfer-Encoding", "chunked"}}, "9\r\nabc\r\n0\r\n\r\n"};
    if (path == "/chunk-ok") return {200, {{"Content-Type", "text/plain"}, {"Transfer-Encoding", "chunked"}}, "3\r\nabc\r\n3\r\ndef\r\n0\r\n\r\n"};
    if (path == "/redirect-ok") return {302, {{"Location", "/chunk-ok"}}, ""};
    return {200, type, "abc"};
  });
  HttpRetriever retriever({}, true);
  for (const auto& path : {"/empty", "/blank", "/oversize", "/partial", "/range", "/short", "/chunk-broken", "/chunk-short"})
    CHECK(retriever.retrieve({{0, server.url + path}}, 1790000000).empty());
  auto records = retriever.retrieve({{1, server.url + "/redirect-ok"}}, 1790000000);
  CHECK_EQ(records.size(), size_t{1});
  if (!records.empty()) {
    CHECK_EQ(records[0].requested_url, server.url + "/redirect-ok"); CHECK_EQ(records[0].final_url, server.url + "/chunk-ok");
    CHECK_EQ(records[0].url, records[0].final_url); CHECK_EQ(records[0].captured_bytes, int64_t{6});
    CHECK_EQ(records[0].content_sha256, sha256_hex("abcdef")); CHECK(records[0].event_ids == std::vector<unsigned>{1});
  }
}

TEST(providers_configuration_retries_limits_and_wire_formats) {
  CHECK(message_of([] { OpenAiCompatible("https://api.example/v1", "m", std::nullopt); }).rfind("provider_not_configured", 0) == 0);
  CHECK(message_of([] { AnthropicMessages("m", std::nullopt); }).rfind("provider_not_configured", 0) == 0);
  CHECK_THROWS(OpenAiCompatible("http://api.example/v1", "m", std::string("k")));
  {
    Server server([](const std::string&, int n) -> std::tuple<int, Headers, std::string> {
      if (n < 3) return {503, {{"Retry-After", "0"}}, "{}"};
      return {200, {{"Content-Type", "application/json"}}, R"({"choices":[{"message":{"content":"{\"x\":1}"}}]})"};
    });
    OpenAiCompatible p(server.url + "/v1", "m", std::string("sk-secret"), 5000, 2);
    CHECK_EQ(p.complete(prompt()), std::string("{\"x\":1}"));
    auto calls = server.calls();
    CHECK_EQ(calls.size(), size_t{3});
    for (auto c : calls) {
      CHECK(c.path == "/v1/chat/completions");
      CHECK_EQ(c.headers["authorization"], std::string("Bearer sk-secret"));
    }
  }
  {
    Server limited([](const std::string&, int) -> std::tuple<int, Headers, std::string> { return {429, {{"Retry-After", "0"}}, R"({"error":{"message":"key sk-secret over quota"}})"}; });
    std::string m = message_of([&] { OpenAiCompatible(limited.url + "/v1", "m", std::string("sk-secret"), 5000, 1).complete(prompt()); });
    CHECK(m.rfind("rate_limited", 0) == 0);
    CHECK(m.find("sk-secret") == std::string::npos);
    CHECK_EQ(limited.calls().size(), size_t{2});
  }
  {
    Server anthropic([](const std::string&, int) -> std::tuple<int, Headers, std::string> { return {200, {{"Content-Type", "application/json"}}, R"({"content":[{"type":"text","text":"hello"}]})"}; });
    AnthropicMessages a("m", std::string("k2"), 5000, 2, anthropic.url);
    CHECK_EQ(a.complete(prompt()), std::string("hello"));
    auto c = anthropic.calls()[0];
    CHECK_EQ(c.path, std::string("/v1/messages"));
    CHECK_EQ(c.headers["x-api-key"], std::string("k2"));
  }
}

static std::vector<Evidence> evidence() {
  Evidence e;
  e.schema = EVIDENCE_SCHEMA; e.complete_document = true; e.captured_bytes = 1; e.event_ids = {0, 1};
  e.publisher_released_at = 1790000000 - 60;
  e.id = "src-1";
  e.url = "https://example.org/x";
  e.requested_url = e.url; e.final_url = e.url;
  e.title = "x source";
  e.publisher = "example.org";
  e.content_sha256 = std::string(64, '0');
  e.excerpt = "t";
  return {e};
}

TEST(research_budgets) {
  std::string good = R"({"schema":"flurbo.agent-model-forecast.v1","abstain":false,"abstainReason":null,"events":[0,1],"statesPpm":[250000,250000,250000,250000],)"
                     R"("evidenceIds":["src-1"],"assumptions":[],"uncertainty":"Unknown.","explanation":"Evenly uncertain about both."})";
  auto calls = std::make_shared<int>(0);
  auto f = std::make_shared<FixtureForecaster>([good, calls](const Prompt&) {
    ++*calls;
    return good;
  }, "fixture");
  Researcher r(std::make_shared<FixtureRetriever>(evidence()), f, 86400, 1, 2);
  std::vector<PromptEvent> events = {{0, "q", "y", "n", 1800000000}, {1, "q", "y", "n", 1800000000}};
  auto run = [&] { return r.research("0x" + std::string(40, '1'), "t", events, {}, 1790000000); };
  ResearchResult first = run();
  CHECK(first.ok);
  CHECK_EQ(first.forecast["source"].str("kind"), std::string("fixture"));
  CHECK_EQ(first.provenance->kind, std::string("fixture"));  // a fixture is never labelled as a model
  CHECK_EQ(run().reason, std::string("request_budget_exhausted"));
  CHECK_EQ(*calls, 1);
  r.reset_cycle();
  run();
  r.reset_cycle();
  CHECK_EQ(run().reason, std::string("request_budget_exhausted"));  // the hourly budget holds across cycles
  CHECK_EQ(*calls, 2);
  Researcher none(std::make_shared<FixtureRetriever>(std::vector<Evidence>{}), nullptr, 1, 1, 1, Error("provider_not_configured", "No provider."));
  CHECK_EQ(none.research("0x", "t", events, {}, 0).reason, std::string("provider_not_configured"));
}

TEST(research_requires_explicit_background_and_per_event_coverage) {
  auto calls = std::make_shared<int>(0);
  auto f = std::make_shared<FixtureForecaster>([calls](const Prompt&) { ++*calls; return std::string("{}"); }, "fixture");
  auto records = evidence(); records[0].publisher_released_at.reset();
  Researcher r(std::make_shared<FixtureRetriever>(records), f, 86400, 10, 10);
  std::vector<PromptEvent> events = {{0,"q","y","n",1800000000},{1,"q","y","n",1800000000}};
  CHECK_EQ(r.research("0x", "fixture", events, {}, 1790000000).reason, std::string("stale_evidence")); CHECK_EQ(*calls, 0);
  auto background = json::parse(R"([{"event":0,"freshness":"background"},{"event":1,"freshness":"background"}])");
  CHECK_EQ(r.research("0x", "fixture", events, {}, 1790000000, background).reason, std::string("malformed_output")); CHECK_EQ(*calls, 1);
  records[0].event_ids = {0}; records[0].publisher_released_at = 1789999990;
  Researcher missing(std::make_shared<FixtureRetriever>(records), f, 86400, 10, 10);
  CHECK_EQ(missing.research("0x", "fixture", events, {}, 1790000000).reason, std::string("missing_event_evidence")); CHECK_EQ(*calls, 1);
  auto record = evidence()[0]; record.retrieved_at = 1790000000; record.publisher_released_at.reset();
  CHECK(!evidence_observed_at(record, {0, 1}));
  CHECK(evidence_observed_at(record, {0, 1}, background) == std::optional<int64_t>(1790000000));
  CHECK(!evidence_observed_at(record, {0, 1}, json::parse(R"([{"event":0,"freshness":"background"}])")));
  record.publisher_released_at = 1789999990; record.event_ids = {2};
  CHECK(!evidence_observed_at(record, {0, 1}, background));
}

TEST(transport_budget_counts_across_requests) {
  Server ok([](const std::string&, int) -> std::tuple<int, Headers, std::string> {return {200,{},"{}"};});
  HttpRequest request{"GET",ok.url,{},"",1000};
  for(int i=0;i<100;i++)CHECK_EQ(capacity_http_request(request).status,200);
  CHECK(message_of([&]{capacity_http_request(request);}).find("cooldown")!=std::string::npos);
  CHECK_EQ(ok.calls().size(),size_t{100});
}

TEST(transport_cooldown_blocks_another_request) {
  Server limited([](const std::string&, int) -> std::tuple<int, Headers, std::string> { return {429, {{"Retry-After", "60"}}, "{}"}; });
  HttpRequest request{"GET", limited.url, {}, "", 1000};
  CHECK_EQ(capacity_http_request(request).status,429);
  CHECK(message_of([&] {capacity_http_request(request);}).find("cooldown")!=std::string::npos);
}

TEST(headless_credential_only_in_header) {
  CHECK_THROWS(RuntimeClient("https://x.example", "not-a-token"));
  CHECK_THROWS(RuntimeClient("http://x.example", TOKEN));
  Server server([](const std::string&, int n) -> std::tuple<int, Headers, std::string> {
    if (n == 1) return {200, {{"Content-Type", "application/json"}}, R"({"version":1})"};
    return {401, {{"Content-Type", "application/json"}}, R"({"code":"CREDENTIAL_REVOKED","error":"This agent credential was revoked.","retryable":false})"};
  });
  RuntimeClient client(server.url, TOKEN);
  client.policy();
  try {
    client.session();
    CHECK(false);
  } catch (const Error& e) {
    CHECK(is_stop(e));
    CHECK_EQ(e.api_code, std::string("CREDENTIAL_REVOKED"));
    CHECK(std::string(e.what()).find(TOKEN) == std::string::npos);
  }
  for (auto c : server.calls()) {
    CHECK(c.path.find(TOKEN) == std::string::npos);
    CHECK(c.path.rfind("/api/agent-runtime/v1/", 0) == 0);
    CHECK_EQ(c.headers["authorization"], "Bearer " + TOKEN);
    CHECK_EQ(c.headers["flurbo-agent-protocol"], std::string("1"));
    CHECK(c.headers.count("sec-fetch-site") == 0);
  }
  CHECK(client.describe().find(TOKEN) == std::string::npos);
  RuntimeClient offline("http://127.0.0.1:9", TOKEN);
  try {
    offline.session();
    CHECK(false);
  } catch (const Error& e) {
    CHECK_EQ(e.api_code, std::string("NETWORK"));
  }
}

static const std::string WALLET = "0x2222222222222222222222222222222222222222";

static std::string temp(const std::string& name) {
  // Under the build directory: the system temporary directory is not always usable from every shell.
  auto d = std::filesystem::absolute(std::filesystem::path(self_path).parent_path() / ("tmp-" + name + "-" + std::to_string(process_id())));
  std::filesystem::remove_all(d);
  std::filesystem::create_directories(d);
  return utf8(d);
}

// Runs only as a child process of journal_lock_serialises_separate_processes.
TEST(journal_child_writer) {
  auto dir = get_env("FLURBO_JOURNAL_CHILD_DIR");
  if (!dir) return;
  FileJournal j(*dir, WALLET);
  for (int i = 0; i < 40; ++i)
    j.locked([&](Value& f) {
      Value e = Value::object();
      e.set("id", std::to_string(process_id()) + "-" + std::to_string(i));
      e.set("status", "abandoned");
      e.set("seq", static_cast<int64_t>(f["entries"].size()));
      f.get_or_add("entries").push(e);
    });
}

TEST(semantic_disabled_passes_guard_but_failures_never_do) {
  Deployment d; d.namespace_="pilot"; d.pool="0x"+std::string(40,'1');d.rules_hash="0x"+std::string(64,'2');d.event_count=2;d.closes_at=2000000000;
  auto disabled=json::parse(R"({"schema":"flurbo.semantic-assessment.v1","mode":"disabled","scope":3,"mask":"8","quantityAtoms":"1000000"})");
  disabled.set("pool",d.pool);disabled.set("rulesHash",d.rules_hash);disabled.set("configRevision",std::string(64,'b'));disabled.set("checkedAt",now_seconds());disabled.set("expiresAt",now_seconds()+60);
  struct Case { int status; std::string body; bool blocked; };
  for (const auto& c : std::vector<Case>{{200,disabled.dump(),false},{503,R"({"code":"SEMANTICS_UNAVAILABLE"})",true},{200,R"({"code":"SEMANTICS_UNAVAILABLE"})",true}}) {
    Server server([c](const std::string&,int)->std::tuple<int,Headers,std::string>{return {c.status,{{"Content-Type","application/json"}},c.body};});
    auto signer=std::make_shared<LocalKeySigner>("0x"+std::string(64,'1'));
    auto dir=temp("semantic-disabled");auto journal=std::make_shared<FileJournal>(dir,signer->address());
    journal->locked([&](Value& j){auto e=json::parse(R"({"id":"disabled","action":"buy","status":"planned","claim":{"scope":3,"mask":"8"},"quantityAtoms":"1000000","limitAtoms":"500000","deadline":1800000000})");j.get_or_add("entries").push(e);});
    auto controls=std::make_shared<FixedControls>(Policy::from_json(default_config()["policy"]),true);
    Executor ex(std::make_shared<ChainReader>(std::make_shared<JsonRpc>("http://127.0.0.1:9")),signer,journal,std::make_shared<RuntimeClient>(server.url,TOKEN),controls,0);
    try { ex.sign("disabled",d); } catch (...) {}
    CHECK_EQ(journal->read()["entries"][0].str("note")==std::string("SEMANTICS_UNAVAILABLE"),c.blocked);
    std::filesystem::remove_all(dir);
  }
}
TEST(semantic_collision_blocks_custom_execute_and_sign) {
  Deployment d; d.namespace_="pilot"; d.pool="0x"+std::string(40,'1');d.rules_hash="0x"+std::string(64,'2');d.event_count=2;d.closes_at=2000000000;
  auto result=json::parse(R"({"schema":"flurbo.semantic-assessment.v1","scope":3,"mask":"8","quantityAtoms":"1000000","status":"collision","coverage":"complete","matrix":[{"state":0,"admissible":true,"pays":false},{"state":1,"admissible":true,"pays":false},{"state":2,"admissible":true,"pays":false},{"state":3,"admissible":false,"pays":true}]})");
  result.set("pool",d.pool);result.set("rulesHash",d.rules_hash);result.set("rulesDigest",std::string(64,'3'));result.set("mode","enforced");result.set("configRevision",std::string(64,'a'));result.set("checkedAt",now_seconds());result.set("expiresAt",now_seconds()+60);
  Server server([result](const std::string&,int)->std::tuple<int,Headers,std::string>{return {200,{{"Content-Type","application/json"}},result.dump()};});
  auto signer=std::make_shared<LocalKeySigner>("0x"+std::string(64,'1'));
  auto dir=temp("semantic-sign");auto journal=std::make_shared<FileJournal>(dir,signer->address());
  journal->locked([&](Value& j){auto e=json::parse(R"({"id":"collision","action":"buy","status":"planned","claim":{"scope":3,"mask":"8"},"quantityAtoms":"1000000","limitAtoms":"500000","deadline":1800000000})");j.get_or_add("entries").push(e);});
  auto controls=std::make_shared<FixedControls>(Policy::from_json(default_config()["policy"]),true);
  Executor ex(std::make_shared<ChainReader>(std::make_shared<JsonRpc>("http://127.0.0.1:9")),signer,journal,std::make_shared<RuntimeClient>(server.url,TOKEN),controls,0);
  CHECK(!ex.sign("collision",d));CHECK_EQ(journal->read()["entries"][0].str("note"),std::string("SEMANTIC_COLLISION"));
  CHECK_EQ(ex.execute({"test",d,"buy",{3,8},1000000,50,500000,{1,"0x",now_seconds()}}).reason,std::string("SEMANTIC_COLLISION"));
  CHECK(journal->read()["entries"][0]["rawTransaction"].is_null());
  std::filesystem::remove(std::filesystem::path(dir)/"journal.json");std::filesystem::remove(dir);
}

TEST(journal_lock_serialises_separate_processes) {
  if (get_env("FLURBO_JOURNAL_CHILD_DIR")) return;
  std::string dir = temp("journal");
  set_env("FLURBO_JOURNAL_CHILD_DIR", dir);
  std::vector<std::thread> children;
  std::atomic<int> failed{0};
  for (int i = 0; i < 3; ++i)
    children.emplace_back([&, i] {
      std::string log = (std::filesystem::path(dir) / ("child-" + std::to_string(i) + ".log")).string();
      std::string command = "\"" + self_path + "\" journal_child_writer > \"" + log + "\" 2>&1";
#ifdef _WIN32
      command = "\"" + command + "\"";  // cmd.exe strips one outer pair of quotes
#endif
      if (std::system(command.c_str()) != 0) ++failed;
    });
  for (auto& c : children) c.join();
  unset_env("FLURBO_JOURNAL_CHILD_DIR");
  CHECK_EQ(failed.load(), 0);
  FileJournal j(dir, WALLET);
  auto entries = j.entries();
  CHECK_EQ(entries.size(), size_t{120});  // no lost updates
  for (size_t i = 0; i < entries.size(); ++i) CHECK_EQ(entries[i].integer("seq", -1), static_cast<int64_t>(i));
  CHECK(!file_exists(j.lock_file));
  CHECK(message_of([&] { FileJournal(dir, "0x3333333333333333333333333333333333333333").read(); }).find("one state directory per agent wallet") != std::string::npos);
  std::filesystem::remove_all(dir);
}

TEST(journal_keeps_every_runtime_format_and_unknown_fields) {
  std::string dir = temp("format");
  Value written = json::parse(R"({"schema":"flurbo.agent-journal.v1","wallet":"0x2222222222222222222222222222222222222222","chainId":10143,"entries":[{
    "id":"e1","action":"buy","namespace":"pilot","pool":"0x28d5ee02b1eda6959ac3ee5a4f834237c84dee02","claim":{"scope":3,"mask":"8"},
    "quantityAtoms":"1000000","limitAtoms":"510000","deadline":1790000300,"status":"signed","plannedAt":1790000000,"decisionId":"d-1",
    "to":"0x28d5ee02b1eda6959ac3ee5a4f834237c84dee02","data":"0x","gas":"250000","maxFeePerGas":"1","maxPriorityFeePerGas":"1","nonce":4,
    "rawTransaction":"0x02","hash":"0xab","signedAt":1790000001,"broadcastAt":null,"finalAt":null,"costAtoms":null,"receipt":null,"note":null,
    "owner":{"pid":1,"host":"h"},"report":{"status":"none","attempts":0,"flurboStatus":null},"futureField":{"kept":true}}]})");
  write_file(path_join(dir, "journal.json"), written.dump());
  FileJournal j(dir, WALLET);
  j.locked([](Value& f) { f.get_or_add("entries").as_array()[0].set("note", "touched"); });
  Value expected = written["entries"][0];
  expected.set("note", "touched");
  CHECK(j.entries()[0] == expected);
  std::filesystem::remove_all(dir);
}

TEST(signer_cli_and_configuration) {
  CHECK_THROWS(LocalKeySigner("0x1234"));
  std::string key = to_hex(random_bytes(32));
  LocalKeySigner signer(key);
  CHECK(message_of([] { LocalKeySigner::from_env("FLURBO_TEST_MISSING_KEY"); }).find("Set FLURBO_TEST_MISSING_KEY") != std::string::npos);
  std::string d = temp("cli");
  std::string config = path_join(d, "flurbo-agent.json");
  std::vector<std::string> out, err;
  auto run = [&](std::vector<std::string> args) {
    return cli_main(args, [&](const std::string& s) { out.push_back(s); }, [&](const std::string& s) { err.push_back(s); });
  };
  CHECK_EQ(run({"init", "--config", config, "--markets", NS}), 0);
  parse_config(json::parse(*read_file(config)));
  CHECK_EQ(run({"init", "--config", config, "--markets", NS}), 1);
  auto message = [](const std::string& w) {
    return "Flurbo agent wallet association\nOrigin: http://localhost\nMera account: 0x" + std::string(40, '4') + "\nAgent: a\nAgent wallet: " + w +
           "\nChain: Monad testnet (10143)\nNonce: n\nIssued: x\nExpires: y\nThis proves control of this wallet.";
  };
  write_file(path_join(d, "m.txt"), message(signer.address()));
  write_file(path_join(d, "other.txt"), message("0x" + std::string(40, '5')));
  write_file(path_join(d, "tx.txt"), "Transfer all funds");
  set_env("FLURBO_AGENT_PRIVATE_KEY", key);  // the CLI reads the key from the environment by design
  out.clear();
  CHECK_EQ(run({"sign-message", "--file", path_join(d, "m.txt"), "--config", config}), 0);
  CHECK(!out.empty() && out[0] == signer.sign_message(message(signer.address())));
  CHECK_EQ(run({"sign-message", "--file", path_join(d, "other.txt"), "--config", config}), 1);
  CHECK_EQ(run({"sign-message", "--file", path_join(d, "tx.txt"), "--config", config}), 1);
  out.clear();
  CHECK_EQ(run({"address", "--config", config}), 0);
  CHECK(!out.empty() && out[0] == signer.address());
  unset_env("FLURBO_AGENT_PRIVATE_KEY");
  for (const auto& e : err) CHECK(e.find(key.substr(2)) == std::string::npos);
  out.clear();
  CHECK_EQ(run({"status", "--config", config}), 0);  // paper mode needs no key and no credential
  CHECK(!out.empty() && json::parse(out[0]).str("mode") == "paper");
  CHECK_EQ(run({"stop", "--config", config}), 0);
  CHECK(file_exists(path_join(path_join(d, ".flurbo-agent"), "stop.request")));
  Value bad = default_config();
  bad.set("mode", "autonomous");
  CHECK(message_of([&] { parse_config(bad); }).find("mode") != std::string::npos);
  Value secret = configured();
  Value provider = json::parse(R"({"kind":"anthropic","model":"m","apiKeyEnv":"K"})");
  provider.set("privateKey", key);
  secret.get_or_add("research").set("provider", provider);
  CHECK(message_of([&] { parse_config(secret); }).find("secrets") != std::string::npos);
  std::filesystem::remove_all(d);
}

TEST(default_config_names_no_market_and_init_requires_markets) {
  Value defaults = default_config();
  CHECK_EQ(defaults["markets"].size(), size_t(0));
  CHECK_EQ(defaults["policy"]["markets"].size(), size_t(0));
  CHECK(message_of([&] { parse_config(defaults); }).find("list at least one market") != std::string::npos);
  std::string d = temp("init-markets"), config = path_join(d, "flurbo-agent.json");
  const std::string required = "invalid_input: Pass --markets as the comma separated market names shown on the agent page: practice- followed by the pool address without 0x.";
  for (const auto& extra : std::vector<std::vector<std::string>>{{}, {"--markets", ""}, {"--markets", "practice-1234"}}) {
    std::vector<std::string> args{"init", "--config", config}, err;
    args.insert(args.end(), extra.begin(), extra.end());
    CHECK_EQ(cli_main(args, [](const std::string&) {}, [&](const std::string& s) { err.push_back(s); }), 1);
    CHECK(err.size() == 1 && err[0] == required);
    CHECK(!file_exists(config));
  }
  CHECK_EQ(cli_main({"init", "--config", config, "--markets", NS}, [](const std::string&) {}, [](const std::string&) {}), 0);
  Value written = json::parse(*read_file(config));
  CHECK(written["markets"].size() == 1 && written["markets"][0].as_string() == NS);
  CHECK(written["policy"]["markets"].size() == 1 && written["policy"]["markets"][0].as_string() == NS);
  std::filesystem::remove_all(d);
}

struct FixedNode : Rpc {
  std::map<std::string, Value> replies;
  Value call(const std::string& method, const Value&) override {
    auto it = replies.find(method);
    return it == replies.end() ? Value() : it->second;
  }
};

TEST(hostile_rpc_values_are_refused_not_wrapped) {
  auto node = std::make_shared<FixedNode>();
  node->replies["eth_gasPrice"] = Value(hex_of(~u128(0) / 100));
  CHECK_THROWS(ChainReader(node).fees());
  node->replies["eth_gasPrice"] = Value(std::string("0xba43b7400"));
  node->replies["eth_maxPriorityFeePerGas"] = Value(std::string("0x3b9aca00"));
  Fees fees = ChainReader(node).fees();
  CHECK(fees.max_fee_per_gas == u128(60'000'000'000ULL));
  CHECK(fees.max_priority_fee_per_gas == u128(1'000'000'000ULL));

  CHECK(gas_with_margin(250'000) == std::optional<u128>(300'000));
  CHECK(gas_with_margin(MAX_GAS * 100 / 120) == std::optional<u128>(MAX_GAS));
  CHECK(!gas_with_margin(MAX_GAS * 100 / 120 + 1));
  CHECK(!gas_with_margin(0));
  CHECK(!gas_with_margin(~u128(0) / 120 * 2 + 3));
  CHECK(!gas_with_margin(~u128(0)));

  CHECK(fee_wei(300'000, 60'000'000'000ULL) == std::optional<i128>(i128(18'000'000'000'000'000LL)));
  CHECK(!fee_wei(300'000, (u128(1) << 127) / 300'000 + 1));
  CHECK(!fee_wei(1, ~u128(0)));
  CHECK(fee_wei(0, ~u128(0)) == std::optional<i128>(0));
}

TEST(http_dates_outside_the_imf_fixdate_form_are_rejected) {
  CHECK(parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT") == std::optional<int64_t>(784'111'777));
  CHECK(parse_http_date("Fri, 31 Dec 9999 23:59:59 GMT") == std::optional<int64_t>(253'402'300'799LL));
  for (const char* s : {"Sun, 06 Nov 99999999999 08:49:37 GMT", "Sun, 06 Nov 19940 08:49:37 GMT", "Sun, 06 Nov -994 08:49:37 GMT",
                        "Sun, 06 Nov 1994 -1:49:37 GMT", "Sun, 06 Nov 1994 08:-1:37 GMT", "Sun, 06 Nov 1994 08:49:-1 GMT"})
    CHECK(!parse_http_date(s));
}

TEST(market_detail_must_list_exactly_the_deployed_events) {
  auto ev = [](int64_t i) {
    Value e = Value::object();
    e.set("index", Value(i));
    e.set("question", Value(std::string("q")));
    return e;
  };
  auto list = [&](std::initializer_list<int64_t> ids) {
    Value a = Value::array();
    for (int64_t i : ids) a.push(ev(i));
    return a;
  };
  CHECK(listed_events_match(list({0, 1}), 2));
  CHECK(!listed_events_match(list({0, 1, 2}), 2));
  CHECK(!listed_events_match(list({0}), 2));
  CHECK(!listed_events_match(list({1, 0}), 2));
  Value text = list({0});
  Value bad = Value::object();
  bad.set("index", Value(std::string("1")));
  text.push(bad);
  CHECK(!listed_events_match(text, 2));
  Value many = Value::array();
  for (int64_t i = 0; i < 5000; ++i) many.push(ev(i));
  CHECK(!listed_events_match(many, 4));
  CHECK(!listed_events_match(Value(), 2));
}

TEST(deployment_accepts_2_to_32_events) {
  auto deployment = [](int64_t events) {
    return json::parse(R"({"schema":"flurbo.agent-deployment.v1","interface":"flurbo.pilot-pool.v1","namespace":"practice-2222222222222222222222222222222222222222",
      "chainId":10143,"pool":"0x2222222222222222222222222222222222222222","resolver":"0x3333333333333333333333333333333333333333",
      "collateral":{"address":"0xa9012a055bd4e0edff8ce09f960291c09d5322dc","decimals":6},
      "codeHashes":{"pool":"0x4444444444444444444444444444444444444444444444444444444444444444","resolver":"0x5555555555555555555555555555555555555555555555555555555555555555"},
      "rulesHash":"0x6666666666666666666666666666666666666666666666666666666666666666","closesAt":1800000000,"eventCount":)" + std::to_string(events) +
      R"(,"limits":{"maxQuantityAtoms":"100000000","maxLimitAtoms":"100000000","slippageBps":[10,50,100],"maxDeadlineSeconds":300}})");
  };
  CHECK_EQ(parse_deployment(deployment(16)).event_count, 16u);
  CHECK_EQ(parse_deployment(deployment(32)).event_count, 32u);
  CHECK_THROWS(parse_deployment(deployment(33)));
  CHECK_THROWS(parse_deployment(deployment(1)));
}

TEST(worst_case_loss_wide_pool) {
  std::ifstream file("../../protocol/fixtures/policy.json", std::ios::binary);
  std::stringstream text;
  text << file.rdbuf();
  Value base = json::parse(text.str())["cases"].as_array()[0]["input"];
  auto bought = [](const std::string& id, int64_t scope, const std::string& mask, const std::string& quantity, const std::string& cost) {
    return json::parse(R"({"id":")" + id + R"(","action":"buy","namespace":")" + NS + R"(","claim":{"scope":)" + std::to_string(scope) + R"(,"mask":")" + mask +
                       R"("},"quantityAtoms":")" + quantity + R"(","limitAtoms":")" + cost + R"(","costAtoms":")" + cost + R"(","status":"confirmed","plannedAt":1})");
  };
  auto input = [&](const Value& journal, int64_t scope) {
    Value v = base;
    v.get_or_add("market").set("namespace", NS);
    v.get_or_add("market").set("eventCount", Value(int64_t{32}));
    v.set("journal", journal);
    Value& c = v.get_or_add("candidate");
    c.set("namespace", NS);
    c.set("claim", json::parse(R"({"scope":)" + std::to_string(scope) + R"(,"mask":"2"})"));
    c.set("quantityAtoms", std::string("1000000"));
    c.set("limitAtoms", std::string("600000"));
    return PolicyInput::from_json(v);
  };
  Value journal = Value::array();
  journal.push(bought("a", 1, "2", "1000000", "500000"));
  journal.push(bought("b", int64_t{1} << 15, "2", "2000000", "900000"));
  journal.push(bought("c", int64_t{1} << 31, "1", "3000000", "1200000"));
  CHECK(worst_case_loss(input(journal, int64_t{1} << 31)) == 2'200'000);
  Value spread = Value::array();
  for (int e = 0; e < 17; ++e) spread.push(bought("e" + std::to_string(e), int64_t{1} << e, "2", "1000000", "100000"));
  CHECK(worst_case_loss(input(spread, 1)) == 2'300'000);
}

TEST(pairs_for_cycle_rotates_through_every_pair) {
  using Pairs = std::vector<std::pair<size_t, size_t>>;
  Pairs all4{{0, 1}, {0, 2}, {0, 3}, {1, 2}, {1, 3}, {2, 3}};
  CHECK(pairs_for_cycle(4, 0) == std::make_pair(all4, size_t{0}));
  CHECK(pairs_for_cycle(4, 5) == std::make_pair(all4, size_t{0}));
  CHECK(pairs_for_cycle(16, 0) == std::make_pair(Pairs{{0, 1}, {0, 2}, {0, 3}, {0, 4}, {0, 5}, {0, 6}}, size_t{6}));
  CHECK(pairs_for_cycle(16, 117) == std::make_pair(Pairs{{13, 14}, {13, 15}, {14, 15}, {0, 1}, {0, 2}, {0, 3}}, size_t{3}));
  Pairs seen, expected;
  size_t cursor = 0;
  for (int i = 0; i < 20; ++i) {
    auto [pairs, next] = pairs_for_cycle(16, cursor);
    seen.insert(seen.end(), pairs.begin(), pairs.end());
    cursor = next;
  }
  std::sort(seen.begin(), seen.end());
  for (size_t a = 0; a < 16; ++a)
    for (size_t b = a + 1; b < 16; ++b) expected.push_back({a, b});
  CHECK(seen == expected);
}

int main(int argc, char** argv) {
  self_path = utf8(std::filesystem::absolute(argv[0]));
  return check::run(argc, argv);
}
