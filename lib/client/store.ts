"use client";

import { create } from "zustand";
import type { BoardElement } from "../board/types";
import { BOARD_MIN_HEIGHT } from "../dml/ops";
import { PALETTE } from "../dml/values";
import type { Anchor } from "../protocol";

export type Tool = "select" | "hand" | "pen" | "highlighter" | "text" | "rect" | "ellipse" | "arrow" | "eraser";

export type LessonStatus = "idle" | "connecting" | "thinking" | "looking" | "teaching" | "finishing" | "error";

export interface Settings {
  voice: boolean;
  deep: boolean;
  speaker: string;
  /** Drawing speed multiplier. */
  speed: number;
  /** TTS pace. */
  pace: number;
}

interface BoardSnapshot {
  elements: Record<string, BoardElement>;
  order: string[];
  anchors: Record<string, Anchor>;
}

export interface DoodoState {
  elements: Record<string, BoardElement>;
  order: string[];
  anchors: Record<string, Anchor>;
  history: { role: "user" | "assistant"; content: string }[];

  status: LessonStatus;
  statusText: string;
  caption: string;
  error: string | null;
  lessonActive: boolean;
  paused: boolean;
  lastQuestion: string;

  tool: Tool;
  color: string;
  width: number;
  selection: string[];
  settings: Settings;

  /** Vertical scroll (board px) and user zoom (1 = fit width). */
  scrollY: number;
  zoom: number;

  undoStack: BoardSnapshot[];
  redoStack: BoardSnapshot[];
  nextUserId: number;

  // --- actions ---
  addElement(el: BoardElement): void;
  removeElements(ids: string[]): void;
  replaceElement(el: BoardElement): void;
  renameElement(from: string, to: string): void;
  addAnchor(a: Anchor): void;
  clearAnchors(): void;
  pushHistory(q: string, dml: string): void;
  checkpoint(): void;
  undo(): void;
  redo(): void;
  clearBoard(): void;
  allocUserId(): string;
  set<K extends keyof DoodoState>(key: K, value: DoodoState[K]): void;
  setSettings(p: Partial<Settings>): void;
}

const MAX_UNDO = 60;

function snap(s: DoodoState): BoardSnapshot {
  return { elements: s.elements, order: s.order, anchors: s.anchors };
}

export const useDoodo = create<DoodoState>((set, get) => ({
  elements: {},
  order: [],
  anchors: {},
  history: [],

  status: "idle",
  statusText: "",
  caption: "",
  error: null,
  lessonActive: false,
  paused: false,
  lastQuestion: "",

  tool: "pen",
  color: PALETTE.blue,
  width: 3,
  selection: [],
  settings: { voice: true, deep: false, speaker: "shubh", speed: 1, pace: 1.05 },

  scrollY: 0,
  zoom: 1,

  undoStack: [],
  redoStack: [],
  nextUserId: 1,

  addElement(el) {
    set((s) => ({
      elements: { ...s.elements, [el.id]: el },
      order: s.elements[el.id] ? s.order : [...s.order, el.id],
    }));
  },

  removeElements(ids) {
    if (ids.length === 0) return;
    set((s) => {
      const elements = { ...s.elements };
      const gone = new Set(ids);
      let imageRemoved = false;
      for (const id of ids) {
        if (elements[id]?.kind === "image") imageRemoved = true;
        delete elements[id];
      }
      return {
        elements,
        order: s.order.filter((id) => !gone.has(id)),
        selection: s.selection.filter((id) => !gone.has(id)),
        // Grounded boxes refer to image content; drop them if an image goes away.
        anchors: imageRemoved ? {} : s.anchors,
      };
    });
  },

  replaceElement(el) {
    set((s) => {
      const prev = s.elements[el.id];
      const moved = prev && prev.kind === "image" && (prev.box.x !== el.box.x || prev.box.y !== el.box.y);
      return { elements: { ...s.elements, [el.id]: el }, anchors: moved ? {} : s.anchors };
    });
  },

  renameElement(from, to) {
    set((s) => {
      const el = s.elements[from];
      if (!el || s.elements[to]) return {};
      const elements = { ...s.elements };
      delete elements[from];
      elements[to] = { ...el, id: to };
      return { elements, order: s.order.map((id) => (id === from ? to : id)) };
    });
  },

  addAnchor(a) {
    set((s) => ({ anchors: { ...s.anchors, [a.id]: a } }));
  },

  clearAnchors() {
    set({ anchors: {} });
  },

  pushHistory(q, dml) {
    set((s) => ({
      history: [...s.history, { role: "user" as const, content: q }, { role: "assistant" as const, content: dml }].slice(-16),
    }));
  },

  checkpoint() {
    set((s) => ({ undoStack: [...s.undoStack, snap(s)].slice(-MAX_UNDO), redoStack: [] }));
  },

  undo() {
    const s = get();
    const prev = s.undoStack[s.undoStack.length - 1];
    if (!prev || s.lessonActive) return;
    set({ ...prev, undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, snap(s)], selection: [] });
  },

  redo() {
    const s = get();
    const next = s.redoStack[s.redoStack.length - 1];
    if (!next || s.lessonActive) return;
    set({ ...next, redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, snap(s)], selection: [] });
  },

  clearBoard() {
    get().checkpoint();
    set({ elements: {}, order: [], anchors: {}, selection: [], history: [], scrollY: 0, caption: "", error: null });
  },

  allocUserId() {
    const n = get().nextUserId;
    set({ nextUserId: n + 1 });
    return `u${n}`;
  },

  set(key, value) {
    set({ [key]: value } as Partial<DoodoState>);
  },

  setSettings(p) {
    set((s) => ({ settings: { ...s.settings, ...p } }));
  },
}));

export function boardHeight(elements: Record<string, BoardElement>): number {
  let bottom = 0;
  for (const el of Object.values(elements)) bottom = Math.max(bottom, el.box.y + el.box.h);
  return Math.max(BOARD_MIN_HEIGHT, bottom + 320);
}

export function contentBottom(elements: Record<string, BoardElement>): number {
  let bottom = 0;
  for (const el of Object.values(elements)) bottom = Math.max(bottom, el.box.y + el.box.h);
  return bottom;
}
