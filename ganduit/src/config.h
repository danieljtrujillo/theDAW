// GANduit - config.h
//
// Plugin metadata for the iPlug2 build. GANduit is a controller/host shell: it
// renders a .gan web UI inside a native WebView and forwards parameter changes
// to the host DAW as automation plus MIDI CC. Audio passes through unchanged, so
// it loads in any VST3/CLAP/AU host as an effect on a track or bus.
//
// SCAFFOLD: these values follow the standard iPlug2 config.h contract. The
// project/IDE files that consume them are generated from iPlug2 (see
// ../README.md). This directory cannot be built inside theDAW's Python/Node
// environment - it needs the iPlug2 C++ toolchain.
#pragma once

#define PLUG_NAME "GANduit"
#define PLUG_MFR "GANTASMO"
#define PLUG_VERSION_HEX 0x00000100
#define PLUG_VERSION_STR "0.1.0"
#define PLUG_UNIQUE_ID 'GNdt'
#define PLUG_MFR_ID 'GTSM'
#define PLUG_URL_STR "https://gantasmo.com"
#define PLUG_EMAIL_STR "hello@gantasmo.com"
#define PLUG_COPYRIGHT_STR "Copyright 2026 GANTASMO"
#define PLUG_CLASS_NAME GANduit

#define BUNDLE_NAME "GANduit"
#define BUNDLE_MFR "GANTASMO"
#define BUNDLE_DOMAIN "com"

#define SHARED_RESOURCES_SUBPATH "GANduit"

// 2-in / 2-out, MIDI in and out (so it can pass MIDI through AND emit CC).
#define PLUG_CHANNEL_IO "2-2"
#define PLUG_LATENCY 0
#define PLUG_TYPE 0  // 0 = effect, 1 = instrument
#define PLUG_DOES_MIDI_IN 1
#define PLUG_DOES_MIDI_OUT 1
#define PLUG_DOES_MPE 0
#define PLUG_DOES_STATE_CHUNKS 1
#define PLUG_HAS_UI 1
#define PLUG_WIDTH 1000
#define PLUG_HEIGHT 600
#define PLUG_FPS 60
#define PLUG_SHARED_RESOURCES 0
#define PLUG_HOST_RESIZE 1
#define PLUG_MIN_WIDTH 256
#define PLUG_MIN_HEIGHT 256
#define PLUG_MAX_WIDTH 4096
#define PLUG_MAX_HEIGHT 4096

// Generic, host-automatable macros a .gan UI binds to by index. Each maps to a
// MIDI CC (param 0 -> CC 1, ...) so the surface drives a DAW like a hardware
// controller. Raise this if a .gan needs more than 16 live controls.
#define GANDUIT_NUM_PARAMS 16

// AUv2 / AUv3
#define AUV2_ENTRY GANduit_Entry
#define AUV2_ENTRY_STR "GANduit_Entry"
#define AUV2_FACTORY GANduit_Factory
#define AUV2_VIEW_CLASS GANduit_View
#define AUV2_VIEW_CLASS_STR "GANduit_View"

// CLAP
#define CLAP_MANUAL_URL "https://gantasmo.com"
#define CLAP_SUPPORT_URL "https://gantasmo.com"
#define CLAP_DESCRIPTION "GANTASMO .gan web-UI controller"
#define CLAP_FEATURES "audio-effect", "utility"

// VST3
#define VST3_SUBCATEGORY "Fx|Tools"
