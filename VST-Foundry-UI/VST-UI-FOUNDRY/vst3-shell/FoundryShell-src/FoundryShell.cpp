#include "FoundryShell.h"
#include "IPlug_include_in_plug_src.h"
#include "IPlugPaths.h"

#include "json.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <exception>
#include <fstream>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace
{
// Opens a UTF-8 path with an ifstream, using a wide path on Windows so that
// non-ASCII bundle paths resolve correctly.
std::ifstream OpenUTF8File(const char* path)
{
#ifdef OS_WIN
  return std::ifstream(iplug::UTF8AsUTF16(path).Get(), std::ios::binary);
#else
  return std::ifstream(path, std::ios::binary);
#endif
}

bool FileExistsUTF8(const char* path)
{
  std::ifstream f = OpenUTF8File(path);
  return f.good();
}

// Type-tolerant JSON field readers. nlohmann::json::value() throws
// type_error.302 when the stored value's type differs from the supplied
// default's type (e.g. reading a JSON boolean with a numeric default, which
// the Foundry exporter does for every Toggle: "default": false). These helpers
// inspect the actual stored type and coerce it, returning the fallback for
// anything unexpected, so a variant/malformed manifest can never throw here.
std::string JsonStr(const json& obj, const char* key, const std::string& fallback)
{
  if (obj.contains(key))
  {
    const json& v = obj[key];
    if (v.is_string())
      return v.get<std::string>();
    if (v.is_number() || v.is_boolean())
      return v.dump();
  }
  return fallback;
}

double JsonNum(const json& obj, const char* key, double fallback)
{
  if (obj.contains(key))
  {
    const json& v = obj[key];
    if (v.is_number())
      return v.get<double>();
    if (v.is_boolean())
      return v.get<bool>() ? 1.0 : 0.0;
    if (v.is_string())
    {
      try
      {
        return std::stod(v.get<std::string>());
      }
      catch (...)
      {
      }
    }
  }
  return fallback;
}

int JsonInt(const json& obj, const char* key, int fallback)
{
  if (obj.contains(key))
  {
    const json& v = obj[key];
    if (v.is_number())
      return static_cast<int>(v.get<double>());
    if (v.is_boolean())
      return v.get<bool>() ? 1 : 0;
    if (v.is_string())
    {
      try
      {
        return std::stoi(v.get<std::string>());
      }
      catch (...)
      {
      }
    }
  }
  return fallback;
}

bool JsonBool(const json& obj, const char* key, bool fallback)
{
  if (obj.contains(key))
  {
    const json& v = obj[key];
    if (v.is_boolean())
      return v.get<bool>();
    if (v.is_number())
      return v.get<double>() != 0.0;
    if (v.is_string())
    {
      const std::string s = v.get<std::string>();
      return s == "true" || s == "1";
    }
  }
  return fallback;
}

// Minimal placeholder shown only if not even ui/index.html can be loaded.
const char* GetFallbackHTML()
{
  return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
         "<style>body{margin:0;height:100vh;display:flex;align-items:center;"
         "justify-content:center;background:#14171c;color:#e7ecf3;"
         "font-family:Segoe UI,Arial,sans-serif;text-align:center}"
         "p{max-width:360px;line-height:1.5;color:#8b95a4;font-size:13px}"
         "h1{font-size:20px;margin:0 0 8px}</style></head><body><div>"
         "<h1>FoundryShell</h1>"
         "<p>No bundle loaded. Drop a Foundry export (manifest.json + ui/) into "
         "this plugin's Contents/Resources/ folder.</p></div></body></html>";
}
} // namespace

