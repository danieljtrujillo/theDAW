// Structured-exception guard for calls into plugin code.
//
// A third-party VST3 that dereferences null must fail the session, not take the
// whole process down silently. __try/__except cannot live in a function that
// needs C++ unwinding, so the guard is a plain function and the caller passes a
// captureless thunk.
#pragma once

#include <type_traits>
#include <utility>

namespace thedaw::util {

using GuardedFn = void (*)(void* context);

// Returns 0 on success, otherwise the structured exception code.
unsigned long runGuarded(GuardedFn fn, void* context);

template <typename Fn>
unsigned long guarded(Fn&& fn) {
    using Callable = std::decay_t<Fn>;
    Callable callable(std::forward<Fn>(fn));
    GuardedFn thunk = [](void* context) { (*static_cast<Callable*>(context))(); };
    return runGuarded(thunk, &callable);
}

}  // namespace thedaw::util
