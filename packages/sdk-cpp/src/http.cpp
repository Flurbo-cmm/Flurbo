// HTTP/1.1 over sockets, with OpenSSL for HTTPS. Certificates are verified (the Windows root store is
// loaded on Windows) and the host name is checked. Redirects are never followed here.
#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>

#include <algorithm>
#include <cstring>
#include <mutex>
#include <deque>
#include <map>

#include "flurbo/runtime.hpp"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <wincrypt.h>
using sock_t = SOCKET;
#define CLOSESOCK closesocket
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cerrno>
using sock_t = int;
#define CLOSESOCK ::close
#define INVALID_SOCKET (-1)
#endif

namespace flurbo {

namespace {

void init_sockets() {
#ifdef _WIN32
  static std::once_flag once;
  std::call_once(once, [] {
    WSADATA data;
    WSAStartup(MAKEWORD(2, 2), &data);
  });
#endif
}

Error net_error(const std::string& m) { return Error("network", m); }

bool timed_out() {
#ifdef _WIN32
  int e = WSAGetLastError();
  return e == WSAETIMEDOUT || e == WSAEWOULDBLOCK;
#else
  return errno == EAGAIN || errno == EWOULDBLOCK || errno == ETIMEDOUT;
#endif
}

void set_timeouts(sock_t s, int ms) {
#ifdef _WIN32
  DWORD t = static_cast<DWORD>(ms);
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&t), sizeof t);
  setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&t), sizeof t);
#else
  timeval t{ms / 1000, (ms % 1000) * 1000};
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &t, sizeof t);
  setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &t, sizeof t);
#endif
}

void set_blocking(sock_t s, bool blocking) {
#ifdef _WIN32
  u_long mode = blocking ? 0 : 1;
  ioctlsocket(s, FIONBIO, &mode);
#else
  int flags = fcntl(s, F_GETFL, 0);
  fcntl(s, F_SETFL, blocking ? (flags & ~O_NONBLOCK) : (flags | O_NONBLOCK));
#endif
}

sock_t connect_to(const std::string& host, const std::string& port, int timeout_ms) {
  init_sockets();
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* res = nullptr;
  if (getaddrinfo(host.c_str(), port.c_str(), &hints, &res) != 0) throw net_error("The host could not be resolved.");
  sock_t s = INVALID_SOCKET;
  for (addrinfo* a = res; a; a = a->ai_next) {
    s = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
    if (s == INVALID_SOCKET) continue;
    set_blocking(s, false);
    int r = ::connect(s, a->ai_addr, static_cast<int>(a->ai_addrlen));
    bool ok = r == 0;
    if (!ok) {
      fd_set w;
      FD_ZERO(&w);
      FD_SET(s, &w);
      timeval t{timeout_ms / 1000, (timeout_ms % 1000) * 1000};
      if (select(static_cast<int>(s + 1), nullptr, &w, nullptr, &t) == 1) {
        int err = 0;
        socklen_t len = sizeof err;
        getsockopt(s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&err), &len);
        ok = err == 0;
      }
    }
    if (ok) {
      set_blocking(s, true);
      set_timeouts(s, timeout_ms);
      break;
    }
    CLOSESOCK(s);
    s = INVALID_SOCKET;
  }
  freeaddrinfo(res);
  if (s == INVALID_SOCKET) throw net_error("The host could not be reached.");
  return s;
}

SSL_CTX* tls_context() {
  static SSL_CTX* ctx = [] {
    SSL_CTX* c = SSL_CTX_new(TLS_client_method());
    SSL_CTX_set_min_proto_version(c, TLS1_2_VERSION);
    SSL_CTX_set_verify(c, SSL_VERIFY_PEER, nullptr);
    SSL_CTX_set_default_verify_paths(c);
#ifdef _WIN32
    // The Windows root store, so certificate checks do not depend on an OpenSSL certificate directory.
    X509_STORE* store = SSL_CTX_get_cert_store(c);
    if (HCERTSTORE sys = CertOpenSystemStoreW(0, L"ROOT")) {
      PCCERT_CONTEXT cert = nullptr;
      while ((cert = CertEnumCertificatesInStore(sys, cert))) {
        const unsigned char* p = cert->pbCertEncoded;
        if (X509* x = d2i_X509(nullptr, &p, static_cast<long>(cert->cbCertEncoded))) {
          X509_STORE_add_cert(store, x);
          X509_free(x);
        }
      }
      CertCloseStore(sys, 0);
    }
#endif
    return c;
  }();
  return ctx;
}