FoundryShell::FoundryShell(const InstanceInfo& info)
: iplug::Plugin(info, MakeConfig(kMaxParams, kNumPresets))
{
  for (int i = 0; i < kMaxParams; i++)
    mLastCC[i] = -1;

  GetResourcesDir(mResourcesDir);

  int n = 0;
  if (mResourcesDir.GetLength() > 0)
    n = LoadManifest(mResourcesDir.Get());

  if (n <= 0)
  {
    // Fallback so the shell is always usable, even with a missing / corrupt
    // manifest. A single gain parameter, emitting CC 7 (Channel Volume).
    GetParam(0)->InitGain("Gain", -70., -70., 0.);
    mParams.clear();

    FoundryParamDesc gain;
    gain.id = "gain";
    gain.elementId = "gain";
    gain.cc = 7;
    gain.kind = EFoundryParamKind::Continuous;
    mParams.push_back(gain);

    n = 1;
    DBGMSG("FoundryShell: using fallback gain parameter (no valid manifest)\n");
  }

  mNumManifestParams = n;

  // Initialise the remaining pool as hidden, non-automatable dummies.
  for (int i = n; i < kMaxParams; i++)
    GetParam(i)->InitDouble("-", 0., 0., 1., 0., "", IParam::kFlagCannotAutomate);

#ifdef WEBVIEW_EDITOR_DELEGATE
  // The params-init JSON for up to kMaxParams parameters can be large; raise the
  // JS string cap so it is not truncated when sent to the WebView.
  SetMaxJSStringLength(1 << 20);

#ifdef DEBUG
  SetEnableDevTools(true);
#endif

  mEditorInitFunc = [&]() {
    WDL_String indexPath;
    indexPath.Set(mResourcesDir.Get());
    indexPath.Append("ui\\index.html");

    if (mResourcesDir.GetLength() > 0 && FileExistsUTF8(indexPath.Get()))
      LoadFile(indexPath.Get(), GetBundleID());
    else
      LoadHTML(GetFallbackHTML());

    EnableScroll(false);
  };
#endif

  MakeDefaultPreset("Default", kNumPresets);
}

void FoundryShell::GetResourcesDir(WDL_String& path) const
{
  path.Set("");
#if defined OS_WIN && defined VST3_API
  // gHINSTANCE is the plugin DLL module handle (set in InitModule for VST3).
  BundleResourcePath(path, gHINSTANCE);
#elif defined OS_MAC
  BundleResourcePath(path, GetBundleID());
#endif
}

int FoundryShell::LoadManifest(const char* resourcesDir)
{
  // The plugin must never fail construction due to manifest content: any residual
  // throw here returns the no-manifest result (0) so the ctor's 1-gain fallback
  // engages.
  try
  {
    WDL_String manifestPath;
    manifestPath.Set(resourcesDir);
    manifestPath.Append("manifest.json");

    std::ifstream ifs = OpenUTF8File(manifestPath.Get());
    if (!ifs.is_open())
      return 0;

    json root = json::parse(ifs, nullptr, false);
    if (root.is_discarded() || !root.is_object())
    {
      DBGMSG("FoundryShell: manifest.json is not valid JSON\n");
      return 0;
    }

    const int formatVersion = JsonInt(root, "formatVersion", 0);
    if (formatVersion != 1)
      DBGMSG("FoundryShell: unexpected manifest formatVersion %d (expected 1)\n", formatVersion);

    // Optional editor size.
    if (root.contains("plugin") && root["plugin"].is_object())
    {
      const json& plug = root["plugin"];
      const int w = JsonInt(plug, "width", 0);
      const int h = JsonInt(plug, "height", 0);
      if (w > 0 && h > 0)
        SetEditorSize(w, h);
    }

    if (!root.contains("params") || !root["params"].is_array())
    {
      DBGMSG("FoundryShell: manifest has no params array\n");
      return 0;
    }

    int idx = 0;

    for (const json& p : root["params"])
    {
      if (idx >= kMaxParams)
      {
        DBGMSG("FoundryShell: manifest exceeds kMaxParams (%d), truncating\n", kMaxParams);
        break;
      }

      // Isolate each param: a malformed entry is skipped and the loop continues,
      // rather than aborting the whole manifest load.
      try
      {
        if (!p.is_object() || !p.contains("id"))
          continue;

        FoundryParamDesc desc;
        desc.id = JsonStr(p, "id", std::string());
        desc.elementId = JsonStr(p, "elementId", desc.id);
        desc.cc = JsonInt(p, "cc", -1);

        const std::string kindStr = JsonStr(p, "kind", std::string("continuous"));
        const std::string name = JsonStr(p, "name", desc.id);

        if (kindStr == "boolean")
        {
          desc.kind = EFoundryParamKind::Boolean;
          const bool def = JsonBool(p, "default", false);
          GetParam(idx)->InitBool(name.c_str(), def);
        }
        else if (kindStr == "trigger")
        {
          desc.kind = EFoundryParamKind::Trigger;
          GetParam(idx)->InitBool(name.c_str(), false);
        }
        else if (kindStr == "enum")
        {
          desc.kind = EFoundryParamKind::Enum;

          std::vector<std::string> options;
          if (p.contains("options") && p["options"].is_array())
          {
            for (const json& opt : p["options"])
              options.push_back(opt.is_string() ? opt.get<std::string>() : opt.dump());
          }
          if (options.empty())
            options.push_back("0");

          const int nEnums = static_cast<int>(options.size());
          int def = static_cast<int>(JsonNum(p, "default", 0.0));
          def = std::max(0, std::min(def, nEnums - 1));

          GetParam(idx)->InitEnum(name.c_str(), def, nEnums, "", IParam::kFlagsNone, "");
          for (int e = 0; e < nEnums; e++)
            GetParam(idx)->SetDisplayText(static_cast<double>(e), options[e].c_str());
        }
        else // "continuous" (default)
        {
          desc.kind = EFoundryParamKind::Continuous;
          double minV = JsonNum(p, "min", 0.0);
          double maxV = JsonNum(p, "max", 1.0);
          double defV = JsonNum(p, "default", minV);

          // Guard the range: InitDouble requires max > min. Mirror the exported
          // UI's guard and repair a degenerate / inverted range.
          if (!(maxV > minV))
            maxV = minV + 1.0;

          // Clamp a non-finite / out-of-range default into [minV, maxV].
          if (!std::isfinite(defV))
            defV = minV;
          defV = std::max(minV, std::min(defV, maxV));

          GetParam(idx)->InitDouble(name.c_str(), defV, minV, maxV, 0.001, "");
        }

        mParams.push_back(desc);
        idx++;
      }
      catch (const std::exception& e)
      {
        DBGMSG("FoundryShell: skipping malformed param at slot %d: %s\n", idx, e.what());
        (void)e;
        continue;
      }
    }

    // Built-in binds (`bindings` array, formatVersion 1 additive field) —
    // parsed AFTER params so paramId -> index resolution sees the full list.
    LoadBindings(&root);

    DBGMSG("FoundryShell: loaded %d parameter(s), %d bind(s), %d listen id(s) from manifest\n",
           idx, static_cast<int>(mBinds.size()), static_cast<int>(mListenIds.size()));
    return idx;
  }
  catch (const std::exception& e)
  {
    DBGMSG("FoundryShell: exception while loading manifest: %s\n", e.what());
    (void)e;
    return 0;
  }
  catch (...)
  {
    DBGMSG("FoundryShell: unknown exception while loading manifest\n");
    return 0;
  }
}

