// The objects theDAW hands to a plugin so it can talk back to us:
//
//   HostApplication  — IHostApplication. Tells the plugin who is hosting it and manufactures
//                      the IMessage / IAttributeList objects the component and controller use
//                      to talk to each other.
//   ComponentHandler — IComponentHandler + IComponentHandler2. Where editor edits
//                      (beginEdit/performEdit/endEdit) and restart requests arrive.
//
// Both may be called from threads we do not control, so everything here is either trivially
// thread-safe or hands straight off to the sink, which is responsible for getting back onto
// the message thread.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "pluginterfaces/vst/ivstattributes.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstmessage.h"

#include "vst3_common.h"

namespace thedaw::vst3 {

// Implemented by the plugin instance. Every method may be called from any thread.
class HandlerSink {
public:
    virtual ~HandlerSink() = default;
    virtual void handleBeginEdit(Steinberg::Vst::ParamID id) = 0;
    virtual void handlePerformEdit(Steinberg::Vst::ParamID id, double normalizedValue) = 0;
    virtual void handleEndEdit(Steinberg::Vst::ParamID id) = 0;
    virtual void handleRestartComponent(Steinberg::int32 flags) = 0;
};

// ------------------------------------------------------------------------------------------
// IAttributeList / IMessage
//
// These two exist only so the component and the controller halves of a plugin can pass each
// other typed key/value bags. We never look inside; we just have to store faithfully and hand
// back exactly what went in, including binary blobs.
// ------------------------------------------------------------------------------------------
class AttributeList final : public Steinberg::Vst::IAttributeList, public HeapHostObject {
public:
    Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID wantedIid, void** obj) SMTG_OVERRIDE;
    THEDAW_VST3_REFCOUNT(HeapHostObject)

    Steinberg::tresult PLUGIN_API setInt(Steinberg::Vst::IAttributeList::AttrID id,
                                         Steinberg::int64 value) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API getInt(Steinberg::Vst::IAttributeList::AttrID id,
                                         Steinberg::int64& value) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API setFloat(Steinberg::Vst::IAttributeList::AttrID id,
                                           double value) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API getFloat(Steinberg::Vst::IAttributeList::AttrID id,
                                           double& value) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API setString(Steinberg::Vst::IAttributeList::AttrID id,
                                            const Steinberg::Vst::TChar* string) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API getString(Steinberg::Vst::IAttributeList::AttrID id,
                                            Steinberg::Vst::TChar* string,
                                            Steinberg::uint32 sizeInBytes) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API setBinary(Steinberg::Vst::IAttributeList::AttrID id,
                                            const void* data, Steinberg::uint32 sizeInBytes) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API getBinary(Steinberg::Vst::IAttributeList::AttrID id,
                                            const void*& data, Steinberg::uint32& sizeInBytes) SMTG_OVERRIDE;

private:
    Steinberg::tresult queryInterfaceInner(const Steinberg::TUID wantedIid, void** obj);

    enum class Kind { integer, real, text, binary };

    struct Entry {
        std::string key;
        Kind kind = Kind::integer;
        Steinberg::int64 integer = 0;
        double real = 0.0;
        std::vector<Steinberg::Vst::TChar> text;  // UTF-16, NUL-terminated
        std::vector<std::uint8_t> binary;
    };

    Entry* find(const char* key);
    Entry& findOrCreate(const char* key);

    std::vector<Entry> entries_;
};

class HostMessage final : public Steinberg::Vst::IMessage, public HeapHostObject {
public:
    HostMessage();
    ~HostMessage() override;

    Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID wantedIid, void** obj) SMTG_OVERRIDE;
    THEDAW_VST3_REFCOUNT(HeapHostObject)

    Steinberg::FIDString PLUGIN_API getMessageID() SMTG_OVERRIDE;
    void PLUGIN_API setMessageID(Steinberg::FIDString id) SMTG_OVERRIDE;
    Steinberg::Vst::IAttributeList* PLUGIN_API getAttributes() SMTG_OVERRIDE;

private:
    Steinberg::tresult queryInterfaceInner(const Steinberg::TUID wantedIid, void** obj);

    std::string messageId_;
    AttributeList* attributes_ = nullptr;  // owned: released in the destructor
};

// ------------------------------------------------------------------------------------------
// IHostApplication
// ------------------------------------------------------------------------------------------
class HostApplication final : public Steinberg::Vst::IHostApplication, public HostObject {
public:
    Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID wantedIid, void** obj) SMTG_OVERRIDE;
    THEDAW_VST3_REFCOUNT(HostObject)

    Steinberg::tresult PLUGIN_API getName(Steinberg::Vst::String128 name) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API createInstance(Steinberg::TUID cid, Steinberg::TUID requestedIid,
                                                 void** obj) SMTG_OVERRIDE;

private:
    Steinberg::tresult queryInterfaceInner(const Steinberg::TUID wantedIid, void** obj);
};

// The name this host reports through IHostApplication::getName(). Process-wide because the
// plugin asks for it through an object it was handed, not through an argument we control.
// Overridable so the state-interchange experiment can present another host's name without a
// rebuild; "theDAW" unless someone says otherwise.
void setHostApplicationName(const std::string& name);
std::string hostApplicationName();

// ------------------------------------------------------------------------------------------
// IComponentHandler / IComponentHandler2
// ------------------------------------------------------------------------------------------
class ComponentHandler final : public Steinberg::Vst::IComponentHandler,
                               public Steinberg::Vst::IComponentHandler2,
                               public HostObject {
public:
    explicit ComponentHandler(HandlerSink* sink) : sink_(sink) {}

    // Called when the instance is going away: no further callbacks reach the sink. A plugin can
    // keep a reference to the handler past our teardown, so this must be safe to leave dangling.
    void detach() { sink_ = nullptr; }

    Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID wantedIid, void** obj) SMTG_OVERRIDE;
    THEDAW_VST3_REFCOUNT(HostObject)

    // ---- IComponentHandler ----
    Steinberg::tresult PLUGIN_API beginEdit(Steinberg::Vst::ParamID id) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API performEdit(Steinberg::Vst::ParamID id,
                                              Steinberg::Vst::ParamValue valueNormalized) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API endEdit(Steinberg::Vst::ParamID id) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API restartComponent(Steinberg::int32 flags) SMTG_OVERRIDE;

    // ---- IComponentHandler2 ----
    Steinberg::tresult PLUGIN_API setDirty(Steinberg::TBool state) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API requestOpenEditor(Steinberg::FIDString name) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API startGroupEdit() SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API finishGroupEdit() SMTG_OVERRIDE;

    bool isDirty() const { return dirty_; }
    void clearDirty() { dirty_ = false; }

private:
    Steinberg::tresult queryInterfaceInner(const Steinberg::TUID wantedIid, void** obj);

    HandlerSink* sink_ = nullptr;
    bool dirty_ = false;
};

}  // namespace thedaw::vst3
