/**
 * Voice playback for streamed TTS.
 *
 * Each voice segment is a Track that receives 16-bit PCM chunks (or a WAV
 * fallback) while the lesson streams. When the timeline starts a track, its
 * buffered chunks are scheduled back-to-back on the AudioContext clock and new
 * chunks are appended gaplessly as they arrive. Pausing suspends the context,
 * which pauses every scheduled source in sync with the drawing clock.
 */

interface Track {
  id: string;
  buffers: AudioBuffer[];
  /** Serialises async decoding so buffers stay in order. */
  decodeChain: Promise<void>;
  carry: Uint8Array | null;
  serverEnded: boolean;
  ok: boolean;
  playing: boolean;
  scheduledIdx: number;
  nextTime: number;
  activeSources: number;
  endedResolvers: (() => void)[];
  firstDataResolvers: (() => void)[];
  totalSec: number;
  startedAt: number;
  finished: boolean;
}

export interface PlayHandle {
  /** Resolves when the whole segment has played (or failed). */
  ended: Promise<void>;
  /** Estimated remaining playback time in ms (uses `fallbackMs` until the length is known). */
  remainingMs(fallbackMs: number): number;
  /** True if real audio is (or was) playing. */
  hasAudio(): boolean;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuf: Uint8Array<ArrayBuffer> | null = null;
  private tracks = new Map<string, Track>();
  private muted = false;

  /** Must be called from a user gesture the first time (autoplay policy). */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: "interactive" });
      this.out = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.levelBuf = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
      this.out.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.out) this.out.gain.value = m ? 0 : 1;
  }

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = {
        id, buffers: [], decodeChain: Promise.resolve(), carry: null, serverEnded: false, ok: true, playing: false,
        scheduledIdx: 0, nextTime: 0, activeSources: 0, endedResolvers: [], firstDataResolvers: [], totalSec: 0,
        startedAt: 0, finished: false,
      };
      this.tracks.set(id, t);
    }
    return t;
  }

  pushPcm(voiceId: string, b64: string, sampleRate: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = this.track(voiceId);
    let bytes = b64ToBytes(b64);
    if (t.carry) {
      const merged = new Uint8Array(t.carry.length + bytes.length);
      merged.set(t.carry);
      merged.set(bytes, t.carry.length);
      bytes = merged;
      t.carry = null;
    }
    if (bytes.length % 2 === 1) {
      t.carry = bytes.slice(bytes.length - 1);
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    const n = bytes.length / 2;
    if (n === 0) return;
    const buf = ctx.createBuffer(1, n, sampleRate);
    const ch = buf.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    this.addBuffer(t, buf);
  }

  pushWav(voiceId: string, b64: string): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = this.track(voiceId);
    const bytes = b64ToBytes(b64);
    t.decodeChain = t.decodeChain.then(async () => {
      try {
        const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        this.addBuffer(t, buf);
      } catch {
        /* undecodable chunk: skip */
      }
    });
  }

  end(voiceId: string, ok: boolean): void {
    const t = this.track(voiceId);
    void t.decodeChain.then(() => {
      t.serverEnded = true;
      t.ok = ok;
      for (const r of t.firstDataResolvers.splice(0)) r();
      this.maybeFinish(t);
    });
  }

  private addBuffer(t: Track, buf: AudioBuffer): void {
    t.buffers.push(buf);
    t.totalSec += buf.duration;
    for (const r of t.firstDataResolvers.splice(0)) r();
    if (t.playing) this.scheduleFrom(t);
  }

  /** Resolves when the first audio arrives, the track ends, or after `timeoutMs`. */
  waitForData(voiceId: string, timeoutMs: number): Promise<void> {
    const t = this.track(voiceId);
    if (t.buffers.length > 0 || t.serverEnded || !this.ctx) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      t.firstDataResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  play(voiceId: string): PlayHandle {
    const t = this.track(voiceId);
    const ctx = this.ctx;
    const ended = new Promise<void>((resolve) => t.endedResolvers.push(resolve));
    if (!ctx) {
      t.finished = true;
      for (const r of t.endedResolvers.splice(0)) r();
    } else {
      t.playing = true;
      t.startedAt = ctx.currentTime;
      t.nextTime = ctx.currentTime + 0.04;
      this.scheduleFrom(t);
      this.maybeFinish(t);
    }
    return {
      ended,
      hasAudio: () => t.buffers.length > 0,
      remainingMs: (fallbackMs: number) => {
        if (!ctx || t.finished) return 0;
        if (t.buffers.length === 0) return t.serverEnded ? 0 : fallbackMs;
        const scheduledLeft = Math.max(0, t.nextTime - ctx.currentTime) * 1000;
        if (t.serverEnded) return scheduledLeft;
        // Still streaming: assume the rest of the sentence is proportional to the fallback estimate.
        const elapsed = (ctx.currentTime - t.startedAt) * 1000;
        return Math.max(scheduledLeft, fallbackMs - elapsed);
      },
    };
  }

  private scheduleFrom(t: Track): void {
    const ctx = this.ctx;
    if (!ctx || !this.out) return;
    while (t.scheduledIdx < t.buffers.length) {
      const buf = t.buffers[t.scheduledIdx++];
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.out);
      const at = Math.max(t.nextTime, ctx.currentTime + 0.02);
      src.start(at);
      t.nextTime = at + buf.duration;
      t.activeSources++;
      src.onended = () => {
        t.activeSources--;
        this.maybeFinish(t);
      };
    }
  }

  private maybeFinish(t: Track): void {
    if (t.finished || !t.playing || !t.serverEnded) return;
    if (t.activeSources > 0 || t.scheduledIdx < t.buffers.length) return;
    t.finished = true;
    for (const r of t.endedResolvers.splice(0)) r();
  }

  /** 0..1 loudness of what is playing now (for the avatar). */
  level(): number {
    if (!this.analyser || !this.levelBuf || this.muted) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = (this.levelBuf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 4);
  }

  async pause(): Promise<void> {
    if (this.ctx && this.ctx.state === "running") await this.ctx.suspend().catch(() => {});
  }

  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
  }

  /** Stop and forget everything (interrupt / new lesson). */
  reset(): void {
    for (const t of this.tracks.values()) {
      t.playing = false;
      t.finished = true;
      for (const r of t.endedResolvers.splice(0)) r();
      for (const r of t.firstDataResolvers.splice(0)) r();
    }
    this.tracks.clear();
    // Recreate the output node so already-scheduled sources are cut immediately.
    if (this.ctx && this.out && this.analyser) {
      this.out.disconnect();
      this.out = this.ctx.createGain();
      this.out.gain.value = this.muted ? 0 : 1;
      this.out.connect(this.analyser);
    }
  }
}