int FoundryShell::ParamIndexForId(const char* id) const
{
  if (!id)
    return -1;

  // Bounded by mParams.size(), NOT mNumManifestParams: LoadBindings runs
  // inside LoadManifest, before the ctor stores that count.
  for (int i = 0; i < static_cast<int>(mParams.size()); i++)
  {
    if (mParams[i].id == id)
      return i;
  }
  return -1;
}

namespace
{
/** Parse a `vst:` bind target id into the action the shell implements.
 * Unknown ids yield None — carried but ignored, never an error. */
EFoundryBindAction ParseBindTarget(const std::string& id, int& argOut)
{
  argOut = -1;

  auto numberAfter = [&](const char* prefix) -> int {
    const size_t len = std::strlen(prefix);
    if (id.compare(0, len, prefix) != 0)
      return -1;
    try
    {
      const int n = std::stoi(id.substr(len));
      return (n >= 0 && n <= 127) ? n : -1;
    }
    catch (...)
    {
      return -1;
    }
  };

  int n = numberAfter("vst:midi.cc.");
  if (n >= 0) { argOut = n; return EFoundryBindAction::MidiCC; }
  n = numberAfter("vst:midi.note.");
  if (n >= 0) { argOut = n; return EFoundryBindAction::MidiNote; }
  if (id == "vst:midi.pitchbend") return EFoundryBindAction::MidiPitchBend;
  if (id == "vst:midi.aftertouch") return EFoundryBindAction::MidiAftertouch;
  if (id == "vst:midi.program") return EFoundryBindAction::MidiProgram;
  if (id == "vst:midi.panic") return EFoundryBindAction::MidiPanic;
  if (id == "vst:plugin.gain.out") return EFoundryBindAction::GainOut;
  if (id == "vst:plugin.pan") return EFoundryBindAction::Pan;
  return EFoundryBindAction::None;
}

int CurveIndex(const std::string& curve)
{
  if (curve == "exp") return 1;
  if (curve == "log") return 2;
  if (curve == "scurve") return 3;
  return 0; // linear
}

/** amount -> curve -> range shaping on a normalized 0..1 source — the same
 * math as Foundry's routing.ts applyRoute (which works in 0..100). */
double ShapeBind(double norm01, const FoundryBindDesc& b)
{
  const auto clamp01 = [](double v) { return v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v; };
  const double src = clamp01(norm01);
  const double amt = b.amount / 100.0;
  double v = amt >= 0.0 ? src * amt : (1.0 - src) * -amt;
  v = clamp01(v);
  switch (b.curve)
  {
    case 1: v = v * v * v; break;                    // exp — fast late
    case 2: v = 1.0 - std::pow(1.0 - v, 3.0); break; // log — fast early
    case 3: v = v * v * (3.0 - 2.0 * v); break;      // scurve — smoothstep
    default: break;
  }
  const double lo = clamp01(b.rangeMin / 100.0);
  const double hi = clamp01(b.rangeMax / 100.0);
  return clamp01(lo + v * (hi - lo));
}
} // namespace