struct Conn {
  sock_t s = INVALID_SOCKET;
  SSL* ssl = nullptr;
  ~Conn() {
    if (ssl) {
      SSL_shutdown(ssl);
      SSL_free(ssl);
    }
    if (s != INVALID_SOCKET) CLOSESOCK(s);
  }
  void send_all(const std::string& data) {
    size_t sent = 0;
    while (sent < data.size()) {
      int n = ssl ? SSL_write(ssl, data.data() + sent, static_cast<int>(data.size() - sent))
                  : ::send(s, data.data() + sent, static_cast<int>(data.size() - sent), 0);
      if (n <= 0) throw timed_out() ? Error("timeout", "The request timed out.") : net_error("The connection failed while sending.");
      sent += static_cast<size_t>(n);
    }
  }
  // Appends what arrives; returns false at the end of the stream.
  bool receive(std::string& out) {
    char buf[16384];
    int n = ssl ? SSL_read(ssl, buf, sizeof buf) : ::recv(s, buf, sizeof buf, 0);
    if (n > 0) {
      out.append(buf, static_cast<size_t>(n));
      return true;
    }
    if (n == 0 && !ssl) return false;
    if (ssl && SSL_get_error(ssl, n) == SSL_ERROR_ZERO_RETURN) return false;
    if (timed_out()) throw Error("timeout", "The request timed out.");
    throw net_error("The connection failed while receiving.");
  }
};

std::string dechunk(const std::string& body) {
  std::string out;
  size_t i = 0;
  while (i < body.size()) {
    size_t eol = body.find("\r\n", i);
    if (eol == std::string::npos) throw net_error("The chunked response was incomplete.");
    auto size_text = body.substr(i, eol - i); size_text = size_text.substr(0, size_text.find(';'));
    if (size_text.empty() || size_text.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos) throw net_error("The chunk length was invalid.");
    size_t len;
    try { len = std::stoull(size_text, nullptr, 16); } catch (...) { throw net_error("The chunk length was invalid."); }
    if (len == 0) {
      size_t rest = eol + 2;
      if (body.compare(rest, 2, "\r\n") == 0 || body.find("\r\n\r\n", rest) != std::string::npos) return out;
      throw net_error("The chunked response trailers were incomplete.");
    }
    if (len > body.size() - (eol + 2) || body.size() - (eol + 2) - len < 2 || body.compare(eol + 2 + len, 2, "\r\n") != 0)
      throw net_error("The chunked response was incomplete.");
    out += body.substr(eol + 2, len);
    i = eol + 2 + len + 2;
  }
  throw net_error("The chunked response had no terminal chunk.");
}

}  // namespace

std::optional<std::string> HttpResponse::header(const std::string& name) const {
  for (const auto& [k, v] : headers)
    if (lower(k) == lower(name)) return v;
  return std::nullopt;
}

std::optional<Url> parse_url(const std::string& url) {
  auto sep = url.find("://");
  if (sep == std::string::npos) return std::nullopt;
  Url u;
  u.scheme = lower(url.substr(0, sep));
  std::string rest = url.substr(sep + 3);
  size_t end = rest.find_first_of("/?#");
  std::string authority = rest.substr(0, end);
  u.path = end == std::string::npos ? "/" : rest.substr(end);
  if (u.path[0] != '/') u.path = "/" + u.path;
  if (authority.empty()) return std::nullopt;
  u.userinfo = authority.find('@') != std::string::npos;
  std::string hostport = u.userinfo ? authority.substr(authority.rfind('@') + 1) : authority;
  if (!hostport.empty() && hostport[0] == '[') {
    size_t close = hostport.find(']');
    if (close == std::string::npos) return std::nullopt;
    u.host = hostport.substr(1, close - 1);
    if (close + 1 < hostport.size() && hostport[close + 1] == ':') u.port = hostport.substr(close + 2);
  } else {
    size_t colon = hostport.find(':');
    u.host = hostport.substr(0, colon);
    if (colon != std::string::npos) u.port = hostport.substr(colon + 1);
  }
  u.host = lower(u.host);
  if (u.port.empty()) u.port = u.scheme == "https" ? "443" : "80";
  u.origin = u.scheme + "://" + authority;
  return u;
}

bool is_loopback(const std::string& host) { return host == "127.0.0.1" || host == "localhost" || host == "::1"; }

