// Small shared primitives for theDAW's VST3 hosting layer: a reference-counting smart pointer
// for FUnknown-derived objects, a base class for the interfaces we hand to plugins, and the
// string/identifier conversions the VST3 ABI forces on us.
//
// Nothing here talks to a plugin. Everything here is ours.
#pragma once

#include <atomic>
#include <cstdint>
#include <string>

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/vst/vsttypes.h"

namespace thedaw::vst3 {

// ---------------------------------------------------------------------------------------------
// ComPtr — owning pointer for the FUnknown-style reference counting VST3 uses.
//
// Two ways in, because the ABI hands ownership over in two different ways:
//   ComPtr<T>::adopt(p)  — p already carries a reference for us (createInstance, queryInterface,
//                          GetPluginFactory): take it, do NOT addRef.
//   ComPtr<T> p(raw)     — borrow a pointer someone else owns: addRef.
// ---------------------------------------------------------------------------------------------
template <typename T>
class ComPtr {
public:
    ComPtr() = default;
    ComPtr(std::nullptr_t) {}

    explicit ComPtr(T* borrowed) : ptr_(borrowed) {
        if (ptr_ != nullptr) ptr_->addRef();
    }

    ComPtr(const ComPtr& other) : ComPtr(other.ptr_) {}

    ComPtr(ComPtr&& other) noexcept : ptr_(other.ptr_) { other.ptr_ = nullptr; }

    ~ComPtr() { reset(); }

    ComPtr& operator=(const ComPtr& other) {
        if (this != &other) {
            ComPtr copy(other);
            swap(copy);
        }
        return *this;
    }

    ComPtr& operator=(ComPtr&& other) noexcept {
        if (this != &other) {
            reset();
            ptr_ = other.ptr_;
            other.ptr_ = nullptr;
        }
        return *this;
    }

    // Takes over a reference that is already ours.
    static ComPtr adopt(T* owned) {
        ComPtr p;
        p.ptr_ = owned;
        return p;
    }

    void reset() {
        if (ptr_ != nullptr) {
            T* doomed = ptr_;
            ptr_ = nullptr;  // null first: release() can re-enter us during teardown
            doomed->release();
        }
    }

    void swap(ComPtr& other) noexcept {
        T* tmp = ptr_;
        ptr_ = other.ptr_;
        other.ptr_ = tmp;
    }

    T* get() const { return ptr_; }
    T* operator->() const { return ptr_; }
    explicit operator bool() const { return ptr_ != nullptr; }

private:
    T* ptr_ = nullptr;
};

// queryInterface wrapper: returns an owning ComPtr<Wanted>, empty when the object does not
// implement it. `Wanted::iid` comes from the vendored ABI headers.
template <typename Wanted, typename Source>
ComPtr<Wanted> queryFor(Source* source) {
    if (source == nullptr) return {};
    void* raw = nullptr;
    if (source->queryInterface(Wanted::iid, &raw) != Steinberg::kResultOk || raw == nullptr) {
        return {};
    }
    return ComPtr<Wanted>::adopt(static_cast<Wanted*>(raw));
}

// ---------------------------------------------------------------------------------------------
// HostObject — base for every object we implement and hand to a plugin (host context, component
// handler, streams, parameter queues, plug frame, messages).
//
// Lifetime note that matters: several of these are members of a longer-lived owner (the plugin
// instance) and MUST NOT be deleted when a plugin drops its last reference — a plugin that
// over-releases would otherwise free memory we still use. So the counter starts at 1 for the
// owner and `release()` never deletes; the owner's destructor frees the storage. Objects we do
// hand over as fresh allocations (IMessage / IAttributeList from createInstance) use
// HeapHostObject below, which does delete itself at zero.
// ---------------------------------------------------------------------------------------------
class HostObject {
public:
    virtual ~HostObject() = default;

protected:
    Steinberg::uint32 addRefImpl() { return ++refCount_; }
    Steinberg::uint32 releaseImpl() {
        const std::int32_t now = --refCount_;
        return static_cast<Steinberg::uint32>(now < 0 ? 0 : now);
    }

private:
    std::atomic<std::int32_t> refCount_{1};
};

// Same, but self-deleting: for objects whose ownership genuinely passes to the plugin.
class HeapHostObject {
public:
    virtual ~HeapHostObject() = default;

protected:
    Steinberg::uint32 addRefImpl() { return static_cast<Steinberg::uint32>(++refCount_); }
    Steinberg::uint32 releaseImpl() {
        const std::int32_t now = --refCount_;
        if (now <= 0) {
            delete this;
            return 0;
        }
        return static_cast<Steinberg::uint32>(now);
    }

private:
    std::atomic<std::int32_t> refCount_{1};
};

// Boilerplate for the two FUnknown methods every implemented interface needs. `Self` lists the
// interfaces this object answers to; FUnknown is always answered.
#define THEDAW_VST3_REFCOUNT(Base)                                                  \
    Steinberg::uint32 PLUGIN_API addRef() SMTG_OVERRIDE { return Base::addRefImpl(); } \
    Steinberg::uint32 PLUGIN_API release() SMTG_OVERRIDE { return Base::releaseImpl(); }

// Answers queryInterface for one interface. Use inside a queryInterface body.
#define THEDAW_VST3_OFFER(Interface)                                          \
    if (Steinberg::FUnknownPrivate::iidEqual(wantedIid, Interface::iid)) {          \
        addRef();                                                             \
        *obj = static_cast<Interface*>(this);                                 \
        return Steinberg::kResultOk;                                          \
    }

// ---------------------------------------------------------------------------------------------
// Strings and identifiers
// ---------------------------------------------------------------------------------------------

// VST3 string128 / TChar (UTF-16) -> UTF-8. `maxChars` bounds the scan for an unterminated field.
std::string fromVstString(const Steinberg::Vst::TChar* text, std::size_t maxChars = 128);

// A plugin's char8 fields (PClassInfo::name, vendor) are nominally ASCII but are not always
// NUL-terminated; bound the scan.
std::string fromAsciiField(const char* text, std::size_t maxChars);

// UTF-8 -> UTF-16 into a caller-owned Vst::String128 buffer (always NUL-terminated).
void toVstString128(const std::string& text, Steinberg::Vst::TChar* out);

// A VST3 class id is 16 opaque bytes; theDAW identifies plugins by its 32-character uppercase
// hex form. These two are exact inverses.
std::string cidToHex(const Steinberg::TUID& cid);
bool hexToCid(const std::string& hex, Steinberg::TUID& out);

}  // namespace thedaw::vst3
