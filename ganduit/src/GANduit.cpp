// GANduit - implementation. See GANduit.h for the scaffold caveats.
#include "GANduit.h"
#include "IPlug_include_in_plug_src.h"

namespace {
// Shown when no .gan has been loaded yet. The real surface replaces this once
// LoadGan() points the WebView at an extracted index.html.
const char* kPlaceholderHTML =
  "<!doctype html><html><head><meta charset='utf-8'>"
  "<style>html,body{height:100%;margin:0;background:#07050a;color:#9aa;"
  "font:600 13px/1.4 system-ui;display:grid;place-items:center}"
  ".b{opacity:.7;text-align:center}</style></head><body>"
  "<div class='b'>GANduit<br><span style='font-weight:400'>drop a .gan to load its surface</span></div>"
  "</body></html>";

// Tiny JSON field extractors for the small, fixed message shapes the .gan UI
// posts (see the web-bridge contract below). A full build can swap these for the
// JSON lib iPlug2 vendors; these keep the scaffold dependency-free.
std::string JsonStr(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  auto k = json.find(needle);
  if (k == std::string::npos) return "";
  auto colon = json.find(':', k + needle.size());
  if (colon == std::string::npos) return "";
  auto q1 = json.find('"', colon + 1);
  if (q1 == std::string::npos) return "";
  auto q2 = json.find('"', q1 + 1);
  if (q2 == std::string::npos) return "";
  return json.substr(q1 + 1, q2 - q1 - 1);
}

double JsonNum(const std::string& json, const std::string& key, double dflt) {
  const std::string needle = "\"" + key + "\"";
  auto k = json.find(needle);
  if (k == std::string::npos) return dflt;
  auto colon = json.find(':', k + needle.size());
  if (colon == std::string::npos) return dflt;
  try {
    return std::stod(json.substr(colon + 1));
  } catch (...) {
    return dflt;
  }
}
}  // namespace

GANduit::GANduit(const InstanceInfo& info)
: Plugin(info, MakeConfig(GANDUIT_NUM_PARAMS, kNumPresets))
{
  // Generic, host-automatable macros. A .gan UI binds these by index; each maps
  // 1:1 to a MIDI CC (param 0 -> CC 1, ...) so the surface drives the DAW like a
  // hardware controller.
  for (int i = 0; i < GANDUIT_NUM_PARAMS; i++) {
    WDL_String name;
    name.SetFormatted(32, "Macro %d", i + 1);
    GetParam(i)->InitDouble(name.Get(), 0.0, 0.0, 100.0, 0.01, "%");
    mParamToCC[i] = (i + 1 <= 119) ? (i + 1) : 1;  // CC 1..119
  }

  // Load the active .gan's index.html once the WebView editor is created. The
  // host passes the .gan path via state chunk / message; default to placeholder.
  mEditorInitFunc = [&]() {
    if (mGan.ok && !mGan.entryHtml.empty())
      LoadFile(mGan.entryHtml.c_str(), nullptr);  // iPlug2 IWebView::LoadFile
    else
      LoadHTML(kPlaceholderHTML);
  };
}

void GANduit::ProcessBlock(sample** inputs, sample** outputs, int nFrames)
{
  // Controller/host shell: audio is passed through untouched.
  const int nChans = NOutChansConnected();
  for (int c = 0; c < nChans; c++)
    for (int s = 0; s < nFrames; s++)
      outputs[c][s] = inputs[c][s];
}

void GANduit::ProcessMidiMsg(const IMidiMsg& msg)
{
  SendMidiMsg(msg);  // pass incoming MIDI through to the output
}

void GANduit::OnParamChange(int paramIdx)
{
  // Mirror the parameter as a MIDI CC so the host can record/route it and the
  // surface behaves like a hardware controller. Normalized 0..1 -> CC 0..127.
  if (paramIdx < 0 || paramIdx >= GANDUIT_NUM_PARAMS) return;
  const double norm = GetParam(paramIdx)->GetNormalized();
  IMidiMsg cc;
  cc.MakeControlChange(mParamToCC[paramIdx], (int)(norm * 127.0 + 0.5), mMidiOutChannel);
  SendMidiMsg(cc);
}

void GANduit::OnParamChangeUI(int paramIdx, EParamSource source)
{
  // The WebView pushed a value; OnParamChange already fired the CC. Hook left
  // for surface-specific echo / smoothing if a .gan needs it.
}

bool GANduit::OnMessageFromWebView(const char* json)
{
  // The .gan UI talks to the shell over the iPlug2 web bridge. Contract:
  //   { "tag": "loadGan", "path": "C:/.../the-owl.gan" }   -> swap the surface
  //   { "tag": "param", "idx": 0, "value": 0.42 }          -> set a macro (0..1)
  if (!json) return false;
  const std::string msg(json);
  const std::string tag = JsonStr(msg, "tag");

  if (tag == "loadGan") {
    const std::string path = JsonStr(msg, "path");
    if (!path.empty()) {
      LoadGan(path.c_str());
      return true;
    }
    return false;
  }

  if (tag == "param") {
    const int idx = static_cast<int>(JsonNum(msg, "idx", -1.0));
    const double value = JsonNum(msg, "value", -1.0);  // normalized 0..1 from the UI
    if (idx >= 0 && idx < GANDUIT_NUM_PARAMS && value >= 0.0) {
      // Set from the UI -> updates the host parameter AND fires OnParamChange,
      // which emits the mirrored MIDI CC.
      SendParameterValueFromUI(idx, value);
      return true;
    }
    return false;
  }

  return false;
}

void GANduit::OnUIOpen()
{
  // Re-assert the loaded surface when the editor is reopened.
  if (mGan.ok && !mGan.entryHtml.empty())
    LoadFile(mGan.entryHtml.c_str(), nullptr);
}

void GANduit::OnIdle() {}

void GANduit::LoadGan(const char* ganPath)
{
  ganduit::CleanupGan(mGan);
  mGan = ganduit::ExtractGan(ganPath ? ganPath : "");
  if (mGan.ok)
    LoadFile(mGan.entryHtml.c_str(), nullptr);
  else
    LoadHTML(kPlaceholderHTML);
}
