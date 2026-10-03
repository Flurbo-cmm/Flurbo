#include "flurbo/json.hpp"

#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>

#include "flurbo/error.hpp"

namespace flurbo::json {

namespace {
const Value kNull;
Error bad(const std::string& what) { return Error("invalid_json", "Invalid JSON: " + what + "."); }
}  // namespace

Value::Value(double v) : type_(Type::Number), number_(v) {
  if (!std::isfinite(v)) throw bad("non-finite number");
  integral_ = std::floor(v) == v && std::fabs(v) < 9.2e18;
  int_ = integral_ ? static_cast<int64_t>(v) : 0;
}

Value::Value(Array a) : type_(Type::Array), array_(std::make_shared<Array>(std::move(a))) {}

Value Value::object() {
  Value v;
  v.type_ = Type::Object;
  v.object_ = std::make_shared<std::vector<Member>>();
  return v;
}

Value Value::array() { return Value(Array{}); }

void Value::own() {
  if (array_ && array_.use_count() > 1) array_ = std::make_shared<Array>(*array_);
  if (object_ && object_.use_count() > 1) object_ = std::make_shared<std::vector<Member>>(*object_);
}

bool Value::as_bool() const {
  if (type_ != Type::Bool) throw bad("expected a boolean");
  return bool_;
}
double Value::as_double() const {
  if (type_ != Type::Number) throw bad("expected a number");
  return number_;
}
bool Value::is_integer() const { return type_ == Type::Number && integral_; }
int64_t Value::as_int() const {
  if (!is_integer()) throw bad("expected an integer");
  return int_;
}
const std::string& Value::as_string() const {
  if (type_ != Type::String) throw bad("expected a string");
  return string_;
}
const Array& Value::as_array() const {
  if (type_ != Type::Array) throw bad("expected an array");
  return *array_;
}
Array& Value::as_array() {
  if (type_ != Type::Array) throw bad("expected an array");
  own();
  return *array_;
}
const std::vector<Member>& Value::members() const {
  if (type_ != Type::Object) throw bad("expected an object");
  return *object_;
}

const Value& Value::operator[](const std::string& key) const {
  if (type_ != Type::Object) return kNull;
  for (const auto& m : *object_)
    if (m.first == key) return m.second;
  return kNull;
}
const Value& Value::operator[](size_t i) const {
  if (type_ != Type::Array || i >= array_->size()) return kNull;
  return (*array_)[i];
}
bool Value::has(const std::string& key) const {
  if (type_ != Type::Object) return false;
  for (const auto& m : *object_)
    if (m.first == key) return true;
  return false;
}
Value& Value::set(const std::string& key, Value v) {
  if (type_ != Type::Object) *this = object();
  own();
  for (auto& m : *object_)
    if (m.first == key) {
      m.second = std::move(v);
      return *this;
    }
  object_->emplace_back(key, std::move(v));
  return *this;
}
Value& Value::get_or_add(const std::string& key) {
  if (type_ != Type::Object) *this = object();
  own();
  for (auto& m : *object_)
    if (m.first == key) return m.second;
  object_->emplace_back(key, Value());
  return object_->back().second;
}
void Value::push(Value v) {
  if (type_ != Type::Array) *this = array();
  own();
  array_->push_back(std::move(v));
}
size_t Value::size() const {
  if (type_ == Type::Array) return array_->size();
  if (type_ == Type::Object) return object_->size();
  return 0;
}
std::string Value::str(const std::string& key, const std::string& fallback) const {
  const Value& v = (*this)[key];
  return v.is_string() ? v.string_ : fallback;
}
int64_t Value::integer(const std::string& key, int64_t fallback) const {
  const Value& v = (*this)[key];
  return v.is_integer() ? v.int_ : fallback;
}

bool Value::operator==(const Value& o) const {
  if (type_ != o.type_) return false;
  switch (type_) {
    case Type::Null: return true;
    case Type::Bool: return bool_ == o.bool_;
    case Type::Number: return number_ == o.number_;
    case Type::String: return string_ == o.string_;
    case Type::Array: return *array_ == *o.array_;
    case Type::Object: {
      if (object_->size() != o.object_->size()) return false;
      for (const auto& m : *object_)
        if (!o.has(m.first) || o[m.first] != m.second) return false;
      return true;
    }
  }
  return false;
}

std::string quote(const std::string& s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out + "\"";
}

static std::string number_text(double v, bool integral, int64_t i) {
  if (integral) return std::to_string(i);
  char buf[32];
  for (int p = 1; p <= 17; ++p) {
    std::snprintf(buf, sizeof buf, "%.*g", p, v);
    if (std::strtod(buf, nullptr) == v) break;
  }
  return buf;
}

void Value::write(std::string& out, int indent, int depth) const {
  auto newline = [&](int d) {
    if (indent < 0) return;
    out += '\n';
    out.append(static_cast<size_t>(indent * d), ' ');
  };
  switch (type_) {
    case Type::Null: out += "null"; break;
    case Type::Bool: out += bool_ ? "true" : "false"; break;
    case Type::Number: out += number_text(number_, integral_, int_); break;
    case Type::String: out += quote(string_); break;
    case Type::Array: {
      out += '[';
      for (size_t i = 0; i < array_->size(); ++i) {
        if (i) out += ',';
        newline(depth + 1);
        (*array_)[i].write(out, indent, depth + 1);
      }
      if (!array_->empty()) newline(depth);
      out += ']';
      break;
    }
    case Type::Object: {
      out += '{';
      for (size_t i = 0; i < object_->size(); ++i) {
        if (i) out += ',';
        newline(depth + 1);
        out += quote((*object_)[i].first);
        out += indent < 0 ? ":" : ": ";
        (*object_)[i].second.write(out, indent, depth + 1);
      }
      if (!object_->empty()) newline(depth);
      out += '}';
      break;
    }
  }
}

std::string Value::dump(int indent) const {
  std::string out;
  write(out, indent, 0);
  return out;
}

class Parser {
 public:
  explicit Parser(const std::string& t) : s(t) {}
  Value document() {
    Value v = value(0);
    ws();
    if (i != s.size()) throw bad("trailing text");
    return v;
  }

