#pragma once

#include "IPlug_include_in_plug_hdr.h"

#include <atomic>
#include <string>
#include <vector>

using namespace iplug;

const int kNumPresets = 1;

/** Fixed parameter capacity. iPlug2 fixes the parameter count at MakeConfig
 * time, so the shell reserves a generous pool. The first N parameters are
 * initialised from the bundle manifest at construction; the remainder are
 * initialised as hidden, non-automatable dummies. */
static constexpr int kMaxParams = 128;

/** Messages sent from the WebView JS bridge to the C++ side (SAMFUI msgTag). */
enum EMsgTags
{
  /** Payload: base64( {"id": <paramId>, "v": <normalized 0..1>} ) */
  kMsgTagSetParam = 0,
  /** UI-clocked pull for LISTEN bind values (transport / metering). No
   * payload. The shell replies on the same (UI) thread via
   * EvaluateJavaScript -> window.__foundrySetBindValue(id, v0to100|bool). */
  kMsgTagGetBindValues = 1
};

/** Parameter "kind" as declared in the Foundry manifest. */
enum class EFoundryParamKind
{
  Continuous = 0,
  Boolean,
  Trigger,
  Enum
};

/** One manifest-declared parameter, mapped to an iPlug2 parameter index by
 * position in this vector. */
struct FoundryParamDesc
{
  std::string id;        // stable paramId used by the web UI
  std::string elementId; // DOM element id (informational, passed to the UI)
  int cc = -1;           // MIDI CC number to emit, or -1 for none
  EFoundryParamKind kind = EFoundryParamKind::Continuous;
};

/** Built-in bind actions the shell honors natively (manifest `bindings`,
 * targetId in the `vst:` namespace — see the Foundry catalog in
 * src/lib/vstBinds.ts). Anything else parses to None and is ignored: the
 * catalog is deliberately wider than any single runtime. */
enum class EFoundryBindAction
{
  None = 0,
  MidiCC,         // arg = controller number 0..127
  MidiNote,       // arg = note number 0..127 (on/off from trigger edges)
  MidiPitchBend,  // 14-bit, bipolar around center
  MidiAftertouch, // channel pressure 0..127
  MidiProgram,    // program change 0..127
  MidiPanic,      // rising edge -> All Sound Off (120) + All Notes Off (123)
  GainOut,        // master output gain, -60..+12 dB, smoothed in DSP
  Pan             // master balance, unity at center (balance law)
};

/** One manifest `bindings` entry resolved for the audio thread. Route mode:
 * when param paramIdx changes, shape its normalized value (amount -> curve ->
 * range, the same math as Foundry's routing.ts applyRoute) and perform the
 * action. Listen mode entries only register their targetId for the UI pull. */
struct FoundryBindDesc
{
  int paramIdx = -1;
  std::string targetId;
  EFoundryBindAction action = EFoundryBindAction::None;
  int arg = -1;        // CC / note number
  double amount = 100.; // -100..100, negative inverts
  int curve = 0;        // 0 linear / 1 exp / 2 log / 3 scurve
  double rangeMin = 0.; // 0..100 output clamp
  double rangeMax = 100.;
  // Audio-thread diff state.
  int lastQuant = -1;   // last quantized value sent (CC/AT/program/PB)
  bool gate = false;    // note / panic edge state
};

class FoundryShell final : public Plugin
{
public:
  FoundryShell(const InstanceInfo& info);

#if IPLUG_DSP
  void ProcessBlock(sample** inputs, sample** outputs, int nFrames) override;
  void OnReset() override;
#endif

  bool OnMessage(int msgTag, int ctrlTag, int dataSize, const void* pData) override;
  void OnUIOpen() override;

private:
  /** Locates the plugin bundle's Contents/Resources directory (VST3 on
   * Windows / macOS). Sets an empty string if it cannot be resolved. */
  void GetResourcesDir(WDL_String& path) const;

  /** Reads and parses manifest.json from the resources dir and initialises the
   * corresponding iPlug2 parameters. @return the number of parameters
   * configured (0 on missing / corrupt manifest). */
  int LoadManifest(const char* resourcesDir);

  /** Parses the manifest's `bindings` array (already-parsed JSON root) into
   * mBinds / mListenIds. Tolerant: malformed entries are skipped. */
  void LoadBindings(const void* rootJson);

  /** @return the iPlug2 parameter index for a manifest paramId, or -1. */
  int ParamIndexForId(const char* id) const;

  /** Pushes the manifest parameter map (index/id/elementId/kind/cc) to the
   * web UI so it can translate between paramId and parameter index. */
  void PushParamMapToUI();

  /** Answers a kMsgTagGetBindValues pull: one EvaluateJavaScript call pushing
   * every LISTEN-bound id's current value (transport from ITimeInfo, I/O
   * metering + envelope follower from the DSP atomics) as
   * window.__foundrySetBindValue(id, v0to100|bool). UI thread. */
  void PushBindValuesToUI();

  std::vector<FoundryParamDesc> mParams; // manifest params, in index order
  int mNumManifestParams = 0;
  WDL_String mResourcesDir;

  // Last MIDI CC value (0..127) emitted per manifest param; -1 = not yet sent.
  int mLastCC[kMaxParams];

  // --- built-in binds (manifest `bindings`) --------------------------------
  std::vector<FoundryBindDesc> mBinds;   // route-mode actions, audio thread
  std::vector<std::string> mListenIds;   // listen-mode target ids (deduped)

  // DSP state for GainOut / Pan binds (targets set on the audio thread from
  // shaped param values; the smoothed current value avoids zipper noise).
  double mOutGainTargetLin = 1.0;
  double mOutGainLin = 1.0;
  double mPanTarget = 0.0; // -1..1, balance law
  double mPan = 0.0;
  bool mHasGainBind = false;
  bool mHasPanBind = false;

  // Audio -> UI listen values (written per block in ProcessBlock, read by
  // PushBindValuesToUI on the UI thread).
  std::atomic<double> mTempoAtom{120.0};
  std::atomic<double> mBeatPhase{0.0};
  std::atomic<double> mBarPhase{0.0};
  std::atomic<double> mPlayheadSec{0.0};
  std::atomic<bool> mPlaying{false};
  std::atomic<double> mInRmsL{0.0};
  std::atomic<double> mInRmsR{0.0};
  std::atomic<double> mOutRmsL{0.0};
  std::atomic<double> mOutRmsR{0.0};
  std::atomic<double> mOutPeak{0.0};
  std::atomic<bool> mClip{false};
  std::atomic<double> mEnvFollow{0.0};
  double mEnvState = 0.0; // block-rate follower ballistics (audio thread only)
};
