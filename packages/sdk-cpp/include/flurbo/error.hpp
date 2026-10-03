// Errors. Messages are safe to show: no credentials, keys or upstream bodies.
#pragma once

#include <optional>
#include <stdexcept>
#include <string>

namespace flurbo {

class Error : public std::runtime_error {
 public:
  Error(std::string code, const std::string& message) : std::runtime_error(message), code(std::move(code)) {}
  std::string code;
  std::optional<int> status;
  // The runtime API's machine code (for example CREDENTIAL_REVOKED), when the error came from it.
  std::string api_code;
  // JSON-RPC failure kind: timeout, unavailable or rejected.
  std::string rpc_kind;
};

inline Error invalid(const std::string& message) { return Error("invalid_input", message); }

}  // namespace flurbo
