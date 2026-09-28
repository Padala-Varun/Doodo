import { compileOp, estimateDrawMs, opRefs, type CompileEnv } from "../board/compile";
import type { BoardElement } from "../board/types";
import type { Op } from "../dml/ops";
import type { StrokeFont } from "../hand/font";
import type { Anchor, LessonEvent } from "../protocol";
import type { Animator } from "./animator";
import type { AudioEngine, PlayHandle } from "./audio";
import { Interrupted, type LessonClock } from "./clock";
import { useDoodo } from "./store";

/**
 * Lesson timeline.
 *
 * The stream is split into beats: a <voice> plus the drawing ops that follow
 * it. A beat starts its audio and its drawing together; drawing speed adapts so
 * the strokes finish roughly when the sentence does. The next beat starts when
 * both the speech and the drawing of the current one are done.
 */

interface Beat {
  voice?: { id: string; text: string };
  ops: Op[];
  closed: boolean;
}

const ANCHOR_WAIT_MS = 9000;
const FIRST_AUDIO_WAIT_MS = 2600;
const AUDIO_WAIT_MS = 1800;
const BEAT_GAP_MS = 160;

/** Speaking-time estimate when no audio (voice off / TTS failed): ~2.6 words/s. */
function speechEstimateMs(text: string): number {
  let words = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 32) words++;
  return 500 + words * 385;
}

/** Cheap pre-compile drawing-time estimate for pacing. */
function opEstimateMs(op: Op): number {
  switch (op.op) {
    case "write": return 160 + op.text.length * 70;
    case "shape": return 700 + (op.text?.length ?? 0) * 60;
    case "enclose": return 550;
    case "line": return 500 + (op.label?.length ?? 0) * 60;
    case "poly": return 700;
    case "path": return 800;
    case "sketch": return 200 + op.strokes.length * 280;
    case "label": return 120 + op.text.length * 65;
    case "callout": return 600 + op.text.length * 65;
    case "mark": return 380;
    case "brace": return 520;
    case "math": return 1000;
    case "plot": return 3200;
    case "table": return op.rows.flat().length * 260;
    case "pause": return op.ms;
    case "point": return op.ms;
    case "erase": return 700;
    default: return 0;
  }
}

export interface PlayerDeps {
  font: StrokeFont;
  audio: AudioEngine;
  clock: LessonClock;
  animator: () => Animator | null;
  /** DOM nodes of static elements (for erase animation). */
  nodesFor: (ids: string[]) => SVGGElement[];
  /** Called when a static element has been committed (to release the live copy). */
  question: string;
  lessonTop: number;
  voice: boolean;
}

export class LessonPlayer {
  private beats: Beat[] = [];
  private streamDone = false;
  private wake: (() => void)[] = [];
  private pendingAnchors = new Set<string>();
  private failedAnchors = new Set<string>();
  private env: CompileEnv;
  private current: BoardElement | null = null;
  private dml = "";
  private stopped = false;

  constructor(private readonly deps: PlayerDeps) {
    const s = useDoodo.getState();
    let seq = s.order.reduce((m, id) => Math.max(m, s.elements[id]?.seq ?? 0), 0);
    this.env = {
      font: deps.font,
      elements: new Map(s.order.map((id) => [id, s.elements[id]] as [string, BoardElement]).filter(([, e]) => !!e)),
      anchors: new Map(Object.values(s.anchors).map((a) => [a.id, a] as [string, Anchor])),
      lessonTop: deps.lessonTop,
      flow: null,
      nextSeq: () => ++seq,
    };
  }

  // -------------------------------------------------------------------------
  // Network side

