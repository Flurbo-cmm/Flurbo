// Research on the operator's machine (protocol/specs/research.md). Retrieval is explicit and allowlisted;
// retrieved text is untrusted data; the model has no tools and never sees keys or wallet details; every
// output is validated; every failure is an abstention with a reason.
#include <algorithm>

#include "flurbo/runtime.hpp"

namespace flurbo {

using json::Value;

static std::string collapse(const std::string& s) {
  std::string out;
  bool space = false;
  for (unsigned char c : s) {
    if (std::isspace(c)) {
      space = !out.empty();
      continue;
    }
    if (space) out += ' ';
    space = false;
    out += static_cast<char>(c);
  }
  return out;
}

static std::string strip_blocks(const std::string& body, const std::string& tag) {
  std::string low = lower(body), out;
  std::string open = "<" + tag, close = "</" + tag + ">";
  size_t at = 0;
  for (;;) {
    size_t start = low.find(open, at);
    if (start == std::string::npos) break;
    size_t end = low.find(close, start);
    if (end == std::string::npos) break;
    out += body.substr(at, start - at) + " ";
    at = end + close.size();
  }
  return out + body.substr(at);
}

static void replace_all(std::string& s, const std::string& a, const std::string& b) {
  for (size_t at = s.find(a); at != std::string::npos; at = s.find(a, at + b.size())) s.replace(at, a.size(), b);
}

std::string extract_text(const std::string& body, const std::string& content_type) {
  if (content_type.find("html") == std::string::npos) return collapse(body);
  std::string text = body;
  for (const char* tag : {"script", "style", "noscript", "svg"}) text = strip_blocks(text, tag);
  std::string out;
  bool in_tag = false;
  for (char c : text) {
    if (c == '<') in_tag = true;
    else if (c == '>' && in_tag) {
      in_tag = false;
      out += ' ';
    } else if (!in_tag) out += c;
  }
  for (const auto& [a, b] : std::vector<std::pair<std::string, std::string>>{{"&nbsp;", " "}, {"&amp;", "&"}, {"&lt;", "<"}, {"&gt;", ">"}, {"&quot;", "\""}, {"&#39;", "'"}})
    replace_all(out, a, b);
  return collapse(out);
}

static std::optional<std::string> title_of(const std::string& text) {
  std::string low = lower(text);
  size_t start = low.find("<title");
  if (start == std::string::npos) return std::nullopt;
  size_t open_end = low.find('>', start);
  if (open_end == std::string::npos) return std::nullopt;
  size_t close = low.find('<', open_end + 1);
  if (close == std::string::npos) return std::nullopt;
  std::string t = trim(text.substr(open_end + 1, close - open_end - 1));
  if (t.empty() || js_len(t) > 160) return std::nullopt;
  return t;
}

HttpRetriever::HttpRetriever(std::vector<std::string> allow_hosts, bool allow_local_http) : local_(allow_local_http) {
  for (auto& h : allow_hosts) allow_.push_back(lower(h));
}

bool HttpRetriever::allowed(const std::string& url) const {
  auto u = parse_url(url);
  if (!u || u->userinfo) return false;
  if (u->scheme == "https") return std::find(allow_.begin(), allow_.end(), u->host) != allow_.end();
  return local_ && u->scheme == "http" && (u->host == "127.0.0.1" || u->host == "localhost");
}

std::vector<Evidence> HttpRetriever::retrieve(const std::vector<Source>& sources, int64_t now) {
  std::vector<Evidence> out;
  for (size_t i = 0; i < sources.size() && i < 6; ++i) {
    // A failed source is skipped; research abstains if nothing usable remains.
    try {
      std::string url = sources[i].url;
      std::optional<HttpResponse> r;
      for (int hop = 0; hop < 4 && allowed(url); ++hop) {
        HttpResponse resp = http_request({"GET", url, {{"Accept", "text/html,application/json,text/plain"}, {"Accept-Encoding", "identity"}}, "", 10000, 2000000});
        auto location = resp.header("Location");
        if (resp.status >= 300 && resp.status < 400 && location) {
          url = join_url(url, *location);  // redirects are followed by hand, re-checking the allowlist
          continue;
        }
        r = resp;
        break;
      }
      if (!r || r->status != 200 || r->header("Content-Range") || r->body.empty()) continue;
      if (auto encoding = r->header("Content-Encoding"); encoding && lower(*encoding) != "identity") continue;
      std::string type = lower(r->header("Content-Type").value_or(""));
      if (type.find("text/") == std::string::npos && type.find("application/json") == std::string::npos && type.find("application/xhtml") == std::string::npos) continue;
      Evidence e;
      e.schema = EVIDENCE_SCHEMA; e.requested_url = sources[i].url; e.final_url = url;
      e.complete_document = true; e.captured_bytes = static_cast<int64_t>(r->body.size()); e.event_ids = {sources[i].event};
      e.id = "src-" + std::to_string(out.size() + 1);
      e.url = url;
      e.title = title_of(r->body).value_or(url);
      auto u = parse_url(url);
      e.publisher = u ? u->origin.substr(u->origin.find("://") + 3) : "";
      e.retrieved_at = now;
      if (auto modified = r->header("Last-Modified")) { auto timestamp = parse_http_date(*modified); if (timestamp && *timestamp >= 0) e.http_last_modified = timestamp; }
      e.content_sha256 = sha256_hex(r->body);
      e.excerpt = js_slice(extract_text(r->body, type), 4000);
      if (trim(e.excerpt).empty()) continue;
      out.push_back(e);
    } catch (const Error&) {
    }
  }
  return out;
}

std::vector<Evidence> FixtureRetriever::retrieve(const std::vector<Source>&, int64_t now) {
  std::vector<Evidence> out = records_;
  for (auto& e : out) e.retrieved_at = now;
  return out;
}

// A timeout and bounded retries for transport errors, 429 and 5xx only. Provider error bodies are never
// surfaced (they can echo keys or prompts).
static Value post(const std::string& url, const Headers& headers, const Value& body, int timeout_ms, int max_retries) {
  for (int attempt = 0; attempt <= max_retries; ++attempt) {
    Headers h = headers;
    h.emplace_back("Content-Type", "application/json");
    HttpResponse r;
    try {
      r = http_request({"POST", url, h, body.dump(), timeout_ms});
    } catch (const Error& e) {
      if (attempt < max_retries) {
        sleep_ms(500 << attempt);
        continue;
      }
      if (e.code == "timeout") throw Error("timeout", "The model provider did not respond in time.");
      throw Error("provider_unavailable", "The model provider could not be reached.");
    }
    if (r.status == 429 || r.status >= 500) {
      if (attempt < max_retries) {
        std::string retry = r.header("Retry-After").value_or("");
        int seconds = !retry.empty() && std::all_of(retry.begin(), retry.end(), ::isdigit) ? std::stoi(retry) : (1 << attempt);
        sleep_ms(std::min(seconds, 10) * 1000);
        continue;
      }
    }
    if (r.status >= 400)
      throw Error(r.status == 429 ? "rate_limited" : "provider_unavailable", "The model provider refused the request (HTTP " + std::to_string(r.status) + ").");
    try {
      return json::parse(r.body);
    } catch (const Error&) {
      throw Error("malformed_output", "The model returned no text.");
    }
  }
  throw Error("provider_unavailable", "The model provider failed.");
}

OpenAiCompatible::OpenAiCompatible(const std::string& base_url, std::string model, std::optional<std::string> api_key, int timeout_ms, int max_retries)
    : model_(std::move(model)), key_(std::move(api_key)), timeout_ms_(timeout_ms), max_retries_(std::min(max_retries, 3)) {
  auto u = parse_url(base_url);
  bool local = u && is_loopback(u->host);
  if (!u || (u->scheme != "https" && !local)) throw invalid("Use HTTPS for a remote model provider.");
  if (!key_ && !local) throw Error("provider_not_configured", "No API key configured for the model provider.");
  base_ = base_url;
  while (!base_.empty() && base_.back() == '/') base_.pop_back();
  base_ += "/";
  name_ = u->host + "/" + model_;
}

std::string OpenAiCompatible::complete(const Prompt& prompt) {
  Headers h;
  if (key_) h.emplace_back("Authorization", "Bearer " + *key_);
  Value body = Value::object(), fmt = Value::object(), sys = Value::object(), usr = Value::object(), messages = Value::array();
  fmt.set("type", "json_object");
  sys.set("role", "system");
  sys.set("content", prompt.system);
  usr.set("role", "user");
  usr.set("content", prompt.user);
  messages.push(sys);
  messages.push(usr);
  body.set("model", model_);
  body.set("temperature", 0);
  body.set("response_format", fmt);
  body.set("messages", messages);
  Value r = post(base_ + "chat/completions", h, body, timeout_ms_, max_retries_);
  const Value& content = r["choices"][0]["message"]["content"];
  if (!content.is_string()) throw Error("malformed_output", "The model returned no text.");
  return content.as_string();
}

AnthropicMessages::AnthropicMessages(std::string model, std::optional<std::string> api_key, int timeout_ms, int max_retries, std::string base_url)
    : model_(std::move(model)), base_(std::move(base_url)), timeout_ms_(timeout_ms), max_retries_(std::min(max_retries, 3)) {
  if (!api_key) throw Error("provider_not_configured", "No API key configured for the model provider.");
  key_ = *api_key;
  while (!base_.empty() && base_.back() == '/') base_.pop_back();
  base_ += "/";
}

std::string AnthropicMessages::complete(const Prompt& prompt) {
  Value body = Value::object(), usr = Value::object(), messages = Value::array();
  usr.set("role", "user");
  usr.set("content", prompt.user);
  messages.push(usr);
  body.set("model", model_);
  body.set("max_tokens", 1500);
  body.set("temperature", 0);
  body.set("system", prompt.system);
  body.set("messages", messages);
  Value r = post(base_ + "v1/messages", {{"x-api-key", key_}, {"anthropic-version", "2023-06-01"}}, body, timeout_ms_, max_retries_);
  std::string text;
  if (r["content"].is_array())
    for (const auto& c : r["content"].as_array())
      if (c.str("type") == "text") text += c.str("text");
  if (text.empty()) throw Error("malformed_output", "The model returned no text.");
  return text;
}

Researcher::Researcher(std::shared_ptr<Retriever> retriever, std::shared_ptr<Forecaster> forecaster, int64_t max_age, unsigned per_cycle, size_t per_hour,
                       std::optional<Error> unconfigured)
    : retriever_(std::move(retriever)), forecaster_(std::move(forecaster)), max_age_(max_age), per_cycle_(per_cycle), per_hour_(per_hour), unconfigured_(std::move(unconfigured)) {}

void Researcher::reset_cycle() {
  std::lock_guard<std::mutex> g(m_);
  cycle_ = 0;
}

ResearchResult Researcher::research(const std::string& pool, const std::string& title, const std::vector<PromptEvent>& events, const std::vector<Source>& sources, int64_t t,
                                  const json::Value& requirements, unsigned event_count) {
  ResearchResult r;
  if (!forecaster_) {
    r.reason = unconfigured_ ? unconfigured_->code : "provider_not_configured";
    r.detail = unconfigured_ ? unconfigured_->what() : "No research provider is configured.";
    return r;
  }
  r.provenance = Provenance{forecaster_->kind(), forecaster_->name()};
  {
    std::lock_guard<std::mutex> g(m_);
    hour_.erase(std::remove_if(hour_.begin(), hour_.end(), [&](int64_t x) { return x <= t - 3600; }), hour_.end());
    if (cycle_ >= per_cycle_ || hour_.size() >= per_hour_) {
      r.reason = "request_budget_exhausted";
      r.detail = "The research request budget is used up.";
      return r;
    }
  }
  r.evidence = retriever_->retrieve(sources, t);
  if (r.evidence.empty()) {
    r.reason = "no_sources";
    r.detail = "No evidence could be retrieved from the allowed sources.";
    return r;
  }
  ValidationContext ctx;
  for (const auto& e : events) ctx.requested_events.push_back(e.index);
  ctx.evidence = r.evidence; ctx.now = t; ctx.max_evidence_age_seconds = max_age_;
  ctx.event_count = event_count; ctx.evidence_requirements = requirements;
  std::vector<Evidence> usable;
  for (const auto& e : r.evidence) if (citable_evidence(e, t, event_count)) usable.push_back(e);
  auto failure = usable.empty() ? "invalid_evidence" : evidence_failure(usable, ctx);
  if (!failure.empty()) { r.reason = failure; r.detail = "Evidence requirements failed: " + failure + "."; return r; }
  {
    std::lock_guard<std::mutex> g(m_);
    ++cycle_;
    hour_.push_back(t);
  }
  std::string reply;
  try {
    reply = forecaster_->complete(build_research_prompt(title, events, usable, t, requirements, event_count));
  } catch (const Error& e) {
    r.reason = e.code;
    r.detail = e.what();
    return r;
  } catch (const std::exception&) {
    r.reason = "provider_unavailable";
    r.detail = "The model provider failed.";
    return r;
  }
  Validation v = validate_model_output(reply, ctx);
  if (!v.ok) {
    r.reason = v.reason;
    r.model_reason = v.model_reason;
    r.detail = "The forecast was not used: " + v.reason + ".";
    return r;
  }
  r.ok = true;
  r.output = v.output;
  for (const auto& id : v.output.evidence_ids)
    for (const auto& e : r.evidence) {
      auto observed = evidence_observed_at(e, v.output.events, requirements);
      if (e.id == id && observed && t - *observed <= max_age_) ++r.fresh_evidence;
    }
  r.forecast = forecast_from_model(v.output, pool, r.evidence, *r.provenance, t, requirements);
  return r;
}

}  // namespace flurbo