 private:
  const std::string& s;
  size_t i = 0;

  void ws() {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
  }
  bool eat(const char* word) {
    size_t n = std::char_traits<char>::length(word);
    if (s.compare(i, n, word) == 0) {
      i += n;
      return true;
    }
    return false;
  }
  Value value(int depth) {
    if (depth > 200) throw bad("too deep");
    ws();
    if (i >= s.size()) throw bad("unexpected end");
    char c = s[i];
    if (c == '{') return object(depth);
    if (c == '[') return array(depth);
    if (c == '"') return Value(string());
    if (eat("true")) return Value(true);
    if (eat("false")) return Value(false);
    if (eat("null")) return Value();
    return number();
  }
  Value object(int depth) {
    ++i;
    Value v = Value::object();
    ws();
    if (i < s.size() && s[i] == '}') {
      ++i;
      return v;
    }
    for (;;) {
      ws();
      if (i >= s.size() || s[i] != '"') throw bad("expected a key");
      std::string key = string();
      ws();
      if (i >= s.size() || s[i] != ':') throw bad("expected a colon");
      ++i;
      v.set(key, value(depth + 1));  // a repeated key keeps its last value
      ws();
      if (i < s.size() && s[i] == ',') {
        ++i;
        continue;
      }
      if (i < s.size() && s[i] == '}') {
        ++i;
        return v;
      }
      throw bad("expected , or }");
    }
  }
  Value array(int depth) {
    ++i;
    Value v = Value::array();
    ws();
    if (i < s.size() && s[i] == ']') {
      ++i;
      return v;
    }
    for (;;) {
      v.push(value(depth + 1));
      ws();
      if (i < s.size() && s[i] == ',') {
        ++i;
        continue;
      }
      if (i < s.size() && s[i] == ']') {
        ++i;
        return v;
      }
      throw bad("expected , or ]");
    }
  }
  static void utf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) {
      out += static_cast<char>(cp);
    } else if (cp < 0x800) {
      out += static_cast<char>(0xC0 | (cp >> 6));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out += static_cast<char>(0xE0 | (cp >> 12));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
      out += static_cast<char>(0xF0 | (cp >> 18));
      out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    }
  }
  uint32_t hex4() {
    if (i + 4 > s.size()) throw bad("short escape");
    uint32_t v = 0;
    for (int k = 0; k < 4; ++k) {
      char c = s[i++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= c - '0';
      else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
      else throw bad("bad escape");
    }
    return v;
  }
  std::string string() {
    ++i;
    std::string out;
    while (i < s.size()) {
      unsigned char c = static_cast<unsigned char>(s[i++]);
      if (c == '"') return out;
      if (c < 0x20) throw bad("control character in string");
      if (c != '\\') {
        out += static_cast<char>(c);
        continue;
      }
      if (i >= s.size()) break;
      char e = s[i++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          uint32_t cp = hex4();
          if (cp >= 0xD800 && cp <= 0xDBFF && i + 6 <= s.size() && s[i] == '\\' && s[i + 1] == 'u') {
            size_t save = i;
            i += 2;
            uint32_t lo = hex4();
            if (lo >= 0xDC00 && lo <= 0xDFFF) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            else i = save;
          }
          utf8(out, cp);
          break;
        }
        default: throw bad("bad escape");
      }
    }
    throw bad("unterminated string");
  }
  Value number() {
    size_t start = i;
    if (s[i] == '-') ++i;
    if (i >= s.size() || !std::isdigit(static_cast<unsigned char>(s[i]))) throw bad("unexpected character");
    if (s[i] == '0') ++i;
    else
      while (i < s.size() && std::isdigit(static_cast<unsigned char>(s[i]))) ++i;
    bool integral = true;
    if (i < s.size() && s[i] == '.') {
      integral = false;
      ++i;
      if (i >= s.size() || !std::isdigit(static_cast<unsigned char>(s[i]))) throw bad("bad number");
      while (i < s.size() && std::isdigit(static_cast<unsigned char>(s[i]))) ++i;
    }
    if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
      integral = false;
      ++i;
      if (i < s.size() && (s[i] == '+' || s[i] == '-')) ++i;
      if (i >= s.size() || !std::isdigit(static_cast<unsigned char>(s[i]))) throw bad("bad number");
      while (i < s.size() && std::isdigit(static_cast<unsigned char>(s[i]))) ++i;
    }
    std::string text = s.substr(start, i - start);
    double d = std::strtod(text.c_str(), nullptr);
    if (!std::isfinite(d)) throw bad("non-finite number");
    if (integral && text.size() <= 18) return Value(static_cast<int64_t>(std::strtoll(text.c_str(), nullptr, 10)));
    return Value(d);  // 3.0 is the integer 3, as in JavaScript
  }
};

Value parse(const std::string& text) { return Parser(text).document(); }

}  // namespace flurbo::json
