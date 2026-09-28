"use client";

import type { BoardElement } from "../board/types";
import { BOARD_WIDTH } from "../dml/ops";
import { unionBox, type Box } from "../geom";
import { StrokeFont } from "../hand/font";
import type { LessonEvent, LessonRequest, SceneItem } from "../protocol";
import { SseDecoder } from "../sse";
import type { Animator } from "./animator";
import { AudioEngine } from "./audio";
import { Interrupted, LessonClock } from "./clock";
import { LessonPlayer } from "./player";
import { captureSnapshot } from "./snapshot";
import { contentBottom, useDoodo } from "./store";

/**
 * Client runtime singleton: owns audio, the lesson clock, the stroke font and
 * the active lesson, and exposes the high-level actions the UI calls.
 */

interface BoardBinding {
  animator: Animator;
  /** Static layers (under = fills/images, over = ink), bottom to top. */
  contentLayers: SVGGElement[];
  /** Visible board rectangle. */
  viewport(): Box;
  /** Scroll so that board y is visible. */
  reveal(y: number): void;
}

let fontPromise: Promise<StrokeFont> | null = null;

export function loadFont(): Promise<StrokeFont> {
  fontPromise ??= fetch("/fonts/shadows-into-light.json")
    .then((r) => {
      if (!r.ok) throw new Error(`font HTTP ${r.status}`);
      return r.json();
    })
    .then((json) => StrokeFont.fromVara(json))
    .catch((e) => {
      fontPromise = null;
      throw e;
    });
  return fontPromise;
}

class Runtime {
  readonly audio = new AudioEngine();
  readonly clock = new LessonClock();
  private board: BoardBinding | null = null;
  private abort: AbortController | null = null;
  private player: LessonPlayer | null = null;

  bindBoard(b: BoardBinding | null): void {
    this.board = b;
  }

  get animator(): Animator | null {
    return this.board?.animator ?? null;
  }

  /** Called by static element views once rendered, to drop the live copy. */
  released(id: string): void {
    this.board?.animator.release(id);
  }

  // -------------------------------------------------------------------------

