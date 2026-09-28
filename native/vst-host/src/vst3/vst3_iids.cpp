// Interface-ID definitions for every VST3 interface this host touches.
//
// The ABI headers only DECLARE `SomeInterface::iid`; exactly one translation unit in the program
// has to define it, and which interfaces that covers is a property of the host, not of the SDK.
// The vendored `base/coreiids.cpp` does this for the base layer (FUnknown, IBStream,
// IPluginFactory…); this file is the VST and GUI layer equivalent, and it is deliberately a list
// of only what we implement or query for — an interface that is not here is one this host does
// not speak.
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"
#include "pluginterfaces/vst/ivstattributes.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"

namespace Steinberg {

// ---- editor hosting (we implement IPlugFrame; we query the other two on the plugin's view) ----
DEF_CLASS_IID(IPlugView)
DEF_CLASS_IID(IPlugFrame)
DEF_CLASS_IID(IPlugViewContentScaleSupport)

namespace Vst {

// ---- the plugin side we drive ----
DEF_CLASS_IID(IComponent)
DEF_CLASS_IID(IAudioProcessor)
DEF_CLASS_IID(IEditController)
DEF_CLASS_IID(IConnectionPoint)
DEF_CLASS_IID(IMidiMapping)

// ---- the host side we provide ----
DEF_CLASS_IID(IHostApplication)
DEF_CLASS_IID(IComponentHandler)
DEF_CLASS_IID(IComponentHandler2)
DEF_CLASS_IID(IAttributeList)
DEF_CLASS_IID(IMessage)

// ---- per-block objects we hand to process() ----
DEF_CLASS_IID(IParameterChanges)
DEF_CLASS_IID(IParamValueQueue)
DEF_CLASS_IID(IEventList)

}  // namespace Vst
}  // namespace Steinberg
