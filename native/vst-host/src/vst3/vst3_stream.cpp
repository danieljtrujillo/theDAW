#include "vst3_stream.h"

#include <cstring>
#include <limits>

#include "vst3_iid_log.h"

namespace thedaw::vst3 {

Steinberg::tresult PLUGIN_API MemoryStream::queryInterface(const Steinberg::TUID wantedIid, void** obj) {
    return iidlog::seen("stream", wantedIid, queryInterfaceInner(wantedIid, obj));
}

Steinberg::tresult MemoryStream::queryInterfaceInner(const Steinberg::TUID wantedIid, void** obj) {
    if (obj == nullptr) return Steinberg::kInvalidArgument;
    *obj = nullptr;
    THEDAW_VST3_OFFER(Steinberg::IBStream)
    THEDAW_VST3_OFFER(Steinberg::FUnknown)
    return Steinberg::kNoInterface;
}

Steinberg::tresult PLUGIN_API MemoryStream::read(void* buffer, Steinberg::int32 numBytes,
                                                 Steinberg::int32* numBytesRead) {
    if (numBytesRead != nullptr) *numBytesRead = 0;
    if (numBytes < 0) return Steinberg::kInvalidArgument;
    if (numBytes == 0) return Steinberg::kResultOk;
    if (buffer == nullptr) return Steinberg::kInvalidArgument;

    const std::size_t available = cursor_ < bytes_.size() ? bytes_.size() - cursor_ : 0;
    const std::size_t take =
        available < static_cast<std::size_t>(numBytes) ? available : static_cast<std::size_t>(numBytes);
    if (take > 0) {
        std::memcpy(buffer, bytes_.data() + cursor_, take);
        cursor_ += take;
    }
    if (numBytesRead != nullptr) *numBytesRead = static_cast<Steinberg::int32>(take);
    // A short read is not an error here: plugins routinely ask for more than is left and
    // decide what to do from the count. Only a null buffer is a caller mistake.
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API MemoryStream::write(void* buffer, Steinberg::int32 numBytes,
                                                  Steinberg::int32* numBytesWritten) {
    if (numBytesWritten != nullptr) *numBytesWritten = 0;
    if (numBytes < 0) return Steinberg::kInvalidArgument;
    if (numBytes == 0) return Steinberg::kResultOk;
    if (buffer == nullptr) return Steinberg::kInvalidArgument;

    const std::size_t count = static_cast<std::size_t>(numBytes);
    const std::size_t end = cursor_ + count;
    if (end < cursor_) return Steinberg::kOutOfMemory;  // wrapped
    if (end > bytes_.size()) {
        // A plugin that hands us an absurd size must not be allowed to kill the process with
        // a length_error/bad_alloc out of vector.
        try {
            bytes_.resize(end, 0);
        } catch (...) {
            return Steinberg::kOutOfMemory;
        }
    }
    std::memcpy(bytes_.data() + cursor_, buffer, count);
    cursor_ = end;
    if (numBytesWritten != nullptr) *numBytesWritten = numBytes;
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API MemoryStream::seek(Steinberg::int64 pos, Steinberg::int32 mode,
                                                 Steinberg::int64* result) {
    Steinberg::int64 base = 0;
    switch (mode) {
        case kIBSeekSet: base = 0; break;
        case kIBSeekCur: base = static_cast<Steinberg::int64>(cursor_); break;
        case kIBSeekEnd: base = static_cast<Steinberg::int64>(bytes_.size()); break;
        default: return Steinberg::kInvalidArgument;
    }
    const Steinberg::int64 target = base + pos;
    // Seeking past the end is legal in IBStream (a following write extends the buffer);
    // seeking before the start is not.
    if (target < 0) return Steinberg::kInvalidArgument;
    if (static_cast<std::uint64_t>(target) > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        return Steinberg::kInvalidArgument;
    }
    cursor_ = static_cast<std::size_t>(target);
    if (result != nullptr) *result = target;
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API MemoryStream::tell(Steinberg::int64* pos) {
    if (pos == nullptr) return Steinberg::kInvalidArgument;
    *pos = static_cast<Steinberg::int64>(cursor_);
    return Steinberg::kResultOk;
}

}  // namespace thedaw::vst3
