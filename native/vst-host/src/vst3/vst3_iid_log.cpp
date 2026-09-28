#include "vst3_iid_log.h"

#include <atomic>
#include <cstring>
#include <mutex>

// Only the headers are needed: DECLARE_CLASS_IID leaves a `<Interface>_iid` TUID constant behind
// in every translation unit that includes it, so naming an interface costs no IID definition and
// cannot collide with the ones vst3_iids.cpp owns.
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/base/icloneable.h"
#include "pluginterfaces/base/ierrorcontext.h"
#include "pluginterfaces/base/ipersistent.h"
#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/base/iplugincompatibility.h"
#include "pluginterfaces/base/istringresult.h"
#include "pluginterfaces/base/iupdatehandler.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"
#include "pluginterfaces/vst/ivstattributes.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstautomationstate.h"
#include "pluginterfaces/vst/ivstchannelcontextinfo.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivstcontextmenu.h"
#include "pluginterfaces/vst/ivstdataexchange.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstinterappaudio.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstmidilearn.h"
#include "pluginterfaces/vst/ivstmidimapping2.h"
#include "pluginterfaces/vst/ivstnoteexpression.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/ivstparameterfunctionname.h"
#include "pluginterfaces/vst/ivstphysicalui.h"
#include "pluginterfaces/vst/ivstpluginterfacesupport.h"
#include "pluginterfaces/vst/ivstplugview.h"
#include "pluginterfaces/vst/ivstprefetchablesupport.h"
#include "pluginterfaces/vst/ivstremapparamid.h"
// This vendored header's RepresentationInfo constructor copies into its fixed char arrays with
// strcpy. The library builds with _CRT_SECURE_CPP_OVERLOAD_STANDARD_NAMES (see CMakeLists.txt),
// so those calls resolve to the CRT's bounded strcpy_s template overload.
#include "pluginterfaces/vst/ivstrepresentation.h"
#include "pluginterfaces/vst/ivsttransportcontrol.h"
#include "pluginterfaces/vst/ivstunits.h"

