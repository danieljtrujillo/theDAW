// The state container theDAW's offline renderer (pedalboard) stores in `vst.raw_state`.
//
// One blob has to serve two consumers — this live host and the offline renderer — so the host
// reads and writes the container the renderer already uses. The layout below was worked out by
// loading real plugins headless with pedalboard and reading the bytes of `raw_state`
// (iZotope Vinyl / Velvet, AIR Vocal Doubler, Accentize dxRevivePro); see the decisions section
// of this ticket's report for the derivation.
//
//   offset  size  meaning
//   0       4     magic, little-endian 0x21324356 (the ASCII bytes "VC2!")
//   4       4     little-endian byte length of the XML that follows (NOT counting its NUL)
//   8       N     UTF-8 XML, one line
//   8+N     1     NUL terminator
//
// XML:
//   <?xml version="1.0" encoding="UTF-8"?> <VST3PluginState><IComponent>TEXT</IComponent>
//   <IEditController>TEXT</IEditController></VST3PluginState>
//
// The <IEditController> element is absent for plugins whose controller state is unavailable.
//
// TEXT is "<decimal byte count>.<characters>": the binary stream re-based to 6 bits per
// character over the alphabet
//     . A..Z a..z 0..9 +            (index 0 is '.', index 63 is '+')
// with the bits taken LEAST-significant-first, i.e. character i carries stream bits
// [6i, 6i+6), and stream bit b is bit (b & 7) — counted from the LSB — of byte b/8. Both ends of
// that rule matter and both are least-significant-first: within the byte, and within the 6-bit
// group. Packing the same bytes most-significant-first yields text of exactly the same length
// that round-trips perfectly against itself, so only a comparison against the other host
// exposes the difference.
//
// This is not a guess. The offline renderer (pedalboard) writes the container through JUCE's
// MemoryBlock::toBase64Encoding, which emits base64EncodingTable[getBitRange(i * 6, 6)], and
// getBitRange accumulates `(data[byte] >> offsetInByte) << bitsSoFar` — low bits first on both
// axes (E:\thedaw-build\ref\JUCE\modules\juce_core\memory\juce_MemoryBlock.cpp:283, :368).
// Measured headless against real captures of pedalboard `raw_state`:
//   AIR Vocal Doubler, IComponent, 187 bytes -> 41 43 56 53 00 00 00 00 41 49 52 20 56 6f 63 61
//                                              ("ACVS" chunk magic, then "AIR Vocal Doubler")
//   iZotope Vinyl,     IComponent, 594 bytes -> 25 2b 9c 05 03 00 00 00 46 02 00 00 0c 1a 00 00
//                                              then 78 9c, a zlib header
// Decoding the same text most-significant-first gives 04 d9 15 4c … and 96 c0 a7 14 … — noise.
//
// When the byte count is not a multiple of 3 the final character has spare HIGH bits (bits at
// and above the last stream bit): the producing implementation fills them from one byte past the
// end of its buffer, so they are not reproducible (they were observed to differ between runs for
// the same state). They carry no information — this reader ignores them and this writer sets
// them to zero, which the offline renderer accepts (proved by feeding a re-encoded blob back
// into pedalboard: for AIR Vocal Doubler and iZotope Vinyl the re-encoded container is
// byte-identical to the one pedalboard produced).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace thedaw::vst3 {

struct PluginStateBlob {
    std::vector<std::uint8_t> component;
    std::vector<std::uint8_t> controller;
    bool hasController = false;
};

// Serialize. `hasController == false` omits the <IEditController> element entirely.
std::vector<std::uint8_t> writeStateContainer(const PluginStateBlob& state);

// Parse. Returns false and fills `error` with something a user can act on for anything that is
// not this container (wrong magic, truncated, missing root element, bad character in the text).
// Never throws, never reads out of bounds.
bool readStateContainer(const std::uint8_t* data, std::size_t size, PluginStateBlob& out,
                        std::string& error);

// The two halves of the text encoding, exposed for tests.
std::string encodeStateText(const std::uint8_t* data, std::size_t size);
bool decodeStateText(const std::string& text, std::vector<std::uint8_t>& out, std::string& error);

// Pins the bit order against fixed vectors, no plugin and no filesystem needed. Checks
//   1. bytes 00 01 02 … FF encode to the text JUCE produces for them, and decode back equal;
//   2. a text captured from pedalboard's `raw_state` for AIR Vocal Doubler decodes to the 187
//      bytes that capture held, starting 41 43 56 53 00 00 00 00 41 49 52 20 56 6f 63 61;
//   3. a container written by writeStateContainer reads back through readStateContainer.
// Returns true when every vector matches; otherwise false with the first mismatch in `error`.
bool selfTestStateCodec(std::string& error);

}  // namespace thedaw::vst3