void FoundryShell::LoadBindings(const void* rootJson)
{
  const json& root = *static_cast<const json*>(rootJson);

  if (!root.contains("bindings") || !root["bindings"].is_array())
    return;

  for (const json& b : root["bindings"])
  {
    try
    {
      if (!b.is_object())
        continue;

      const std::string targetId = JsonStr(b, "targetId", std::string());
      const std::string mode = JsonStr(b, "mode", std::string("route"));
      if (targetId.empty())
        continue;

      if (mode == "listen")
      {
        // Register the id for the UI pull (deduped). LFO / macro / spectrum
        // ids are owned by the exported UI's local runtime or a future
        // publisher; PushBindValuesToUI simply skips ids it has no data for.
        bool known = false;
        for (const std::string& id : mListenIds)
          if (id == targetId) { known = true; break; }
        if (!known)
          mListenIds.push_back(targetId);
        continue;
      }

      FoundryBindDesc desc;
      desc.targetId = targetId;
      desc.action = ParseBindTarget(targetId, desc.arg);
      if (desc.action == EFoundryBindAction::None)
        continue; // carried in the manifest for other runtimes — not ours

      const std::string paramId = JsonStr(b, "paramId", std::string());
      desc.paramIdx = ParamIndexForId(paramId.c_str());
      if (desc.paramIdx < 0)
        continue; // dropped / unknown source param: the bind can never fire

      desc.amount = JsonNum(b, "amount", 100.0);
      desc.curve = CurveIndex(JsonStr(b, "curve", std::string("linear")));
      desc.rangeMin = JsonNum(b, "rangeMin", 0.0);
      desc.rangeMax = JsonNum(b, "rangeMax", 100.0);

      if (desc.action == EFoundryBindAction::GainOut)
        mHasGainBind = true;
      if (desc.action == EFoundryBindAction::Pan)
        mHasPanBind = true;

      mBinds.push_back(desc);
    }
    catch (const std::exception& e)
    {
      DBGMSG("FoundryShell: skipping malformed binding: %s\n", e.what());
      (void)e;
      continue;
    }
  }
}

void FoundryShell::PushParamMapToUI()
{
  json arr = json::array();
  for (int i = 0; i < mNumManifestParams; i++)
  {
    json e;
    e["index"] = i;
    e["id"] = mParams[i].id;
    e["elementId"] = mParams[i].elementId;
    e["kind"] = static_cast<int>(mParams[i].kind);
    e["cc"] = mParams[i].cc;
    arr.push_back(e);
  }

  const std::string mapJson = arr.dump();
  WDL_String js;
  js.SetFormatted(static_cast<int>(mapJson.size()) + 128,
                  "if (window.__foundrySetParamMap) { window.__foundrySetParamMap(%s); }",
                  mapJson.c_str());
  EvaluateJavaScript(js.Get());
}

void FoundryShell::OnUIOpen()
{
  // Define the paramId <-> index map before pushing current values, so the
  // JS SPVFD handler can translate incoming automation.
  PushParamMapToUI();

  for (int i = 0; i < mNumManifestParams; i++)
    SendParameterValueFromDelegate(i, GetParam(i)->GetNormalized(), true);
}

