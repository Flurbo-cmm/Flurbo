#include "flurbo/crypto.hpp"

#include <openssl/bn.h>
#include <openssl/core_names.h>
#include <openssl/ec.h>
#include <openssl/evp.h>
#include <openssl/obj_mac.h>
#include <openssl/param_build.h>
#include <openssl/rand.h>
#include <openssl/opensslv.h>

// Deterministic ECDSA nonces and Keccak-256 need OpenSSL 3.2. Ubuntu 24.04 ships 3.0; see the README.
#if OPENSSL_VERSION_NUMBER < 0x30200000L
#error "The Flurbo C++ SDK needs OpenSSL 3.2 or later. See packages/sdk-cpp/README.md (Linux)."
#endif

#include <cstdlib>
#include <cstring>

namespace flurbo {

namespace {

Error crypto_error(const std::string& what) { return Error("signing_failed", what); }

template <typename T, void (*F)(T*)>
struct Free {
  void operator()(T* p) const { F(p); }
};
using BnPtr = std::unique_ptr<BIGNUM, Free<BIGNUM, BN_clear_free>>;
using CtxPtr = std::unique_ptr<BN_CTX, Free<BN_CTX, BN_CTX_free>>;
using PointPtr = std::unique_ptr<EC_POINT, Free<EC_POINT, EC_POINT_free>>;
using GroupPtr = std::unique_ptr<EC_GROUP, Free<EC_GROUP, EC_GROUP_free>>;

Bytes digest(const char* name, const uint8_t* data, size_t len) {
  EVP_MD* md = EVP_MD_fetch(nullptr, name, nullptr);
  if (!md) throw crypto_error(std::string("OpenSSL does not provide ") + name + " (OpenSSL 3.2 or later is required).");
  Bytes out(static_cast<size_t>(EVP_MD_get_size(md)));
  unsigned int n = 0;
  bool ok = EVP_Digest(data, len, out.data(), &n, md, nullptr) == 1;
  EVP_MD_free(md);
  if (!ok) throw crypto_error("Hashing failed.");
  return out;
}

Bytes bn_bytes(const BIGNUM* bn) {
  Bytes out(32);
  BN_bn2binpad(bn, out.data(), 32);
  return out;
}

void rlp_len(size_t len, uint8_t offset, Bytes& out) {
  if (len < 56) {
    out.push_back(static_cast<uint8_t>(offset + len));
    return;
  }
  Bytes be;
  for (size_t v = len; v; v >>= 8) be.insert(be.begin(), static_cast<uint8_t>(v & 0xff));
  out.push_back(static_cast<uint8_t>(offset + 55 + be.size()));
  out.insert(out.end(), be.begin(), be.end());
}

void rlp_bytes(const Bytes& b, Bytes& out) {
  if (b.size() == 1 && b[0] < 0x80) {
    out.push_back(b[0]);
    return;
  }
  rlp_len(b.size(), 0x80, out);
  out.insert(out.end(), b.begin(), b.end());
}

void rlp_uint(u128 v, Bytes& out) {
  Bytes be;
  for (; v; v >>= 8) be.insert(be.begin(), static_cast<uint8_t>(v & 0xff));
  rlp_bytes(be, out);
}

Bytes rlp_list(const Bytes& items) {
  Bytes out;
  rlp_len(items.size(), 0xc0, out);
  out.insert(out.end(), items.begin(), items.end());
  return out;
}

Bytes fields(const Tx1559& tx) {
  Bytes to = from_hex(tx.to);
  if (to.size() != 20) throw invalid("Invalid recipient.");
  Bytes f;
  rlp_uint(tx.chain_id, f);
  rlp_uint(tx.nonce, f);
  rlp_uint(tx.max_priority_fee_per_gas, f);
  rlp_uint(tx.max_fee_per_gas, f);
  rlp_uint(tx.gas, f);
  rlp_bytes(to, f);
  rlp_uint(tx.value, f);
  rlp_bytes(from_hex(tx.data), f);
  f.push_back(0xc0);  // empty access list
  return f;
}

Bytes strip(const Bytes& b) {
  size_t i = 0;
  while (i < b.size() && b[i] == 0) ++i;
  return Bytes(b.begin() + static_cast<long>(i), b.end());
}

}  // namespace

std::string to_hex(const Bytes& b) {
  static const char* hex = "0123456789abcdef";
  std::string s = "0x";
  for (uint8_t x : b) {
    s += hex[x >> 4];
    s += hex[x & 15];
  }
  return s;
}

Bytes from_hex(const std::string& s) {
  if (s.rfind("0x", 0) != 0 || s.size() % 2) throw invalid("Expected 0x-prefixed hex with an even number of digits.");
  auto val = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    throw invalid("Invalid hex.");
  };
  Bytes out;
  for (size_t i = 2; i < s.size(); i += 2) out.push_back(static_cast<uint8_t>(val(s[i]) * 16 + val(s[i + 1])));
  return out;
}

