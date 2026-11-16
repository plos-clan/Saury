#include <node_api.h>
#include <uv.h>
#include <cstdlib>

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

struct Loop {
    uv_prepare_t handle;
    napi_env env;
    napi_ref resource;
    napi_async_context context;
    napi_async_cleanup_hook_handle cleanup;
};

static void prepare(uv_prepare_t* handle) {
    auto* loop = static_cast<Loop*>(handle->data);
    napi_handle_scope handles;
    if (napi_open_handle_scope(loop->env, &handles) != napi_ok) return;
    napi_callback_scope callbacks;
    auto status = napi_open_callback_scope(
        loop->env, nullptr, loop->context, &callbacks);
    if (status == napi_ok) napi_close_callback_scope(loop->env, callbacks);
    napi_close_handle_scope(loop->env, handles);
}

static void close(napi_async_cleanup_hook_handle cleanup, void* data) {
    auto* loop = static_cast<Loop*>(data);
    if (loop->context) napi_async_destroy(loop->env, loop->context);
    if (loop->resource) napi_delete_reference(loop->env, loop->resource);
    if (!cleanup) return std::free(loop);
    auto* handle = reinterpret_cast<uv_handle_t*>(&loop->handle);
    uv_close(handle, [](uv_handle_t* handle) {
        auto* loop = static_cast<Loop*>(handle->data);
        napi_remove_async_cleanup_hook(loop->cleanup);
        std::free(loop);
    });
}

NAPI_MODULE_INIT() {
    auto* loop = static_cast<Loop*>(std::calloc(1, sizeof(Loop)));
    const auto fail = [env, loop]() -> napi_value {
        if (loop) close(nullptr, loop);
        napi_throw_error(env, nullptr, "Could not initialize QQ event loop");
        return nullptr;
    };
    if (!loop) return fail();
    loop->env = env;
    napi_value name;
    uv_loop_t* uv;
    auto status = napi_create_string_utf8(
        env, "saury:qq", NAPI_AUTO_LENGTH, &name);
    if (status != napi_ok) return fail();
    if (napi_create_reference(env, exports, 1, &loop->resource) != napi_ok) {
        return fail();
    }
    if (napi_async_init(env, exports, name, &loop->context) != napi_ok) {
        return fail();
    }
    if (napi_get_uv_event_loop(env, &uv) != napi_ok) return fail();
    status = napi_add_async_cleanup_hook(env, close, loop, &loop->cleanup);
    if (status != napi_ok) return fail();
    uv_prepare_init(uv, &loop->handle);
    loop->handle.data = loop;
    uv_prepare_start(&loop->handle, prepare);
    uv_unref(reinterpret_cast<uv_handle_t*>(&loop->handle));
    return exports;
}
