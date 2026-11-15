#include <node_api.h>

#define EXPORT __attribute__((visibility("default")))

extern "C" EXPORT void qq_magic_napi_register(napi_module* module) {
    napi_module_register(module);
}

namespace v8 {
class Isolate;
}

namespace node {
EXPORT bool IsEnvironmentStopping(v8::Isolate*) {
    return false;
}
}
