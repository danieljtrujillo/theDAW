// GANduit - iPlug2 WebView controller/host shell for .gan plugins.
//
// Renders a .gan web UI in a native WebView (so the SAME surface theDAW shows in
// MIX runs inside any DAW) and forwards its control changes to the host as
// parameter automation + MIDI CC. Audio is passed through unchanged.
//
// SCAFFOLD: modeled on the iPlug2 "IPlugWebUI" example. Method signatures must
// match the pinned iPlug2 version once the project is generated (../README.md).
// Cannot be compiled in theDAW's Python/Node env - needs the iPlug2 toolchain.
#pragma once

#include "IPlug_include_in_plug_hdr.h"
#include "GanArchive.h"

const int kNumPresets = 1;

using namespace iplug;

class GANduit final : public Plugin
{
public:
  GANduit(const InstanceInfo& info);

  // Audio pass-through (controller shell - no DSP).
  void ProcessBlock(sample** inputs, sample** outputs, int nFrames) override;
  void ProcessMidiMsg(const IMidiMsg& msg) override;

  // Parameter -> host automation + MIDI CC bridge.
  void OnParamChange(int paramIdx) override;

  // iPlug2 WebView editor hooks (from the IWebView editor delegate the project
  // is configured with). Names track the IPlugWebUI example.
  void OnParamChangeUI(int paramIdx, EParamSource source) override;
  bool OnMessageFromWebView(const char* json);  // {tag:"loadGan"|"param", ...}
  void OnUIOpen() override;
  void OnIdle() override;

private:
  // Extract a .gan and point the WebView at its index.html. Pass nullptr to show
  // the "drop a .gan" placeholder.
  void LoadGan(const char* ganPath);

  ganduit::GanInfo mGan;
  int mParamToCC[GANDUIT_NUM_PARAMS];  // param index -> MIDI CC number (1:1 default)
  int mMidiOutChannel = 0;             // 0-based output channel for emitted CC
};
