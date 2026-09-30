// Timestamped logging to the --log file.
//
// Threads other than the audio thread format and write directly under a mutex.
// The audio thread must never touch the file, a mutex or the heap, so it pushes
// a pointer to a string literal plus two integers into a lock-free ring that the
// logger thread drains and formats.
#pragma once

#include <cstdint>
#include <string>

namespace thedaw::util {

// Names the calling thread in every line it logs ("message", "audio", ...).
void setThreadTag(const char* tag);

namespace log {

bool open(const std::wstring& path, std::string& error);
void close();
bool enabled();

void write(const std::string& line);
void writef(const char* format, ...);

// AUDIO THREAD ONLY. `message` must have static storage duration (a literal).
// Silently drops the note when the ring is full, which is the correct behaviour
// for a realtime thread.
void audioNote(const char* message, long long a = 0, long long b = 0);

// Drains the audio ring into the file. The ring is single-consumer: only the
// logger thread may call this.
void drainAudioNotes();

// Starts/stops the logger thread that drains the audio ring and flushes the
// file. No-ops when no log file is open.
void startDrainThread();
void stopDrainThread();

}  // namespace log
}  // namespace thedaw::util