  async ask(question: string): Promise<void> {
    const q = question.trim();
    if (!q) return;
    const store = useDoodo.getState();
    if (store.lessonActive) this.interrupt();
    const board = this.board;
    if (!board) return;

    store.checkpoint(); // one undo step for the whole lesson
    store.set("lessonActive", true);
    store.set("paused", false);
    store.set("error", null);
    store.set("status", "connecting");
    store.set("statusText", "Thinking…");
    store.set("caption", "");
    store.set("lastQuestion", q);
    store.set("selection", []);

    const settings = store.settings;
    try {
      if (settings.voice) await this.audio.unlock();
    } catch {
      /* audio unavailable: continue silently */
    }
    this.audio.reset();
    this.audio.setMuted(!settings.voice);
    this.clock.resume();

    let font: StrokeFont;
    try {
      font = await loadFont();
    } catch {
      this.fail("Could not load the handwriting font. Check your connection and try again.");
      return;
    }

    const elements = store.order.map((id) => store.elements[id]).filter(Boolean) as BoardElement[];
    const hasContent = elements.length > 0;
    const bottom = contentBottom(store.elements);
    const lessonTop = hasContent ? Math.max(0, bottom + 60) : 0;

    let request: LessonRequest;
    try {
      request = await this.buildRequest(q, elements, board, lessonTop);
    } catch (e) {
      this.fail(e instanceof Error ? e.message : "Could not capture the board.");
      return;
    }

    // Continue below existing content unless the lesson is about something on screen.
    const annotating = elements.some((e) => e.author === "user");
    if (hasContent && !annotating) board.reveal(lessonTop);

    const player = new LessonPlayer({
      font,
      audio: this.audio,
      clock: this.clock,
      animator: () => this.animator,
      nodesFor: (ids) =>
        ids.flatMap((id) =>
          board.contentLayers.flatMap((layer) => Array.from(layer.querySelectorAll<SVGGElement>(`g[data-id="${cssEscape(id)}"]`))),
        ),
      question: q,
      lessonTop: annotating ? 0 : lessonTop,
      voice: settings.voice,
    });
    this.player = player;
    const abort = new AbortController();
    this.abort = abort;
    const gen = this.clock.gen;

    store.set("status", "thinking");
    const streaming = this.stream(request, player, abort.signal);
    try {
      await Promise.all([streaming, player.run()]);
      if (this.player === player) {
        const dml = player.transcript;
        if (dml) useDoodo.getState().pushHistory(q, dml);
        this.finish();
      }
    } catch (e) {
      if (e instanceof Interrupted || this.clock.gen !== gen) return; // interrupted by user or a new question
      console.error("[doodo] lesson failed", e);
      this.fail(e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  private async stream(request: LessonRequest, player: LessonPlayer, signal: AbortSignal): Promise<void> {
    try {
      const res = await fetch("/api/lesson", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
      if (!res.ok || !res.body) {
        let msg = `Doodo is unavailable (HTTP ${res.status}).`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          /* ignore */
        }
        useDoodo.getState().set("error", msg);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const sse = new SseDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        const events = done ? sse.end() : sse.push(decoder.decode(value, { stream: true }));
        for (const ev of events) {
          let parsed: LessonEvent;
          try {
            parsed = JSON.parse(ev.data) as LessonEvent;
          } catch {
            continue;
          }
          player.onEvent(parsed);
        }
        if (done) break;
      }
    } catch (e) {
      if (!signal.aborted) {
        useDoodo.getState().set("error", "Lost connection to Doodo. Please try again.");
        console.error("[doodo] stream error", e);
      }
    } finally {
      player.endStream();
    }
  }

  private async buildRequest(q: string, elements: BoardElement[], board: BoardBinding, freeY: number): Promise<LessonRequest> {
    const store = useDoodo.getState();
    const hasImage = elements.some((e) => e.kind === "image");
    const hasUserInk = elements.some((e) => e.author === "user");
    let snapshot: LessonRequest["snapshot"];
    if (hasImage || hasUserInk || elements.length > 0) {
      // Region: what the user sees, extended to cover images and user marks.
      const vp = board.viewport();
      let region: Box | null = { x: 0, y: Math.max(0, vp.y), w: BOARD_WIDTH, h: Math.max(200, vp.h) };
      for (const e of elements) if (e.kind === "image" || e.author === "user") region = unionBox(region, e.box);
      region = clampRegion(region!);
      const snap = await captureSnapshot(board.contentLayers, elements, region, hasImage ? 2000 : 1400);
      snapshot = { dataUrl: snap.dataUrl, width: snap.width, height: snap.height, region: snap.region, hasImage };
    }
    const items: SceneItem[] = elements
      .filter((e) => e.author === "user" || e.kind !== "mark")
      .slice(-200)
      .map((e) => ({
        id: e.id,
        author: e.author,
        type: e.kind,
        box: roundBox(e.box),
        text: e.text ? e.text.slice(0, 300) : undefined,
      }));
    return {
      question: q,
      history: store.history,
      snapshot,
      scene: { width: BOARD_WIDTH, height: Math.max(900, freeY + 900), items, freeY },
      anchors: Object.values(store.anchors).map((a) => ({ id: a.id, label: a.label, kind: a.kind, box: roundBox(a.box) })),
      settings: {
        voice: store.settings.voice,
        speaker: store.settings.speaker,
        pace: store.settings.pace,
        language: "en-IN",
        deep: store.settings.deep,
      },
    };
  }

  // -------------------------------------------------------------------------

  interrupt(): void {
    const store = useDoodo.getState();
    this.abort?.abort();
    this.abort = null;
    this.player?.stop();
    this.player?.flushCurrent();
    this.player = null;
    this.clock.interrupt();
    this.clock.resume();
    this.audio.reset();
    this.animator?.releaseAll();
    this.animator?.idle();
    store.set("lessonActive", false);
    store.set("paused", false);
    store.set("status", "idle");
    store.set("statusText", "");
    store.set("caption", "");
  }

  pause(): void {
    if (!useDoodo.getState().lessonActive) return;
    this.clock.pause();
    void this.audio.pause();
    useDoodo.getState().set("paused", true);
  }

  resume(): void {
    this.clock.resume();
    void this.audio.resume();
    useDoodo.getState().set("paused", false);
  }

  private finish(): void {
    const store = useDoodo.getState();
    this.player = null;
    this.abort = null;
    store.set("lessonActive", false);
    store.set("status", store.error ? "error" : "idle");
    store.set("statusText", "");
    store.set("caption", "");
    this.animator?.idle();
  }

  private fail(message: string): void {
    const store = useDoodo.getState();
    store.set("error", message);
    this.finish();
    store.set("status", "error");
  }
}

function roundBox(b: Box): Box {
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
}

function clampRegion(r: Box): Box {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const w = Math.min(BOARD_WIDTH, r.x + r.w) - x;
  let h = r.h - (y - r.y);
  // Keep the snapshot a sensible shape (very tall boards → the top 2.2× width).
  h = Math.min(h, w * 2.2);
  return { x, y, w: Math.max(100, w), h: Math.max(100, h) };
}

function cssEscape(s: string): string {
  let out = "";
  for (const ch of s) out += ch === '"' || ch === "\\" ? "\\" + ch : ch;
  return out;
}

export const runtime = new Runtime();
