#include "vst3_guard.h"

#include <windows.h>

namespace thedaw::vst3 {

// Deliberately free of anything with a destructor: MSVC refuses __try in a function that needs
// object unwinding, and that restriction is the reason this lives in its own translation unit.
bool runGuarded(GuardedCall call, void* context, std::uint32_t& faultCode) {
    faultCode = 0;
    if (call == nullptr) return false;
    __try {
        call(context);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        faultCode = static_cast<std::uint32_t>(GetExceptionCode());
        return false;
    }
}

const char* describeFault(std::uint32_t faultCode) {
    switch (faultCode) {
        case 0xC0000005u: return "access violation";
        case 0xC000001Du: return "illegal instruction";
        case 0xC0000094u: return "integer divide by zero";
        case 0xC0000096u: return "privileged instruction";
        case 0xC00000FDu: return "stack overflow";
        case 0xC0000374u: return "heap corruption";
        default: return "hardware fault";
    }
}

}  // namespace thedaw::vst3