  onEvent(ev: LessonEvent): void {
    const store = useDoodo.getState();
    switch (ev.t) {
      case "start":
        break;
      case "status":
        if (ev.stage === "grounding") store.set("statusText", "Looking closely at your image…");
        break;
      case "op": {
        const op = ev.op;
        if (op.op === "find") {
          if (!this.env.anchors.has(op.id)) this.pendingAnchors.add(op.id);
          return;
        }
        if (op.op === "voice") {
          const last = this.beats[this.beats.length - 1];
          if (last) last.closed = true;
          this.beats.push({ voice: { id: op.id, text: op.text }, ops: [], closed: false });
        } else {
          if (this.beats.length === 0) this.beats.push({ ops: [], closed: false });
          this.beats[this.beats.length - 1].ops.push(op);
        }
        this.notify();
        break;
      }
      case "anchor":
        this.env.anchors.set(ev.anchor.id, ev.anchor);
        this.pendingAnchors.delete(ev.anchor.id);
        store.addAnchor(ev.anchor);
        this.notify();
        break;
      case "anchor_fail":
        this.pendingAnchors.delete(ev.id);
        this.failedAnchors.add(ev.id);
        console.warn(`[doodo] could not locate "${ev.id}": ${ev.reason}`);
        this.notify();
        break;
      case "audio":
        this.deps.audio.pushPcm(ev.voiceId, ev.pcm, ev.sampleRate);
        break;
      case "audio_wav":
        this.deps.audio.pushWav(ev.voiceId, ev.wav);
        break;
      case "audio_end":
        this.deps.audio.end(ev.voiceId, ev.ok);
        break;
      case "issue":
        console.debug(`[doodo] skipped <${ev.element}>: ${ev.issue}`);
        break;
      case "done":
        this.dml = ev.dml;
        break;
      case "error":
        if (ev.dml) this.dml = ev.dml;
        store.set("error", ev.message);
        break;
    }
  }

  /** The network stream finished (normally or not). */
  endStream(): void {
    this.streamDone = true;
    const last = this.beats[this.beats.length - 1];
    if (last) last.closed = true;
    // Anything still pending will never resolve.
    for (const id of this.pendingAnchors) this.failedAnchors.add(id);
    this.pendingAnchors.clear();
    this.notify();
  }

  get transcript(): string {
    return this.dml;
  }

  private notify(): void {
    for (const w of this.wake.splice(0)) w();
  }