Bytes keccak256(const Bytes& data) { return digest("KECCAK-256", data.data(), data.size()); }
std::string keccak_hex(const std::string& hex_data) { return to_hex(keccak256(from_hex(hex_data))); }
std::string sha256_hex(const std::string& data) {
  return to_hex(digest("SHA256", reinterpret_cast<const uint8_t*>(data.data()), data.size())).substr(2);
}

Bytes random_bytes(size_t n) {
  Bytes b(n);
  if (RAND_bytes(b.data(), static_cast<int>(n)) != 1) throw crypto_error("No random source.");
  return b;
}

std::string uuid4() {
  Bytes b = random_bytes(16);
  b[6] = static_cast<uint8_t>((b[6] & 0x0f) | 0x40);
  b[8] = static_cast<uint8_t>((b[8] & 0x3f) | 0x80);
  std::string h = to_hex(b).substr(2);
  return h.substr(0, 8) + "-" + h.substr(8, 4) + "-" + h.substr(12, 4) + "-" + h.substr(16, 4) + "-" + h.substr(20);
}

Bytes unsigned_serialized(const Tx1559& tx) {
  Bytes out{0x02};
  Bytes list = rlp_list(fields(tx));
  out.insert(out.end(), list.begin(), list.end());
  return out;
}

struct LocalKeySigner::Impl {
  EVP_PKEY* pkey = nullptr;
  GroupPtr group{EC_GROUP_new_by_curve_name(NID_secp256k1)};
  PointPtr pub;
  ~Impl() { EVP_PKEY_free(pkey); }
};

LocalKeySigner::LocalKeySigner(const std::string& private_key) : impl_(std::make_unique<Impl>()) {
  auto malformed = [] { return invalid("The agent key must be 32 bytes of hex with a 0x prefix."); };
  if (private_key.size() != 66) throw malformed();
  Bytes key;
  try {
    key = from_hex(private_key);
  } catch (const Error&) {
    throw malformed();
  }
  CtxPtr ctx(BN_CTX_new());
  BnPtr priv(BN_bin2bn(key.data(), 32, nullptr));
  OPENSSL_cleanse(key.data(), key.size());
  const BIGNUM* order = EC_GROUP_get0_order(impl_->group.get());
  if (!priv || BN_is_zero(priv.get()) || BN_cmp(priv.get(), order) >= 0) throw malformed();
  impl_->pub.reset(EC_POINT_new(impl_->group.get()));
  if (EC_POINT_mul(impl_->group.get(), impl_->pub.get(), priv.get(), nullptr, nullptr, ctx.get()) != 1) throw malformed();
  uint8_t pub[65];
  EC_POINT_point2oct(impl_->group.get(), impl_->pub.get(), POINT_CONVERSION_UNCOMPRESSED, pub, sizeof pub, ctx.get());
  Bytes hashed = keccak256(Bytes(pub + 1, pub + 65));
  address_ = to_hex(Bytes(hashed.begin() + 12, hashed.end()));

  OSSL_PARAM_BLD* bld = OSSL_PARAM_BLD_new();
  OSSL_PARAM_BLD_push_utf8_string(bld, OSSL_PKEY_PARAM_GROUP_NAME, "secp256k1", 0);
  OSSL_PARAM_BLD_push_BN(bld, OSSL_PKEY_PARAM_PRIV_KEY, priv.get());
  OSSL_PARAM_BLD_push_octet_string(bld, OSSL_PKEY_PARAM_PUB_KEY, pub, sizeof pub);
  OSSL_PARAM* params = OSSL_PARAM_BLD_to_param(bld);
  EVP_PKEY_CTX* pctx = EVP_PKEY_CTX_new_from_name(nullptr, "EC", nullptr);
  bool ok = pctx && EVP_PKEY_fromdata_init(pctx) == 1 && EVP_PKEY_fromdata(pctx, &impl_->pkey, EVP_PKEY_KEYPAIR, params) == 1;
  EVP_PKEY_CTX_free(pctx);
  OSSL_PARAM_free(params);
  OSSL_PARAM_BLD_free(bld);
  if (!ok) throw malformed();
}

LocalKeySigner::~LocalKeySigner() = default;

