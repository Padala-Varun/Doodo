"use client";

import { useEffect, useRef, useState } from "react";
import { runtime } from "@/lib/client/runtime";
import { useDoodo } from "@/lib/client/store";
import { IconMic, IconPause, IconPlay, IconSend, IconStop } from "./icons";

/** Bottom dock: live caption, lesson controls and the ask bar (text + push-to-talk). */
export default function Dock() {
  const caption = useDoodo((s) => s.caption);
  const lessonActive = useDoodo((s) => s.lessonActive);
  const paused = useDoodo((s) => s.paused);
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const recRef = useRef<{ rec: MediaRecorder; chunks: Blob[]; stream: MediaStream } | null>(null);

  // Auto-grow the textarea.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(140, ta.scrollHeight)}px`;
  }, [text]);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      const q = (e as CustomEvent<string>).detail;
      if (q) void send(q);
    };
    window.addEventListener("doodo:ask", onPrompt);
    return () => window.removeEventListener("doodo:ask", onPrompt);
  });

  async function send(q = text) {
    const question = q.trim();
    if (!question) return;
    setText("");
    await runtime.ask(question);
  }

  async function toggleMic() {
    if (recording) {
      recRef.current?.rec.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      useDoodo.getState().set("error", "Voice input is not supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 1200) return; // too short to contain speech
        setTranscribing(true);
        try {
          const fd = new FormData();
          fd.append("file", blob, "speech");
          fd.append("language", "en-IN");
          const res = await fetch("/api/stt", { method: "POST", body: fd });
          const j = (await res.json()) as { transcript?: string; error?: string };
          if (!res.ok) throw new Error(j.error ?? "transcription failed");
          if (j.transcript) await send(j.transcript);
        } catch (e) {
          useDoodo.getState().set("error", e instanceof Error ? `Voice input: ${e.message}` : "Voice input failed.");
        } finally {
          setTranscribing(false);
        }
      };
      recRef.current = { rec, chunks, stream };
      if (useDoodo.getState().lessonActive) runtime.pause();
      rec.start(250);
      setRecording(true);
    } catch {
      useDoodo.getState().set("error", "Microphone permission was denied.");
    }
  }

  return (
    <div className="dock" onPointerDown={(e) => e.stopPropagation()}>
      {caption && (
        <div className="caption" key={caption} aria-live="polite">
          {caption}
        </div>
      )}
      {lessonActive && (
        <div className="controls">
          {paused ? (
            <button className="pill" onClick={() => runtime.resume()}>
              <IconPlay width={16} height={16} /> Resume
            </button>
          ) : (
            <button className="pill" onClick={() => runtime.pause()}>
              <IconPause width={16} height={16} /> Pause
            </button>
          )}
          <button className="pill danger" onClick={() => runtime.interrupt()}>
            <IconStop width={16} height={16} /> Stop
          </button>
        </div>
      )}
      <form
        className="askbar"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder={
            transcribing ? "Listening…" : lessonActive ? "Ask a follow-up (this interrupts Doodo)…" : "Ask anything, or draw / drop an image and ask about it"
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          aria-label="Your question"
          maxLength={4000}
        />
        <button
          type="button"
          className="icon-btn"
          data-recording={recording ? "1" : "0"}
          title={recording ? "Stop and send" : "Ask with your voice"}
          aria-label={recording ? "Stop recording" : "Record a question"}
          onClick={toggleMic}
          disabled={transcribing}
        >
          <IconMic />
        </button>
        <button type="submit" className="ask-btn" disabled={!text.trim()}>
          Ask Doodo <IconSend width={18} height={18} />
        </button>
      </form>
    </div>
  );
}