namespace thedaw::vst3::iidlog {
namespace {

constexpr char kHexDigits[] = "0123456789ABCDEF";

struct KnownIid {
    const Steinberg::TUID* iid;
    const char* name;
};

// Everything a plugin has a reason to ask a host for, plus the plugin-side interfaces that show
// up when a plugin probes an object we passed it. An id missing from here still gets logged —
// with an empty name, which is itself the finding.
const KnownIid* knownTable(std::size_t& count) {
    static const KnownIid table[] = {
        {&Steinberg::FUnknown_iid, "FUnknown"},
        {&Steinberg::IBStream_iid, "IBStream"},
        {&Steinberg::ISizeableStream_iid, "ISizeableStream"},
        {&Steinberg::ICloneable_iid, "ICloneable"},
        {&Steinberg::IErrorContext_iid, "IErrorContext"},
        {&Steinberg::IPersistent_iid, "IPersistent"},
        {&Steinberg::IAttributes_iid, "IAttributes"},
        {&Steinberg::IPluginBase_iid, "IPluginBase"},
        {&Steinberg::IPluginFactory_iid, "IPluginFactory"},
        {&Steinberg::IPluginFactory2_iid, "IPluginFactory2"},
        {&Steinberg::IPluginFactory3_iid, "IPluginFactory3"},
        {&Steinberg::IPluginCompatibility_iid, "IPluginCompatibility"},
        {&Steinberg::IStringResult_iid, "IStringResult"},
        {&Steinberg::IString_iid, "IString"},
        {&Steinberg::IUpdateHandler_iid, "IUpdateHandler"},
        {&Steinberg::IDependent_iid, "IDependent"},
        {&Steinberg::IPlugView_iid, "IPlugView"},
        {&Steinberg::IPlugFrame_iid, "IPlugFrame"},
        {&Steinberg::IPlugViewContentScaleSupport_iid, "IPlugViewContentScaleSupport"},
        {&Steinberg::Vst::IComponent_iid, "IComponent"},
        {&Steinberg::Vst::IAudioProcessor_iid, "IAudioProcessor"},
        {&Steinberg::Vst::IAudioPresentationLatency_iid, "IAudioPresentationLatency"},
        {&Steinberg::Vst::IProcessContextRequirements_iid, "IProcessContextRequirements"},
        {&Steinberg::Vst::IEditController_iid, "IEditController"},
        {&Steinberg::Vst::IEditController2_iid, "IEditController2"},
        {&Steinberg::Vst::IEditControllerHostEditing_iid, "IEditControllerHostEditing"},
        {&Steinberg::Vst::IComponentHandler_iid, "IComponentHandler"},
        {&Steinberg::Vst::IComponentHandler2_iid, "IComponentHandler2"},
        {&Steinberg::Vst::IComponentHandler3_iid, "IComponentHandler3"},
        {&Steinberg::Vst::IComponentHandlerBusActivation_iid, "IComponentHandlerBusActivation"},
        {&Steinberg::Vst::IComponentHandlerSystemTime_iid, "IComponentHandlerSystemTime"},
        {&Steinberg::Vst::IProgress_iid, "IProgress"},
        {&Steinberg::Vst::IMidiMapping_iid, "IMidiMapping"},
        {&Steinberg::Vst::IMidiMapping2_iid, "IMidiMapping2"},
        {&Steinberg::Vst::IMidiLearn2_iid, "IMidiLearn2"},
        {&Steinberg::Vst::ITransportControl_iid, "ITransportControl"},
        {&Steinberg::IAttributes2_iid, "IAttributes2"},
        {&Steinberg::Vst::IConnectionPoint_iid, "IConnectionPoint"},
        {&Steinberg::Vst::IHostApplication_iid, "IHostApplication"},
        {&Steinberg::Vst::IAttributeList_iid, "IAttributeList"},
        {&Steinberg::Vst::IStreamAttributes_iid, "IStreamAttributes"},
        {&Steinberg::Vst::IMessage_iid, "IMessage"},
        {&Steinberg::Vst::IParameterChanges_iid, "IParameterChanges"},
        {&Steinberg::Vst::IParamValueQueue_iid, "IParamValueQueue"},
        {&Steinberg::Vst::IEventList_iid, "IEventList"},
        {&Steinberg::Vst::IUnitInfo_iid, "IUnitInfo"},
        {&Steinberg::Vst::IUnitHandler_iid, "IUnitHandler"},
        {&Steinberg::Vst::IUnitHandler2_iid, "IUnitHandler2"},
        {&Steinberg::Vst::IProgramListData_iid, "IProgramListData"},
        {&Steinberg::Vst::IUnitData_iid, "IUnitData"},
        {&Steinberg::Vst::IContextMenu_iid, "IContextMenu"},
        {&Steinberg::Vst::IContextMenuTarget_iid, "IContextMenuTarget"},
        {&Steinberg::Vst::IPlugInterfaceSupport_iid, "IPlugInterfaceSupport"},
        {&Steinberg::Vst::IAutomationState_iid, "IAutomationState"},
        {&Steinberg::Vst::ChannelContext::IInfoListener_iid, "ChannelContext::IInfoListener"},
        {&Steinberg::Vst::IPrefetchableSupport_iid, "IPrefetchableSupport"},
        {&Steinberg::Vst::IParameterFunctionName_iid, "IParameterFunctionName"},
        {&Steinberg::Vst::IRemapParamID_iid, "IRemapParamID"},
        {&Steinberg::Vst::IMidiLearn_iid, "IMidiLearn"},
        {&Steinberg::Vst::INoteExpressionController_iid, "INoteExpressionController"},
        {&Steinberg::Vst::IKeyswitchController_iid, "IKeyswitchController"},
        {&Steinberg::Vst::INoteExpressionPhysicalUIMapping_iid, "INoteExpressionPhysicalUIMapping"},
        {&Steinberg::Vst::IXmlRepresentationController_iid, "IXmlRepresentationController"},
        {&Steinberg::Vst::IParameterFinder_iid, "IParameterFinder"},
        {&Steinberg::Vst::IDataExchangeHandler_iid, "IDataExchangeHandler"},
        {&Steinberg::Vst::IDataExchangeReceiver_iid, "IDataExchangeReceiver"},
        {&Steinberg::Vst::IInterAppAudioHost_iid, "IInterAppAudioHost"},
    };
    count = sizeof(table) / sizeof(table[0]);
    return table;
}

std::atomic<bool> g_enabled{false};

std::mutex& mutex() {
    static std::mutex m;
    return m;
}

std::vector<Entry>& store() {
    static std::vector<Entry> entries;
    return entries;
}

}  // namespace

std::string iidToHex(const Steinberg::TUID iid) {
    std::string hex;
    hex.reserve(32);
    for (int i = 0; i < 16; ++i) {
        const unsigned char byte = static_cast<unsigned char>(iid[i]);
        hex.push_back(kHexDigits[byte >> 4]);
        hex.push_back(kHexDigits[byte & 0x0F]);
    }
    return hex;
}

std::string iidName(const Steinberg::TUID iid) {
    std::size_t count = 0;
    const KnownIid* table = knownTable(count);
    for (std::size_t i = 0; i < count; ++i) {
        if (Steinberg::FUnknownPrivate::iidEqual(iid, *table[i].iid)) return table[i].name;
    }
    return std::string();
}

void setEnabled(bool on) { g_enabled.store(on, std::memory_order_relaxed); }

bool enabled() { return g_enabled.load(std::memory_order_relaxed); }

void record(const char* site, const Steinberg::TUID wantedIid, bool answered) {
    if (!g_enabled.load(std::memory_order_relaxed) || site == nullptr || wantedIid == nullptr) {
        return;
    }
    const std::string hex = iidToHex(wantedIid);
    std::lock_guard<std::mutex> lock(mutex());
    for (Entry& entry : store()) {
        if (entry.site == site && entry.iid == hex) {
            ++entry.count;
            // A later answer can only be the same answer; keep the first one truthful anyway.
            entry.answered = entry.answered || answered;
            return;
        }
    }
    Entry entry;
    entry.site = site;
    entry.iid = hex;
    entry.name = iidName(wantedIid);
    entry.answered = answered;
    entry.count = 1;
    store().push_back(entry);
}

std::vector<Entry> entries() {
    std::lock_guard<std::mutex> lock(mutex());
    return store();
}

void clear() {
    std::lock_guard<std::mutex> lock(mutex());
    store().clear();
}

}  // namespace thedaw::vst3::iidlog