void FoundryShell::PushBindValuesToUI()
{
  if (mListenIds.empty())
    return;

  // Perceptual-ish meter scale: sqrt of RMS onto 0..100.
  const auto meterPct = [](double rms) {
    const double v = std::sqrt(rms < 0.0 ? 0.0 : rms) * 100.0;
    return v > 100.0 ? 100.0 : v;
  };

  WDL_String js;
  js.Set("if(window.__foundrySetBindValue){");

  for (const std::string& id : mListenIds)
  {
    double v = -1.0;
    const char* boolLit = nullptr;

    if (id == "vst:transport.tempo")
      v = ((mTempoAtom.load() - 20.0) / 280.0) * 100.0;
    else if (id == "vst:transport.beat")
      v = mBeatPhase.load() * 100.0;
    else if (id == "vst:transport.bar")
      v = mBarPhase.load() * 100.0;
    else if (id == "vst:transport.playhead")
      v = mPlayheadSec.load() / 6.0; // 0..600s onto 0..100
    else if (id == "vst:transport.playing")
      boolLit = mPlaying.load() ? "true" : "false";
    else if (id == "vst:meter.in.l")
      v = meterPct(mInRmsL.load());
    else if (id == "vst:meter.in.r")
      v = meterPct(mInRmsR.load());
    else if (id == "vst:meter.out.l")
      v = meterPct(mOutRmsL.load());
    else if (id == "vst:meter.out.r")
      v = meterPct(mOutRmsR.load());
    else if (id == "vst:meter.out.peak")
      v = mOutPeak.load() * 100.0;
    else if (id == "vst:meter.clip")
      boolLit = mClip.load() ? "true" : "false";
    else if (id == "vst:mod.envfollow")
      v = meterPct(mEnvFollow.load());
    else
      continue; // LFOs / macros: the UI's local runtime owns them. Spectrum /
                // GR: no publisher yet — the UI keeps them at rest.

    if (boolLit)
      js.AppendFormatted(160, "window.__foundrySetBindValue(\"%s\",%s);", id.c_str(), boolLit);
    else
    {
      if (v < 0.0) v = 0.0;
      if (v > 100.0) v = 100.0;
      js.AppendFormatted(160, "window.__foundrySetBindValue(\"%s\",%.3f);", id.c_str(), v);
    }
  }

  js.Append("}");
  EvaluateJavaScript(js.Get());
}

bool FoundryShell::OnMessage(int msgTag, int ctrlTag, int dataSize, const void* pData)
{
  // UI-clocked pull (no payload): reply synchronously on this (UI) thread.
  if (msgTag == kMsgTagGetBindValues)
  {
    PushBindValuesToUI();
    return true;
  }

  if (msgTag == kMsgTagSetParam && pData != nullptr && dataSize > 0)
  {
    std::string payload(reinterpret_cast<const char*>(pData), static_cast<size_t>(dataSize));

    json msg = json::parse(payload, nullptr, false);
    if (msg.is_object() && msg.contains("id"))
    {
      const std::string id = msg.value("id", std::string());
      const double v = msg.value("v", 0.0);
      const int idx = ParamIndexForId(id.c_str());

      if (idx >= 0)
      {
        BeginInformHostOfParamChangeFromUI(idx);
        SendParameterValueFromUI(idx, v);
        EndInformHostOfParamChangeFromUI(idx);
      }
    }
    return true;
  }

  return false;
}