  private waitChange(timeoutMs = 1000): Promise<void> {
    return this.deps.clock.race(
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        this.wake.push(() => {
          clearTimeout(t);
          resolve();
        });
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Playback

  stop(): void {
    this.stopped = true;
    this.notify();
  }

  /** Play the lesson to the end. Throws Interrupted if the clock is interrupted. */
  async run(): Promise<void> {
    const store = useDoodo.getState();
    for (let i = 0; !this.stopped; i++) {
      while (!this.stopped && i >= this.beats.length && !this.streamDone) await this.waitChange();
      if (this.stopped || i >= this.beats.length) break;
      await this.playBeat(this.beats[i], i === 0);
    }
    store.set("caption", "");
  }

  private async playBeat(beat: Beat, first: boolean): Promise<void> {
    const { audio, clock } = this.deps;
    const store = useDoodo.getState();

    // 1. If the beat's (known) ops point at image targets still being located, wait for them first,
    //    so the sentence and its annotation stay together.
    await this.waitForAnchors(beat.ops.flatMap(opRefs).map((r) => r.id));

    // 2. Start speech.
    let handle: PlayHandle | null = null;
    let voiceStart = clock.now();
    let fallbackMs = 0;
    if (beat.voice) {
      fallbackMs = speechEstimateMs(beat.voice.text);
      if (this.deps.voice) await clock.race(audio.waitForData(beat.voice.id, first ? FIRST_AUDIO_WAIT_MS : AUDIO_WAIT_MS));
      handle = this.deps.voice ? audio.play(beat.voice.id) : null;
      voiceStart = clock.now();
      store.set("caption", beat.voice.text);
      store.set("status", "teaching");
      store.set("statusText", "");
    }
    const speechLeft = () => {
      if (!beat.voice) return 0;
      if (handle && handle.hasAudio()) return handle.remainingMs(fallbackMs);
      return Math.max(0, fallbackMs - (clock.now() - voiceStart));
    };

    // 3. Draw the beat's ops as they arrive.
    for (let k = 0; !this.stopped; k++) {
      while (!this.stopped && k >= beat.ops.length && !beat.closed) await this.waitChange();
      if (this.stopped || k >= beat.ops.length) break;
      const op = beat.ops[k];
      const upcoming = beat.ops.slice(k + 1).reduce((s, o) => s + opEstimateMs(o), 0) + (beat.closed ? 0 : 350);
      await this.execute(op, (drawMs) => {
        const left = speechLeft();
        if (!beat.voice) return 1.25;
        if (left <= 60) return 1.7; // speech is over: finish briskly
        return clamp((drawMs + upcoming) / (left * 0.92), 0.7, 3.4);
      });
    }

    // 4. Let the sentence finish.
    if (handle) await clock.race(handle.ended);
    else if (beat.voice) {
      const left = speechLeft();
      if (left > 0) await clock.sleep(left);
    }
    await clock.sleep(BEAT_GAP_MS);
  }

  private async waitForAnchors(ids: string[]): Promise<void> {
    const need = ids.filter((id) => this.pendingAnchors.has(id));
    if (need.length === 0) return;
    const store = useDoodo.getState();
    store.set("status", "looking");
    store.set("statusText", "Looking closely at your image…");
    const deadline = performance.now() + ANCHOR_WAIT_MS;
    while (need.some((id) => this.pendingAnchors.has(id)) && performance.now() < deadline && !this.stopped) {
      await this.waitChange(300);
    }
    store.set("statusText", "");
  }

  private async execute(op: Op, pace: (drawMs: number) => number): Promise<void> {
    const { clock } = this.deps;
    const animator = this.deps.animator();
    const store = useDoodo.getState();
    await this.waitForAnchors(opRefs(op).map((r) => r.id));
    const c = compileOp(op, this.env);
    switch (c.type) {
      case "skip":
        console.debug(`[doodo] ${op.op} skipped: ${c.reason}`);
        return;
      case "pause":
        await clock.sleep(c.ms);
        return;
      case "point":
        if (animator) await animator.point(c.at, c.ms);
        return;
      case "erase": {
        const ids = c.ids.filter((id) => this.env.elements.has(id));
        if (animator) {
          await animator.erase(this.deps.nodesFor(ids), ids.map((id) => this.env.elements.get(id)!.box));
        }
        for (const id of ids) this.env.elements.delete(id);
        store.removeElements(ids);
        if (ids.length > 1) this.env.flow = null;
        return;
      }
      case "element": {
        const el = this.resolveIdCollision(c.el);
        this.env.elements.set(el.id, el);
        this.current = el;
        if (animator) await animator.draw(el, pace(estimateDrawMs(el)));
        this.current = null;
        useDoodo.getState().addElement(el);
        return;
      }
    }
  }

  /** Newest element wins an id; older elements (or user elements) keep a renamed/unique id. */
  private resolveIdCollision(el: BoardElement): BoardElement {
    const existing = this.env.elements.get(el.id);
    if (!existing) return el;
    if (existing.author === "user") {
      let n = 2;
      while (this.env.elements.has(`${el.id}_${n}`)) n++;
      return { ...el, id: `${el.id}_${n}` };
    }
    const renamed = `${el.id}~${existing.seq}`;
    this.env.elements.delete(el.id);
    this.env.elements.set(renamed, { ...existing, id: renamed });
    useDoodo.getState().renameElement(el.id, renamed);
    return el;
  }

  /** On interrupt: land the element that was mid-animation. */
  flushCurrent(): void {
    const el = this.current;
    if (!el) return;
    this.current = null;
    useDoodo.getState().addElement(el);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export { Interrupted };
