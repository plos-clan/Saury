NODE_EXECUTABLE := $(shell node -p 'process.execPath')
NODE_INCLUDE ?= $(abspath $(dir $(NODE_EXECUTABLE))../include/node)
CXXFLAGS += -Os -std=c++23 -shared -fPIC -fvisibility=hidden
CXXFLAGS += -fno-exceptions -fno-rtti -nostdlib
CXXFLAGS += -Wl,-z,relro,-z,now -I"$(NODE_INCLUDE)"
TARGET = ../../dist/saury.so

$(TARGET): stub.cc Makefile
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $< -o $@
