// The probe's own message thread.
//
// IPluginInstance.h declares postToMessageThread()/isMessageThread() and leaves them to whoever
// is driving the plugin. The live host has a real message loop; this is the probe's standalone
// one, so the VST3 layer can be exercised with nothing else of the host built.
//
// A message-only window rather than PostThreadMessage: thread messages are silently dropped when
// a plugin spins its own modal loop (preset browsers and file dialogs do), a message-only
// window's queue is not.
#pragma once

namespace thedaw::probe {

// Call once, on the thread that will run the loop, before any plugin exists.
bool startMessageThread();
void stopMessageThread();

// Drain everything waiting, including plugin window messages. Returns false when a WM_QUIT
// arrived.
bool pumpMessages();

// Pump for `seconds`, sleeping between passes so the thread does not spin.
void pumpFor(double seconds);

}  // namespace thedaw::probe