std::string join_url(const std::string& base, const std::string& location) {
  if (location.find("://") != std::string::npos) return location;
  auto u = parse_url(base);
  if (!u) return location;
  if (location.rfind("//", 0) == 0) return u->scheme + ":" + location;
  if (!location.empty() && location[0] == '/') return u->origin + location;
  return base.substr(0, base.rfind('/') + 1) + location;
}

std::string url_segment(const std::string& s) {
  std::string out;
  for (unsigned char c : s) {
    if (std::isalnum(c) || c == '-' || c == '.' || c == '_' || c == '~') {
      out += static_cast<char>(c);
    } else {
      char buf[4];
      std::snprintf(buf, sizeof buf, "%%%02X", c);
      out += buf;
    }
  }
  return out;
}

namespace {
struct CapacityBucket { std::deque<int64_t> starts; size_t active=0; int64_t until=0; };
std::mutex capacity_mutex;
std::map<std::string,CapacityBucket> capacity_buckets;
struct CapacityPermit {
  std::string origin;
  explicit CapacityPermit(const std::string& key, size_t limit):origin(key) {
    std::lock_guard<std::mutex> lock(capacity_mutex);
    if(!capacity_buckets.count(key)&&capacity_buckets.size()>=64)throw Error("rate_limited","Too many request origins.");
    auto& b=capacity_buckets[key];auto now=now_seconds();
    while(!b.starts.empty()&&b.starts.front()<=now-60)b.starts.pop_front();
    if(b.active>=4||b.starts.size()>=limit||now<b.until)throw Error("rate_limited","Request capacity reached. Retry after the cooldown.");
    b.active++;b.starts.push_back(now);
  }
  ~CapacityPermit(){std::lock_guard<std::mutex> lock(capacity_mutex);capacity_buckets[origin].active--;}
  void cooldown(const std::string& value){
    auto now=now_seconds(),until=now+60;
    try {if(!value.empty()&&value.find_first_not_of("0123456789")==std::string::npos){auto n=std::stoll(value);until=n>INT64_MAX-now?INT64_MAX:now+std::max<int64_t>(1,n);}else if(auto date=parse_http_date(value))until=*date;}catch(...){}
    std::lock_guard<std::mutex> lock(capacity_mutex);auto& b=capacity_buckets[origin];b.until=std::max(b.until,std::max(now+1,until));
  }
};
}
HttpResponse http_request(const HttpRequest& req) {
  auto u = parse_url(req.url);
  if (!u || (u->scheme != "http" && u->scheme != "https")) throw invalid("Unsupported URL.");
  Conn c;
  c.s = connect_to(u->host, u->port, req.timeout_ms);
  if (u->scheme == "https") {
    c.ssl = SSL_new(tls_context());
    SSL_set_fd(c.ssl, static_cast<int>(c.s));
    SSL_set_tlsext_host_name(c.ssl, u->host.c_str());
    SSL_set1_host(c.ssl, u->host.c_str());
    if (SSL_connect(c.ssl) != 1) {
      ERR_clear_error();
      throw net_error("The secure connection could not be established or the certificate was not valid.");
    }
  }
  bool default_port = (u->scheme == "https" && u->port == "443") || (u->scheme == "http" && u->port == "80");
  std::string host = (u->host.find(':') != std::string::npos ? "[" + u->host + "]" : u->host) + (default_port ? "" : ":" + u->port);
  std::string head = req.method + " " + u->path + " HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\nUser-Agent: flurbo-sdk-cpp/0.2.0\r\n";
  for (const auto& [k, v] : req.headers) head += k + ": " + v + "\r\n";
  if (!req.body.empty() || req.method == "POST") head += "Content-Length: " + std::to_string(req.body.size()) + "\r\n";
  c.send_all(head + "\r\n" + req.body);
  std::string raw;
  size_t header_end = std::string::npos;
  while (c.receive(raw)) {
    if (header_end == std::string::npos) header_end = raw.find("\r\n\r\n");
    if (raw.size() > req.max_body + 65536) throw net_error("The response exceeded the capture limit.");
    if (header_end != std::string::npos) {
      // Stop early once a Content-Length body is complete.
      std::string lower_head = lower(raw.substr(0, header_end));
      auto cl = lower_head.find("\r\ncontent-length:");
      if (cl != std::string::npos) {
        auto value = lower_head.substr(cl + 17); value = trim(value.substr(0, value.find("\r\n")));
        if (value.empty() || value.find_first_not_of("0123456789") != std::string::npos) throw net_error("Invalid response length.");
        size_t len;
        try { len = std::stoull(value); } catch (...) { throw net_error("Invalid response length."); }
        if (len > req.max_body) throw net_error("The response exceeded the capture limit.");
        if (lower_head.find("\r\ntransfer-encoding:") == std::string::npos && raw.size() >= header_end + 4 + len) break;
      }
    }
  }
  if (header_end == std::string::npos) header_end = raw.find("\r\n\r\n");
  if (header_end == std::string::npos) throw net_error("The response was incomplete.");
  HttpResponse r;
  std::string head_text = raw.substr(0, header_end);
  size_t line_end = head_text.find("\r\n");
  std::string status_line = head_text.substr(0, line_end);
  auto sp = status_line.find(' ');
  if (sp == std::string::npos) throw net_error("The response was malformed.");
  r.status = std::atoi(status_line.c_str() + sp + 1);
  for (size_t at = line_end; at != std::string::npos && at < head_text.size();) {
    size_t next = head_text.find("\r\n", at + 2);
    std::string line = head_text.substr(at + 2, next == std::string::npos ? std::string::npos : next - at - 2);
    auto colon = line.find(':');
    if (colon != std::string::npos) r.headers.emplace_back(trim(line.substr(0, colon)), trim(line.substr(colon + 1)));
    at = next;
  }
  r.body = raw.substr(header_end + 4);
  for (const auto& field : {"content-length", "transfer-encoding"})
    if (std::count_if(r.headers.begin(), r.headers.end(), [&](const auto& h) { return lower(h.first) == field; }) > 1) throw net_error("Ambiguous response framing.");
  auto transfer_encoding = lower(r.header("Transfer-Encoding").value_or(""));
  if (!transfer_encoding.empty() && transfer_encoding != "chunked") throw net_error("Unsupported response transfer encoding.");
  if (transfer_encoding == "chunked") r.body = dechunk(r.body);
  if (auto cl = r.header("Content-Length")) {
    if (!transfer_encoding.empty()) throw net_error("Ambiguous response framing.");
    if (cl->empty() || cl->find_first_not_of("0123456789") != std::string::npos) throw net_error("Invalid response length.");
    size_t len;
    try { len = std::stoull(*cl); } catch (...) { throw net_error("Invalid response length."); }
    if (r.body.size() < len) throw net_error("The response was incomplete.");
    if (r.body.size() > len) r.body.resize(len);
  }
  if (r.body.size() > req.max_body) throw net_error("The response exceeded the capture limit.");
  return r;
}

