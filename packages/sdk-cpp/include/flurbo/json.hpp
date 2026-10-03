// A small JSON value with the semantics the protocol needs: objects keep insertion order (as JavaScript
// does), a repeated key keeps its last value, numbers remember whether they were written as integers, and
// non-finite numbers are rejected.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace flurbo::json {

class Value;
using Array = std::vector<Value>;
using Member = std::pair<std::string, Value>;

class Value {
 public:
  enum class Type { Null, Bool, Number, String, Array, Object };

  Value() = default;
  Value(std::nullptr_t) {}
  Value(bool b) : type_(Type::Bool), bool_(b) {}
  Value(int v) : Value(static_cast<int64_t>(v)) {}
  Value(unsigned v) : Value(static_cast<int64_t>(v)) {}
  Value(int64_t v) : type_(Type::Number), number_(static_cast<double>(v)), int_(v), integral_(true) {}
  Value(uint64_t v) : Value(static_cast<int64_t>(v)) {}
  // Where long is a distinct 32-bit type (Windows), accept it too. On Linux and macOS long is int64_t,
  // so this overload must not exist there.
  template <typename T> requires(std::is_same_v<T, long> && !std::is_same_v<long, int64_t>)
  Value(T v) : Value(static_cast<int64_t>(v)) {}
  Value(double v);
  Value(const char* s) : type_(Type::String), string_(s) {}
  Value(std::string s) : type_(Type::String), string_(std::move(s)) {}
  Value(Array a);
  static Value object();
  static Value array();

  Type type() const { return type_; }
  bool is_null() const { return type_ == Type::Null; }
  bool is_bool() const { return type_ == Type::Bool; }
  bool is_number() const { return type_ == Type::Number; }
  bool is_string() const { return type_ == Type::String; }
  bool is_array() const { return type_ == Type::Array; }
  bool is_object() const { return type_ == Type::Object; }

  bool as_bool() const;
  double as_double() const;
  // The value as an integer when it is an integral number (3 and 3.0 alike); throws otherwise.
  int64_t as_int() const;
  bool is_integer() const;
  const std::string& as_string() const;
  const Array& as_array() const;
  Array& as_array();
  const std::vector<Member>& members() const;

  // Objects: missing keys read as null; `set` replaces a key in place or appends it.
  const Value& operator[](const std::string& key) const;
  const Value& operator[](const char* key) const { return (*this)[std::string(key)]; }
  const Value& operator[](size_t i) const;
  const Value& operator[](int i) const { return (*this)[static_cast<size_t>(i)]; }
  bool has(const std::string& key) const;
  Value& set(const std::string& key, Value v);
  Value& get_or_add(const std::string& key);
  void push(Value v);
  size_t size() const;

  // Convenience readers with defaults.
  std::string str(const std::string& key, const std::string& fallback = "") const;
  int64_t integer(const std::string& key, int64_t fallback = 0) const;

  std::string dump(int indent = -1) const;
  bool operator==(const Value& other) const;
  bool operator!=(const Value& other) const { return !(*this == other); }

 private:
  Type type_ = Type::Null;
  bool bool_ = false;
  double number_ = 0;
  int64_t int_ = 0;
  bool integral_ = false;
  std::string string_;
  std::shared_ptr<Array> array_;
  std::shared_ptr<std::vector<Member>> object_;
  void write(std::string& out, int indent, int depth) const;
  void own();
  friend class Parser;
};

// Throws flurbo::Error("invalid_json") on malformed input, trailing text, NaN or Infinity.
Value parse(const std::string& text);
std::string quote(const std::string& s);

}  // namespace flurbo::json
