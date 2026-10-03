// The only place a transaction is signed. Keys stay in the operator's runtime: never sent to Flurbo, never
// logged, never placed in a model prompt. Remote signers (a KMS or a signing service) implement `Signer`.
// Cryptography is OpenSSL 3.2 or later: secp256k1 with RFC 6979 deterministic nonces, Keccak-256, SHA-256.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "flurbo/core.hpp"

namespace flurbo {

using Bytes = std::vector<uint8_t>;

std::string to_hex(const Bytes& b);
Bytes from_hex(const std::string& s);
Bytes keccak256(const Bytes& data);
std::string keccak_hex(const std::string& hex_data);
std::string sha256_hex(const std::string& data);
inline std::string transaction_hash(const std::string& raw) { return keccak_hex(raw); }
// 32 random bytes from the operating system (OpenSSL's generator).
Bytes random_bytes(size_t n);
std::string uuid4();

// An EIP-1559 transaction on Monad testnet.
struct Tx1559 {
  uint64_t chain_id = 10143;
  uint64_t nonce = 0;
  std::string to, data;
  u128 value = 0, gas = 0, max_fee_per_gas = 0, max_priority_fee_per_gas = 0;
};
// The EIP-2718 payload that is signed: 0x02 || rlp([...fields]).
Bytes unsigned_serialized(const Tx1559& tx);

class Signer {
 public:
  virtual ~Signer() = default;
  virtual std::string address() const = 0;
  virtual std::string kind() const = 0;
  // The signed raw transaction as 0x hex.
  virtual std::string sign_transaction(const Tx1559& tx) = 0;
  // An EIP-191 personal_sign signature as 0x hex (65 bytes).
  virtual std::string sign_message(const std::string& message) = 0;
};

class LocalKeySigner : public Signer {
 public:
  explicit LocalKeySigner(const std::string& private_key);
  ~LocalKeySigner() override;
  LocalKeySigner(const LocalKeySigner&) = delete;
  LocalKeySigner& operator=(const LocalKeySigner&) = delete;
  // Reads the key from an environment variable. The value is never echoed, even in errors.
  static std::unique_ptr<LocalKeySigner> from_env(const std::string& variable);
  std::string address() const override { return address_; }
  std::string kind() const override { return "local-key"; }
  std::string sign_transaction(const Tx1559& tx) override;
  std::string sign_message(const std::string& message) override;
  // r || s (low s) and the recovery parity of a signature over a 32-byte digest.
  std::pair<Bytes, int> sign_digest(const Bytes& digest) const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  std::string address_;
};

}  // namespace flurbo
