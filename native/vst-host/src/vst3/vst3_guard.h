// A hard guard around plugin calls that take untrusted bytes.
//
// Why this exists: a state blob is data from a project file, and a plugin's setState() is the
// one place a host hands a plugin a buffer it did not produce. Several real plugins parse that
// buffer without validating it. Measured on this machine: handing Accentize dxRevive Pro a
// well-formed container whose component bytes came from a different host faults inside the
// plugin's own setState() and takes the process down. The host is required to answer a foreign
// blob with a clear error, so the fault has to be contained.
//
// Windows structured exception handling is the only thing that can contain an access violation;
// a C++ catch cannot. It is used ONLY here, around single plugin calls on the message thread,
// never on the audio path.
//
// After a caught fault the plugin is in an undefined state: the caller must treat the instance
// as unusable for that operation and say so, not carry on as if the call merely returned an
// error code.
#pragma once

#include <cstdint>

namespace thedaw::vst3 {

using GuardedCall = void (*)(void* context);

// Runs `call(context)`. Returns true when it completed, false when it faulted; `faultCode` then
// holds the Windows exception code (0xC0000005 is an access violation).
bool runGuarded(GuardedCall call, void* context, std::uint32_t& faultCode);

// Human-readable name for the codes we expect to see.
const char* describeFault(std::uint32_t faultCode);

}  // namespace thedaw::vst3
