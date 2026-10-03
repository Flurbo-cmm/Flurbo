# Flurbo agent SDK for C++. GNU make with GCC or Clang (C++20, __int128) and OpenSSL 3.2 or later.
#   make            the library, the flurbo-agent-cpp runner and the examples
#   make test       conformance and runtime unit tests (the local-chain test runs with make test-chain)
# On Windows (MSYS2 UCRT64): mingw32-make, with C:\msys64\ucrt64\bin on PATH.

CXX ?= g++
CXXFLAGS ?= -std=c++20 -O2 -Wall -Wextra -Wno-deprecated-declarations
CPPFLAGS += -Iinclude
BUILD := build
ifeq ($(OS),Windows_NT)
  EXE := .exe
  LDLIBS += -lssl -lcrypto -lws2_32 -lcrypt32
else
  EXE :=
  LDLIBS += -lssl -lcrypto -lpthread
endif

LIB_SRC := $(wildcard src/*.cpp)
LIB_OBJ := $(patsubst src/%.cpp,$(BUILD)/%.o,$(LIB_SRC))
LIB := $(BUILD)/libflurbo.a
HEADERS := $(wildcard include/flurbo/*.hpp)
TESTS := conformance runtime_units local_chain
EXAMPLES := offline_pipeline ai_agent custom_strategy

all: $(BUILD)/flurbo-agent-cpp$(EXE) $(foreach e,$(EXAMPLES),$(BUILD)/$(e)$(EXE))

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/%.o: src/%.cpp $(HEADERS) | $(BUILD)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -c $< -o $@

$(LIB): $(LIB_OBJ)
	ar rcs $@ $^

$(BUILD)/flurbo-agent-cpp$(EXE): tools/main.cpp $(LIB)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) $(LDFLAGS) $< $(LIB) $(LDLIBS) -o $@

$(BUILD)/%$(EXE): examples/%.cpp $(LIB)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) $(LDFLAGS) $< $(LIB) $(LDLIBS) -o $@

$(BUILD)/test_%$(EXE): tests/%.cpp tests/check.hpp $(LIB)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -DFLURBO_FIXTURES='"$(CURDIR)/../../protocol/fixtures"' -DFLURBO_REPO='"$(CURDIR)/../.."' $(LDFLAGS) $< $(LIB) $(LDLIBS) -o $@

test: $(BUILD)/test_conformance$(EXE) $(BUILD)/test_runtime_units$(EXE)
	$(BUILD)/test_conformance$(EXE)
	$(BUILD)/test_runtime_units$(EXE)

test-chain: $(BUILD)/test_local_chain$(EXE)
	$(BUILD)/test_local_chain$(EXE)

clean:
	rm -rf $(BUILD)

.PHONY: all test test-chain clean
.SECONDARY: $(LIB_OBJ)
