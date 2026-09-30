# third_party

## vst3_pluginterfaces

The VST3 **plugin ABI** headers. Every VST3 plugin on disk was compiled against these
declarations, so a host that wants to talk to one has to use the identical structs, vtable
layouts and interface IDs. They are copied verbatim, unmodified, from the `pluginterfaces`
folder of Steinberg's VST3 SDK.

| | |
|---|---|
| Source | <https://github.com/steinbergmedia/vst3sdk> |
| Superproject tag | `v3.8.1_build_84` (commit `3cdf9ca5d1f5b1b21e0a86832aa4abe55607bd96`) |
| `pluginterfaces` submodule commit | `4f547e8e102b47de4a8b8aaf343c73b700786372` (`v3.7.3_build_20-13-g4f547e8`) |
| Copied | `base/`, `gui/`, `vst/`, and `LICENSE.txt` (the file every header banner points at; it sits beside `pluginterfaces/`, as upstream has it) |
| Not copied | `test/`, and every other folder of the SDK |

They live at `vst3_pluginterfaces/pluginterfaces/{base,gui,vst}` because the headers include
each other as `"pluginterfaces/base/ftypes.h"`; `vst3_pluginterfaces` is therefore the include
directory, and the tree underneath it is byte-identical to the SDK's.

Four `.cpp` files come along because they are not optional: `base/funknown.cpp`,
`base/coreiids.cpp`, `base/conststringtable.cpp` and `base/ustring.cpp` are where the
interface IDs (`IComponent::iid`, `IAudioProcessor::iid`, …) and the UTF-16 string helpers
are *defined*. Without them `queryInterface` has nothing to compare against and the link
fails. They are part of the ABI, not part of a hosting framework.

**Nothing else from the SDK is vendored.** No hosting classes, no `public.sdk`, no VSTGUI,
no build system. The whole host — module loading, component/controller lifecycle, bus
negotiation, the realtime process call, parameter queues, state streams, the editor window —
is our own code in `native/vst-host/src/vst3`.

### Updating

Re-copy `base/`, `gui/` and `vst/` from a newer tag and update the table above. Do not edit
the files in place: local edits to an ABI header are indistinguishable from a bug and will
desync us from the plugins we load.
