#include "SehGuard.h"

#include <windows.h>

namespace thedaw::util {

// No C++ objects with destructors live in this frame, which is what lets
// __try/__except coexist with /EHsc in the rest of the program.
unsigned long runGuarded(GuardedFn fn, void* context) {
    if (fn == nullptr) return 0;
    __try {
        fn(context);
        return 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return static_cast<unsigned long>(GetExceptionCode());
    }
}

}  // namespace thedaw::util