HttpResponse capacity_http_request(const HttpRequest& req, bool rpc) {
  auto u=parse_url(req.url);if(!u)throw invalid("Unsupported URL.");
  CapacityPermit permit((rpc?"rpc:":"api:")+u->origin,rpc?600:100);auto response=http_request(req);
  if(response.status==429)permit.cooldown(response.header("Retry-After").value_or(""));
  return response;
}

namespace net {

int listen_local(int& port) {
  init_sockets();
  sock_t s = socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  a.sin_port = 0;
  bind(s, reinterpret_cast<sockaddr*>(&a), sizeof a);
  listen(s, 16);
  socklen_t len = sizeof a;
  getsockname(s, reinterpret_cast<sockaddr*>(&a), &len);
  port = ntohs(a.sin_port);
  return static_cast<int>(s);
}

int accept_one(int listener) { return static_cast<int>(::accept(static_cast<sock_t>(listener), nullptr, nullptr)); }

std::string read_request(int socket) {
  std::string raw;
  char buf[8192];
  for (;;) {
    int n = ::recv(static_cast<sock_t>(socket), buf, sizeof buf, 0);
    if (n <= 0) break;
    raw.append(buf, static_cast<size_t>(n));
    size_t end = raw.find("\r\n\r\n");
    if (end == std::string::npos) continue;
    std::string head = lower(raw.substr(0, end));
    size_t cl = head.find("content-length:");
    size_t len = cl == std::string::npos ? 0 : std::stoul(head.substr(cl + 15));
    if (raw.size() >= end + 4 + len) break;
  }
  return raw;
}

void write_all(int socket, const std::string& data) {
  size_t sent = 0;
  while (sent < data.size()) {
    int n = ::send(static_cast<sock_t>(socket), data.data() + sent, static_cast<int>(data.size() - sent), 0);
    if (n <= 0) return;
    sent += static_cast<size_t>(n);
  }
}

void close_socket(int socket) { CLOSESOCK(static_cast<sock_t>(socket)); }

}  // namespace net

}  // namespace flurbo