std::unique_ptr<LocalKeySigner> LocalKeySigner::from_env(const std::string& variable) {
  const char* v = std::getenv(variable.c_str());
  std::string value = v ? trim(v) : "";
  if (value.empty())
    throw invalid("Set " + variable + " to the dedicated agent wallet key (testnet only). Never use a deployer, settlement, reviewer or personal wallet.");
  return std::make_unique<LocalKeySigner>(value);
}

std::pair<Bytes, int> LocalKeySigner::sign_digest(const Bytes& d) const {
  // RFC 6979 deterministic nonces (HMAC-SHA256), as every reference signer.
  EVP_PKEY_CTX* sctx = EVP_PKEY_CTX_new_from_pkey(nullptr, impl_->pkey, nullptr);
  unsigned int nonce_type = 1;
  char md[] = "SHA256";
  OSSL_PARAM params[] = {OSSL_PARAM_construct_utf8_string(OSSL_SIGNATURE_PARAM_DIGEST, md, 0),
                         OSSL_PARAM_construct_uint(OSSL_SIGNATURE_PARAM_NONCE_TYPE, &nonce_type), OSSL_PARAM_construct_end()};
  size_t len = 0;
  Bytes der;
  bool ok = sctx && EVP_PKEY_sign_init_ex(sctx, params) == 1 && EVP_PKEY_sign(sctx, nullptr, &len, d.data(), d.size()) == 1;
  if (ok) {
    der.resize(len);
    ok = EVP_PKEY_sign(sctx, der.data(), &len, d.data(), d.size()) == 1;
    der.resize(len);
  }
  EVP_PKEY_CTX_free(sctx);
  if (!ok) throw crypto_error("Signing failed.");
  const uint8_t* p = der.data();
  ECDSA_SIG* sig = d2i_ECDSA_SIG(nullptr, &p, static_cast<long>(der.size()));
  if (!sig) throw crypto_error("Signing failed.");
  BnPtr r(BN_dup(ECDSA_SIG_get0_r(sig))), s(BN_dup(ECDSA_SIG_get0_s(sig)));
  ECDSA_SIG_free(sig);
  const EC_GROUP* g = impl_->group.get();
  const BIGNUM* n = EC_GROUP_get0_order(g);
  CtxPtr ctx(BN_CTX_new());
  BnPtr half(BN_dup(n));
  BN_rshift1(half.get(), half.get());
  if (BN_cmp(s.get(), half.get()) > 0) BN_sub(s.get(), n, s.get());  // low s
  // The recovery parity: the one that recovers our public key from (r, s).
  BnPtr e(BN_bin2bn(d.data(), static_cast<int>(d.size()), nullptr)), rinv(BN_mod_inverse(nullptr, r.get(), n, ctx.get())), u1(BN_new()), u2(BN_new());
  BN_mod_mul(u1.get(), e.get(), rinv.get(), n, ctx.get());
  BN_mod_sub(u1.get(), n, u1.get(), n, ctx.get());
  BN_mod_mul(u2.get(), s.get(), rinv.get(), n, ctx.get());
  int parity = -1;
  for (int y = 0; y < 2 && parity < 0; ++y) {
    PointPtr R(EC_POINT_new(g)), Q(EC_POINT_new(g));
    if (EC_POINT_set_compressed_coordinates(g, R.get(), r.get(), y, ctx.get()) != 1) continue;
    if (EC_POINT_mul(g, Q.get(), u1.get(), R.get(), u2.get(), ctx.get()) == 1 && EC_POINT_cmp(g, Q.get(), impl_->pub.get(), ctx.get()) == 0) parity = y;
  }
  if (parity < 0) throw crypto_error("Signing failed.");
  Bytes rs = bn_bytes(r.get()), sb = bn_bytes(s.get());
  rs.insert(rs.end(), sb.begin(), sb.end());
  return {rs, parity};
}

std::string LocalKeySigner::sign_transaction(const Tx1559& tx) {
  auto [sig, parity] = sign_digest(keccak256(unsigned_serialized(tx)));
  Bytes f = fields(tx);
  rlp_uint(static_cast<u128>(parity), f);
  rlp_bytes(strip(Bytes(sig.begin(), sig.begin() + 32)), f);
  rlp_bytes(strip(Bytes(sig.begin() + 32, sig.end())), f);
  Bytes out{0x02};
  Bytes list = rlp_list(f);
  out.insert(out.end(), list.begin(), list.end());
  return to_hex(out);
}

std::string LocalKeySigner::sign_message(const std::string& message) {
  std::string prefixed = "\x19" "Ethereum Signed Message:\n" + std::to_string(message.size()) + message;
  auto [sig, parity] = sign_digest(keccak256(Bytes(prefixed.begin(), prefixed.end())));
  sig.push_back(static_cast<uint8_t>(27 + parity));
  return to_hex(sig);
}

}  // namespace flurbo