#if IPLUG_DSP
void FoundryShell::ProcessBlock(sample** inputs, sample** outputs, int nFrames)
{
  const int nIn = NInChansConnected();
  const int nOut = NOutChansConnected();

  // Pure passthrough. Handles in == out aliasing and mismatched channel counts.
  for (int c = 0; c < nOut; c++)
  {
    if (c < nIn)
    {
      if (outputs[c] != inputs[c])
        std::memcpy(outputs[c], inputs[c], nFrames * sizeof(sample));
    }
    else
    {
      std::memset(outputs[c], 0, nFrames * sizeof(sample));
    }
  }

  // Output gain / pan binds: smoothed per sample (no zipper), balance law
  // (unity at center) so BINDING a centered pan control never changes level.
  if (mHasGainBind || mHasPanBind)
  {
    for (int s = 0; s < nFrames; s++)
    {
      mOutGainLin += (mOutGainTargetLin - mOutGainLin) * 0.001;
      mPan += (mPanTarget - mPan) * 0.001;
      const double gl = mOutGainLin * (mPan > 0.0 ? 1.0 - mPan : 1.0);
      const double gr = mOutGainLin * (mPan < 0.0 ? 1.0 + mPan : 1.0);
      for (int c = 0; c < nOut; c++)
      {
        const double g = c == 0 ? gl : c == 1 ? gr : mOutGainLin;
        outputs[c][s] = static_cast<sample>(outputs[c][s] * g);
      }
    }
  }

  // Emit a MIDI CC (channel 1) whenever a continuous/boolean/trigger parameter
  // changes value. Diffing here (audio thread) is realtime-safe and captures
  // both UI edits and host automation.
  for (int i = 0; i < mNumManifestParams; i++)
  {
    const FoundryParamDesc& d = mParams[i];
    if (d.cc < 0 || d.cc > 127 || d.kind == EFoundryParamKind::Enum)
      continue;

    const double norm = GetParam(i)->GetNormalized();
    const int val127 = static_cast<int>(norm * 127.0);

    if (val127 != mLastCC[i])
    {
      mLastCC[i] = val127;
      IMidiMsg msg;
      msg.MakeControlChangeMsg(static_cast<IMidiMsg::EControlChangeMsg>(d.cc), norm, 0 /* channel 1 */, 0 /* offset */);
      SendMidiMsg(msg);
    }
  }

  // Built-in binds (manifest `bindings`): when a bound param changed, shape
  // its normalized value and perform the action. Same diff-in-audio-thread
  // pattern as the CC pool above — realtime-safe, catches UI + automation.
  for (FoundryBindDesc& b : mBinds)
  {
    if (b.paramIdx < 0 || b.paramIdx >= mNumManifestParams)
      continue;

    const double shaped = ShapeBind(GetParam(b.paramIdx)->GetNormalized(), b);

    switch (b.action)
    {
      case EFoundryBindAction::MidiCC:
      {
        const int q = static_cast<int>(shaped * 127.0 + 0.5);
        if (q != b.lastQuant)
        {
          b.lastQuant = q;
          IMidiMsg msg;
          msg.MakeControlChangeMsg(static_cast<IMidiMsg::EControlChangeMsg>(b.arg), q / 127.0, 0, 0);
          SendMidiMsg(msg);
        }
        break;
      }
      case EFoundryBindAction::MidiNote:
      {
        // Gate on the shaped value's half point: trigger params swing 0->1 on
        // press and back on release, giving clean note-on/off pairs. Velocity
        // is the shaped value at the rising edge. An amount shaped below 50
        // deliberately never crosses the gate.
        const bool on = shaped >= 0.5;
        if (on != b.gate)
        {
          b.gate = on;
          IMidiMsg msg;
          if (on)
          {
            int vel = static_cast<int>(shaped * 127.0 + 0.5);
            if (vel < 1) vel = 1;
            msg.MakeNoteOnMsg(b.arg, vel, 0, 0);
          }
          else
          {
            msg.MakeNoteOffMsg(b.arg, 0, 0);
          }
          SendMidiMsg(msg);
        }
        break;
      }
      case EFoundryBindAction::MidiPitchBend:
      {
        const int q = static_cast<int>(shaped * 16383.0 + 0.5);
        if (q != b.lastQuant)
        {
          b.lastQuant = q;
          IMidiMsg msg;
          msg.MakePitchWheelMsg(shaped * 2.0 - 1.0, 0, 0);
          SendMidiMsg(msg);
        }
        break;
      }
      case EFoundryBindAction::MidiAftertouch:
      {
        const int q = static_cast<int>(shaped * 127.0 + 0.5);
        if (q != b.lastQuant)
        {
          b.lastQuant = q;
          IMidiMsg msg;
          msg.MakeChannelATMsg(q, 0, 0);
          SendMidiMsg(msg);
        }
        break;
      }
      case EFoundryBindAction::MidiProgram:
      {
        const int q = static_cast<int>(shaped * 127.0 + 0.5);
        if (q != b.lastQuant)
        {
          b.lastQuant = q;
          IMidiMsg msg;
          msg.MakeProgramChange(q, 0, 0);
          SendMidiMsg(msg);
        }
        break;
      }
      case EFoundryBindAction::MidiPanic:
      {
        const bool on = shaped >= 0.5;
        if (on && !b.gate)
        {
          // CC 120 All Sound Off has no named enum entry in IPlugMidi.h;
          // 123 All Notes Off does (kAllNotesOff).
          IMidiMsg soundOff;
          soundOff.MakeControlChangeMsg(static_cast<IMidiMsg::EControlChangeMsg>(120), 0.0, 0, 0);
          SendMidiMsg(soundOff);
          IMidiMsg notesOff;
          notesOff.MakeControlChangeMsg(IMidiMsg::EControlChangeMsg::kAllNotesOff, 0.0, 0, 0);
          SendMidiMsg(notesOff);
        }
        b.gate = on;
        break;
      }
      case EFoundryBindAction::GainOut:
      {
        const double dB = -60.0 + shaped * 72.0; // -60..+12
        mOutGainTargetLin = std::pow(10.0, dB / 20.0);
        break;
      }
      case EFoundryBindAction::Pan:
      {
        mPanTarget = shaped * 2.0 - 1.0;
        break;
      }
      default:
        break;
    }
  }

  // LISTEN telemetry (only when something is bound to it): transport from the
  // host's ITimeInfo + post-fader I/O metering, stored in atomics for the
  // UI-thread pull (PushBindValuesToUI).
  if (!mListenIds.empty() && nFrames > 0)
  {
    mTempoAtom.store(GetTempo());
    mPlaying.store(GetTransportIsRunning());
    const double ppq = GetPPQPos();
    if (ppq >= 0.0)
    {
      int num = 4, denom = 4;
      GetTimeSig(num, denom);
      if (num < 1) num = 4;
      mBeatPhase.store(ppq - std::floor(ppq));
      const double bar = ppq / static_cast<double>(num);
      mBarPhase.store(bar - std::floor(bar));
    }
    const double samplePos = GetSamplePos();
    if (samplePos >= 0.0 && GetSampleRate() > 0.0)
      mPlayheadSec.store(samplePos / GetSampleRate());

    double sumInL = 0.0, sumInR = 0.0, sumOutL = 0.0, sumOutR = 0.0, peak = 0.0;
    for (int s = 0; s < nFrames; s++)
    {
      if (nIn > 0) { const double x = inputs[0][s]; sumInL += x * x; }
      if (nIn > 1) { const double x = inputs[1][s]; sumInR += x * x; }
      if (nOut > 0)
      {
        const double y = outputs[0][s];
        sumOutL += y * y;
        const double a = std::fabs(y);
        if (a > peak) peak = a;
      }
      if (nOut > 1)
      {
        const double y = outputs[1][s];
        sumOutR += y * y;
        const double a = std::fabs(y);
        if (a > peak) peak = a;
      }
    }
    const double inRmsL = std::sqrt(sumInL / nFrames);
    const double inRmsR = nIn > 1 ? std::sqrt(sumInR / nFrames) : inRmsL;
    mInRmsL.store(inRmsL);
    mInRmsR.store(inRmsR);
    mOutRmsL.store(std::sqrt(sumOutL / nFrames));
    mOutRmsR.store(nOut > 1 ? std::sqrt(sumOutR / nFrames) : std::sqrt(sumOutL / nFrames));
    mOutPeak.store(peak > 1.0 ? 1.0 : peak);
    mClip.store(peak >= 1.0);

    // Envelope follower on the input: fast attack, slow release (block-rate
    // ballistics — ~5ms / ~80ms at typical block sizes).
    const double inMax = inRmsL > inRmsR ? inRmsL : inRmsR;
    if (inMax > mEnvState)
      mEnvState += (inMax - mEnvState) * 0.5;
    else
      mEnvState += (inMax - mEnvState) * 0.05;
    mEnvFollow.store(mEnvState);
  }
}

void FoundryShell::OnReset()
{
  // Force CC re-emission after a transport / sample-rate reset.
  for (int i = 0; i < kMaxParams; i++)
    mLastCC[i] = -1;

  // Same for the built-in binds: re-emit on next block, release any gates.
  for (FoundryBindDesc& b : mBinds)
  {
    b.lastQuant = -1;
    b.gate = false;
  }
  mEnvState = 0.0;
}
#endif
