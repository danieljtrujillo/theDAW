import { useState, useEffect, useRef, useCallback } from "react";

// ---------------------------------------------------------------------------
// Voice input via MediaRecorder → backend /api/assistant/transcribe (server-side
// STT through faster-whisper). `listening` drives the mic
// "recording" indicator and `transcribing` shows a spinner while the recorded
// clip is uploaded. Unsupported browsers (no getUserMedia) hide the button.
// ---------------------------------------------------------------------------
export function useSpeechInput(onText: (t: string) => void) {
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const supported =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  // Stop tracks + recorder without uploading (used on unmount / errors).
  const teardown = useCallback(() => {
    try {
      if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
    } catch {
      /* noop */
    }
    recRef.current = null;
    streamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* noop */
      }
    });
    streamRef.current = null;
  }, []);

  // Release the mic if the host component ever unmounts (StrictMode dev cycles).
  useEffect(() => () => teardown(), [teardown]);

  const stop = useCallback(() => {
    // onstop assembles + uploads the blob; just request the stop here.
    try {
      recRef.current?.stop();
    } catch {
      teardown();
      setListening(false);
    }
  }, [teardown]);

  const start = useCallback(async () => {
    if (!supported || recRef.current) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Mic permission denied / no device — surface as a one-shot note in input.
      onText("[microphone unavailable — permission denied]");
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    const mimeType =
      typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.("audio/webm")
        ? "audio/webm"
        : "";
    const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = async () => {
      const tracks = streamRef.current;
      streamRef.current = null;
      recRef.current = null;
      tracks?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* noop */
        }
      });
      setListening(false);
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
      chunksRef.current = [];
      if (blob.size === 0) return;
      setTranscribing(true);
      try {
        const res = await fetch("/api/assistant/transcribe", {
          method: "POST",
          headers: { "Content-Type": blob.type || "audio/webm" },
          body: blob,
        });
        const data = await res.json().catch(() => null);
        if (data?.ok && typeof data.text === "string" && data.text.trim()) {
          onText(data.text.trim());
        } else if (data && !data.ok) {
          onText(`[transcription failed: ${data.error ?? "unknown error"}]`);
        }
      } catch {
        onText("[transcription failed — backend unreachable]");
      } finally {
        setTranscribing(false);
      }
    };
    recRef.current = rec;
    setListening(true);
    rec.start();
  }, [supported, onText]);

  return { supported, listening, transcribing, start, stop };
}
