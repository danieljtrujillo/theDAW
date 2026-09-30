// An IBStream over a std::vector<uint8_t>. This is how state crosses the ABI: the plugin
// writes its component/controller state into one of these (getState), and reads it back out
// of one (setState / setComponentState).
//
// It is a member of whatever is doing the state call, never heap-owned by the plugin, so it
// uses HostObject (release() does not delete).
#pragma once

#include <cstdint>
#include <vector>

#include "pluginterfaces/base/ibstream.h"

#include "vst3_common.h"

namespace thedaw::vst3 {

class MemoryStream final : public Steinberg::IBStream, public HostObject {
public:
    MemoryStream() = default;
    MemoryStream(const std::uint8_t* data, std::size_t size) : bytes_(data, data + size) {}

    const std::vector<std::uint8_t>& bytes() const { return bytes_; }
    std::vector<std::uint8_t> takeBytes() { return std::move(bytes_); }
    void rewind() { cursor_ = 0; }

    // ---- FUnknown ----
    Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID wantedIid, void** obj) SMTG_OVERRIDE;
    THEDAW_VST3_REFCOUNT(HostObject)

    // ---- IBStream ----
    Steinberg::tresult PLUGIN_API read(void* buffer, Steinberg::int32 numBytes,
                                       Steinberg::int32* numBytesRead) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API write(void* buffer, Steinberg::int32 numBytes,
                                        Steinberg::int32* numBytesWritten) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API seek(Steinberg::int64 pos, Steinberg::int32 mode,
                                       Steinberg::int64* result) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API tell(Steinberg::int64* pos) SMTG_OVERRIDE;

private:
    Steinberg::tresult queryInterfaceInner(const Steinberg::TUID wantedIid, void** obj);

    std::vector<std::uint8_t> bytes_;
    std::size_t cursor_ = 0;
};

}  // namespace thedaw::vst3
