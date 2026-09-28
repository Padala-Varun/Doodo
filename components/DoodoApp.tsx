"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { runtime } from "@/lib/client/runtime";
import { useDoodo } from "@/lib/client/store";
import Dock from "./Dock";
import { IconMute, IconSpark, IconVolume } from "./icons";
import Toolbar from "./Toolbar";

// The board is browser-only (SVG measurement, audio, pointer input).
const Board = dynamic(() => import("./Board"), { ssr: false });

const SPEAKERS = [
  { id: "shubh", label: "Shubh" },
  { id: "ritu", label: "Ritu" },
  { id: "aditya", label: "Aditya" },
  { id: "priya", label: "Priya" },
  { id: "kavya", label: "Kavya" },
  { id: "rahul", label: "Rahul" },
];

const EXAMPLES = [
  "Explain the Pythagorean theorem",
  "How does the heart pump blood?",
  "What is recursion? Show factorial",
  "Why is the sky blue?",
  "Explain binary search",
];

function TopBar() {
  const settings = useDoodo((s) => s.settings);
  const setSettings = useDoodo((s) => s.setSettings);
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">
          Doodo<span>.</span>
        </span>
        <span className="brand-tag">a teacher that thinks out loud — on a whiteboard</span>
      </div>
      <div className="topbar-spacer" />
      <button
        className="toggle"
        aria-pressed={settings.voice}
        onClick={() => {
          const voice = !settings.voice;
          setSettings({ voice });
          runtime.audio.setMuted(!voice);
        }}
        title={settings.voice ? "Voice on" : "Voice off (captions only)"}
      >
        {settings.voice ? <IconVolume width={16} height={16} /> : <IconMute width={16} height={16} />}
        Voice
      </button>
      <select className="select" value={settings.speaker} onChange={(e) => setSettings({ speaker: e.target.value })} aria-label="Voice">
        {SPEAKERS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      <select
        className="select"
        value={String(settings.speed)}
        onChange={(e) => {
          const speed = Number(e.target.value);
          setSettings({ speed, pace: Math.min(1.6, 1.05 * (0.75 + speed * 0.25)) });
          const a = runtime.animator;
          if (a) a.userSpeed = speed;
        }}
        aria-label="Speed"
      >
        {[1, 1.25, 1.5, 2].map((v) => (
          <option key={v} value={v}>
            {v}× speed
          </option>
        ))}
      </select>
      <button
        className="toggle"
        aria-pressed={settings.deep}
        onClick={() => setSettings({ deep: !settings.deep })}
        title="Deep mode uses a slower, more capable model for richer drawings"
      >
        <IconSpark width={16} height={16} /> Deep mode
      </button>
    </header>
  );
}

function Avatar() {
  const status = useDoodo((s) => s.status);
  const statusText = useDoodo((s) => s.statusText);
  const lessonActive = useDoodo((s) => s.lessonActive);
  const faceRef = useRef<HTMLDivElement>(null);
  const mouthRef = useRef<SVGEllipseElement>(null);

  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      const lvl = runtime.audio.level();
      smooth += (lvl - smooth) * 0.35;
      if (mouthRef.current) mouthRef.current.setAttribute("ry", String(1.5 + smooth * 7));
      if (faceRef.current) faceRef.current.style.transform = `scale(${1 + smooth * 0.08}) rotate(${Math.sin(performance.now() / 700) * (lessonActive ? 4 : 1.5)}deg)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lessonActive]);

  const busy = status === "connecting" || status === "thinking" || status === "looking";
  const label = statusText || (busy ? "Thinking" : "");
  return (
    <div className="avatar" aria-hidden>
      <div className="avatar-face" ref={faceRef}>
        <svg width="40" height="40" viewBox="0 0 40 40">
          <ellipse cx="13" cy="15" rx="3" ry={busy ? 1.2 : 3.4} fill="#1f2328" />
          <ellipse cx="27" cy="15" rx="3" ry={busy ? 1.2 : 3.4} fill="#1f2328" />
          <ellipse ref={mouthRef} cx="20" cy="27" rx="6" ry="1.5" fill="#7c2d12" />
        </svg>
      </div>
      {label && (
        <div className="avatar-bubble">
          {label}
          {busy && (
            <span className="dots">
              <span />
              <span />
              <span />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  const empty = useDoodo((s) => s.order.length === 0);
  const lessonActive = useDoodo((s) => s.lessonActive);
  if (!empty || lessonActive) return null;
  return (
    <div className="empty">
      <h1>What shall we learn today?</h1>
      <p>Ask anything and Doodo will explain it on the board. You can also draw, type, or drop an image and ask about it.</p>
      <div className="chips">
        {EXAMPLES.map((q) => (
          <button key={q} className="chip" onClick={() => window.dispatchEvent(new CustomEvent("doodo:ask", { detail: q }))}>
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toast() {
  const error = useDoodo((s) => s.error);
  if (!error) return null;
  return (
    <div className="toast" role="alert">
      {error}
      <button onClick={() => useDoodo.getState().set("error", null)} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}

export default function DoodoApp() {
  return (
    <div className="app">
      <TopBar />
      <main className="stage">
        <Board />
        <Toolbar />
        <EmptyState />
        <Avatar />
        <Dock />
        <Toast />
      </main>
    </div>
  );
}
