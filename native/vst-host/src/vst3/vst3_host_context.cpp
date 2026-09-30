#include "vst3_host_context.h"

#include <cstring>
#include <mutex>

#include "vst3_iid_log.h"

namespace thedaw::vst3 {
namespace {

constexpr const char* kDefaultHostName = "theDAW";

std::mutex& hostNameMutex() {
    static std::mutex m;
    return m;
}

std::string& hostNameStorage() {
    static std::string name = kDefaultHostName;
    return name;
}

}  // namespace

void setHostApplicationName(const std::string& name) {
    std::lock_guard<std::mutex> lock(hostNameMutex());
    hostNameStorage() = name.empty() ? kDefaultHostName : name;
}

std::string hostApplicationName() {
    std::lock_guard<std::mutex> lock(hostNameMutex());
    return hostNameStorage();
}

// ------------------------------------------------------------------------------------------
// AttributeList
// ------------------------------------------------------------------------------------------

AttributeList::Entry* AttributeList::find(const char* key) {
    if (key == nullptr) return nullptr;
    for (Entry& entry : entries_) {
        if (entry.key == key) return &entry;
    }
    return nullptr;
}

AttributeList::Entry& AttributeList::findOrCreate(const char* key) {
    if (Entry* existing = find(key)) return *existing;
    entries_.push_back(Entry{});
    entries_.back().key = key != nullptr ? key : "";
    return entries_.back();
}

Steinberg::tresult PLUGIN_API AttributeList::queryInterface(const Steinberg::TUID wantedIid, void** obj) {
    return iidlog::seen("attribute_list", wantedIid, queryInterfaceInner(wantedIid, obj));
}

Steinberg::tresult AttributeList::queryInterfaceInner(const Steinberg::TUID wantedIid, void** obj) {
    if (obj == nullptr) return Steinberg::kInvalidArgument;
    *obj = nullptr;
    THEDAW_VST3_OFFER(Steinberg::Vst::IAttributeList)
    THEDAW_VST3_OFFER(Steinberg::FUnknown)
    return Steinberg::kNoInterface;
}

Steinberg::tresult PLUGIN_API AttributeList::setInt(Steinberg::Vst::IAttributeList::AttrID id,
                                                    Steinberg::int64 value) {
    if (id == nullptr) return Steinberg::kInvalidArgument;
    Entry& entry = findOrCreate(id);
    entry.kind = Kind::integer;
    entry.integer = value;
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API AttributeList::getInt(Steinberg::Vst::IAttributeList::AttrID id,
                                                    Steinberg::int64& value) {
    Entry* entry = find(id);
    if (entry == nullptr || entry->kind != Kind::integer) return Steinberg::kResultFalse;
    value = entry->integer;
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API AttributeList::setFloat(Steinberg::Vst::IAttributeList::AttrID id,
                                                      double value) {
    if (id == nullptr) return Steinberg::kInvalidArgument;
    Entry& entry = findOrCreate(id);
    entry.kind = Kind::real;
    entry.real = value;
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API AttributeList::getFloat(Steinberg::Vst::IAttributeList::AttrID id,
                                                      double& value) {
    Entry* entry = find(id);
    if (entry == nullptr || entry->kind != Kind::real) return Steinberg::kResultFalse;
    value = entry->real;
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API AttributeList::setString(Steinberg::Vst::IAttributeList::AttrID id,
                                                       const Steinberg::Vst::TChar* string) {
    if (id == nullptr || string == nullptr) return Steinberg::kInvalidArgument;
    Entry& entry = findOrCreate(id);
    entry.kind = Kind::text;
    entry.text.clear();
    // No length is supplied, so trust the NUL but refuse to scan forever if there is not one.
    constexpr std::size_t kMaxChars = 1u << 20;
    std::size_t length = 0;
    while (length < kMaxChars && string[length] != 0) ++length;
    entry.text.assign(string, string + length);
    entry.text.push_back(0);
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API AttributeList::getString(Steinberg::Vst::IAttributeList::AttrID id,
                                                       Steinberg::Vst::TChar* string,
                                                       Steinberg::uint32 sizeInBytes) {
    Entry* entry = find(id);
    if (entry == nullptr || entry->kind != Kind::text || string == nullptr) {
        return Steinberg::kResultFalse;
    }
    const std::size_t capacityChars = sizeInBytes / sizeof(Steinberg::Vst::TChar);
    if (capacityChars == 0) return Steinberg::kResultFalse;
    // entry.text always ends in a NUL; copy as much as fits and re-terminate.
    const std::size_t copyChars =
        entry->text.size() <= capacityChars ? entry->text.size() : capacityChars;
    std::memcpy(string, entry->text.data(), copyChars * sizeof(Steinberg::Vst::TChar));
    string[copyChars - 1] = 0;
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API AttributeList::setBinary(Steinberg::Vst::IAttributeList::AttrID id,
                                                       const void* data, Steinberg::uint32 sizeInBytes) {
    if (id == nullptr || (data == nullptr && sizeInBytes > 0)) return Steinberg::kInvalidArgument;
    Entry& entry = findOrCreate(id);
    entry.kind = Kind::binary;
    const std::uint8_t* bytes = static_cast<const std::uint8_t*>(data);
    try {
        entry.binary.assign(bytes, bytes + sizeInBytes);
    } catch (...) {
        return Steinberg::kOutOfMemory;
    }
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API AttributeList::getBinary(Steinberg::Vst::IAttributeList::AttrID id,
                                                       const void*& data, Steinberg::uint32& sizeInBytes) {
    Entry* entry = find(id);
    if (entry == nullptr || entry->kind != Kind::binary) return Steinberg::kResultFalse;
    data = entry->binary.data();
    sizeInBytes = static_cast<Steinberg::uint32>(entry->binary.size());
    return Steinberg::kResultOk;
}

// ------------------------------------------------------------------------------------------
// HostMessage
// ------------------------------------------------------------------------------------------

HostMessage::HostMessage() : attributes_(new AttributeList()) {}

HostMessage::~HostMessage() {
    if (attributes_ != nullptr) attributes_->release();
}

Steinberg::tresult PLUGIN_API HostMessage::queryInterface(const Steinberg::TUID wantedIid, void** obj) {
    return iidlog::seen("message", wantedIid, queryInterfaceInner(wantedIid, obj));
}

Steinberg::tresult HostMessage::queryInterfaceInner(const Steinberg::TUID wantedIid, void** obj) {
    if (obj == nullptr) return Steinberg::kInvalidArgument;
    *obj = nullptr;
    THEDAW_VST3_OFFER(Steinberg::Vst::IMessage)
    THEDAW_VST3_OFFER(Steinberg::FUnknown)
    return Steinberg::kNoInterface;
}

Steinberg::FIDString PLUGIN_API HostMessage::getMessageID() {
    return messageId_.empty() ? nullptr : messageId_.c_str();
}

void PLUGIN_API HostMessage::setMessageID(Steinberg::FIDString id) {
    messageId_ = id != nullptr ? id : "";
}

Steinberg::Vst::IAttributeList* PLUGIN_API HostMessage::getAttributes() { return attributes_; }

// ------------------------------------------------------------------------------------------
// HostApplication
// ------------------------------------------------------------------------------------------

Steinberg::tresult PLUGIN_API HostApplication::queryInterface(const Steinberg::TUID wantedIid, void** obj) {
    return iidlog::seen("host_context", wantedIid, queryInterfaceInner(wantedIid, obj));
}

Steinberg::tresult HostApplication::queryInterfaceInner(const Steinberg::TUID wantedIid, void** obj) {
    if (obj == nullptr) return Steinberg::kInvalidArgument;
    *obj = nullptr;
    THEDAW_VST3_OFFER(Steinberg::Vst::IHostApplication)
    THEDAW_VST3_OFFER(Steinberg::FUnknown)
    return Steinberg::kNoInterface;
}

Steinberg::tresult PLUGIN_API HostApplication::getName(Steinberg::Vst::String128 name) {
    toVstString128(hostApplicationName(), name);
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API HostApplication::createInstance(Steinberg::TUID cid, Steinberg::TUID requestedIid,
                                                              void** obj) {
    if (obj == nullptr) return Steinberg::kInvalidArgument;
    *obj = nullptr;
    // The two things a plugin is allowed to ask the host to make. Ownership passes to the
    // plugin, which is why these are the self-deleting flavour of host object.
    if (Steinberg::FUnknownPrivate::iidEqual(cid, Steinberg::Vst::IMessage::iid) &&
        Steinberg::FUnknownPrivate::iidEqual(requestedIid, Steinberg::Vst::IMessage::iid)) {
        *obj = static_cast<Steinberg::Vst::IMessage*>(new HostMessage());
        return Steinberg::kResultOk;
    }
    if (Steinberg::FUnknownPrivate::iidEqual(cid, Steinberg::Vst::IAttributeList::iid) &&
        Steinberg::FUnknownPrivate::iidEqual(requestedIid, Steinberg::Vst::IAttributeList::iid)) {
        *obj = static_cast<Steinberg::Vst::IAttributeList*>(new AttributeList());
        return Steinberg::kResultOk;
    }
    return Steinberg::kNotImplemented;
}

// ------------------------------------------------------------------------------------------
// ComponentHandler
// ------------------------------------------------------------------------------------------

Steinberg::tresult PLUGIN_API ComponentHandler::queryInterface(const Steinberg::TUID wantedIid, void** obj) {
    return iidlog::seen("component_handler", wantedIid, queryInterfaceInner(wantedIid, obj));
}

Steinberg::tresult ComponentHandler::queryInterfaceInner(const Steinberg::TUID wantedIid, void** obj) {
    if (obj == nullptr) return Steinberg::kInvalidArgument;
    *obj = nullptr;
    THEDAW_VST3_OFFER(Steinberg::Vst::IComponentHandler)
    THEDAW_VST3_OFFER(Steinberg::Vst::IComponentHandler2)
    if (Steinberg::FUnknownPrivate::iidEqual(wantedIid, Steinberg::FUnknown::iid)) {
        addRef();
        *obj = static_cast<Steinberg::Vst::IComponentHandler*>(this);
        return Steinberg::kResultOk;
    }
    return Steinberg::kNoInterface;
}

Steinberg::tresult PLUGIN_API ComponentHandler::beginEdit(Steinberg::Vst::ParamID id) {
    if (sink_ != nullptr) sink_->handleBeginEdit(id);
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API ComponentHandler::performEdit(Steinberg::Vst::ParamID id,
                                                            Steinberg::Vst::ParamValue valueNormalized) {
    if (sink_ != nullptr) sink_->handlePerformEdit(id, valueNormalized);
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API ComponentHandler::endEdit(Steinberg::Vst::ParamID id) {
    if (sink_ != nullptr) sink_->handleEndEdit(id);
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API ComponentHandler::restartComponent(Steinberg::int32 flags) {
    if (sink_ == nullptr) return Steinberg::kResultFalse;
    sink_->handleRestartComponent(flags);
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API ComponentHandler::setDirty(Steinberg::TBool state) {
    dirty_ = state != 0;
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API ComponentHandler::requestOpenEditor(Steinberg::FIDString /*name*/) {
    // The app decides when an editor opens (an editor belongs to a chain entry's UI row), so a
    // plugin asking for one is acknowledged but not acted on.
    return Steinberg::kResultFalse;
}

// kResultFalse, as JUCE answers: this host does not group edits, and saying it does lets a plugin
// skip the per-parameter beginEdit/endEdit it would otherwise send.
Steinberg::tresult PLUGIN_API ComponentHandler::startGroupEdit() { return Steinberg::kResultFalse; }

Steinberg::tresult PLUGIN_API ComponentHandler::finishGroupEdit() { return Steinberg::kResultFalse; }

}  // namespace thedaw::vst3
