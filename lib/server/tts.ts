import { config } from "./config";

/**
 * Sarvam text-to-speech.
 *
 * Primary path: one streaming WebSocket per lesson (≈270 ms to first audio per
 * segment). Voice segments are synthesised strictly in order; each segment is
 * sent as text + flush and ends with Sarvam's `final` event, so every audio
 * chunk is unambiguously attributed to its voice id. Audio is raw 16-bit PCM,
 * which the browser schedules gaplessly.
 *
 * Fallback path: if the socket cannot be opened, dies, or a segment times out,
 * the remaining segments are synthesised over REST (WAV) instead.
 */

export interface TtsSink {
  pcm(voiceId: string, seq: number, pcmBase64: string, sampleRate: number): void;
  wav(voiceId: string, wavBase64: string): void;
  end(voiceId: string, ok: boolean): void;
}

export interface TtsOptions {
  speaker?: string;
  pace?: number;
  language?: string;
}

const WS_URL = "wss://api.sarvam.ai/text-to-speech/ws";
const REST_URL = "https://api.sarvam.ai/text-to-speech";
const SEGMENT_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 5_000;
const PING_INTERVAL_MS = 20_000;
const MAX_PIECE = 450;

interface Item {
  voiceId: string;
  text: string;
}

type WsLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
};

/** Split long text into speakable pieces at sentence boundaries (Intl.Segmenter, no regex). */
export function splitForTts(text: string, max = MAX_PIECE): string[] {
  const seg = new Intl.Segmenter("en", { granularity: "sentence" });
  const out: string[] = [];
  let cur = "";
  for (const { segment } of seg.segment(text)) {
    if (cur.length + segment.length > max && cur.trim()) {
      out.push(cur.trim());
      cur = "";
    }
    if (segment.length > max) {
      // A single enormous "sentence": split at word boundaries.
      const words = new Intl.Segmenter("en", { granularity: "word" });
      for (const { segment: w } of words.segment(segment)) {
        if (cur.length + w.length > max && cur.trim()) {
          out.push(cur.trim());
          cur = "";
        }
        cur += w;
      }
    } else {
      cur += segment;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export class SarvamTts {
  private ws: WsLike | null = null;
  private wsReady: Promise<boolean> | null = null;
  private wsBroken = false;
  private wsFailures = 0;
  private queue: Item[] = [];
  private current: { item: Item; seq: number; timer: ReturnType<typeof setTimeout>; resolve: (ok: boolean) => void } | null = null;
  private pumping = false;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly speaker: string;
  private readonly pace: number;
  private readonly language: string;

  constructor(private readonly sink: TtsSink, opts: TtsOptions = {}) {
    this.speaker = opts.speaker || config.ttsSpeaker;
    this.pace = opts.pace ?? config.ttsPace;
    this.language = opts.language || "en-IN";
  }

  /** Open the socket early so the connection handshake overlaps LLM latency. */
  warmUp(): void {
    void this.ensureSocket();
  }

  enqueue(voiceId: string, text: string): void {
    if (this.closed) return;
    this.queue.push({ voiceId, text });
    void this.pump();
  }

  /** Resolves once every queued segment has finished (or failed). */
  async drain(): Promise<void> {
    while (!this.closed && (this.pumping || this.queue.length > 0)) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  close(): void {
    this.closed = true;
    this.queue = [];
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.resolve(false);
      this.current = null;
    }
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      this.ws?.close(1000);
    } catch {
      /* already closed */
    }
    this.ws = null;
  }

  // -------------------------------------------------------------------------

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        const item = this.queue.shift()!;
        const viaWs = !this.wsBroken && (await this.ensureSocket());
        let ok = false;
        if (viaWs) ok = await this.synthWs(item);
        if (!ok && !this.closed) ok = await this.synthRest(item);
        if (!this.closed) this.sink.end(item.voiceId, ok);
      }
    } finally {
      this.pumping = false;
    }
  }

  private ensureSocket(): Promise<boolean> {
    if (this.wsBroken) return Promise.resolve(false);
    if (this.wsReady && this.ws && this.ws.readyState <= 1) return this.wsReady;
    this.wsReady = new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (v: boolean) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      let ws: WsLike;
      try {
        const url = `${WS_URL}?model=${encodeURIComponent(config.ttsModel)}&send_completion_event=true`;
        // Node's (undici) WebSocket accepts custom headers via the init object.
        const Ctor = WebSocket as unknown as new (url: string, init: object) => WsLike;
        ws = new Ctor(url, { headers: { "Api-Subscription-Key": config.sarvamKey } });
      } catch {
        this.wsBroken = true;
        settle(false);
        return;
      }
      this.ws = ws;
      const connectTimer = setTimeout(() => {
        this.wsBroken = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        settle(false);
      }, CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(connectTimer);
        ws.send(
          JSON.stringify({
            type: "config",
            data: {
              speaker: this.speaker,
              target_language_code: this.language,
              pace: this.pace,
              output_audio_codec: "linear16",
              speech_sample_rate: config.ttsSampleRate,
              min_buffer_size: 30,
              max_chunk_length: 200,
            },
          }),
        );
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (ws.readyState === 1 && !this.current) {
            try {
              ws.send(JSON.stringify({ type: "ping" }));
            } catch {
              /* ignore */
            }
          }
        }, PING_INTERVAL_MS);
        settle(true);
      };
      ws.onmessage = (ev) => this.onMessage(ev.data);
      ws.onerror = () => {
        clearTimeout(connectTimer);
        if (!settled && ++this.wsFailures >= 2) this.wsBroken = true;
        settle(false);
      };
      ws.onclose = () => {
        clearTimeout(connectTimer);
        settle(false);
        if (this.ws === ws) this.ws = null;
        // Fail the in-flight segment; pump() retries it over REST.
        if (this.current) {
          clearTimeout(this.current.timer);
          const cur = this.current;
          this.current = null;
          cur.resolve(cur.seq > 0 ? true : false);
        }
      };
    });
    return this.wsReady;
  }

  private synthWs(item: Item): Promise<boolean> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // Timed out: the socket state is unknown, so drop it; later items reconnect.
        const cur = this.current;
        this.current = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        cur?.resolve(cur.seq > 0);
      }, SEGMENT_TIMEOUT_MS);
      this.current = { item, seq: 0, timer, resolve };
      try {
        for (const piece of splitForTts(item.text)) ws.send(JSON.stringify({ type: "text", data: { text: piece } }));
        ws.send(JSON.stringify({ type: "flush" }));
      } catch {
        clearTimeout(timer);
        this.current = null;
        resolve(false);
      }
    });
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let m: { type?: string; data?: { audio?: string; event_type?: string; message?: string } };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const cur = this.current;
    if (!cur) return;
    if (m.type === "audio" && m.data?.audio) {
      this.sink.pcm(cur.item.voiceId, cur.seq++, m.data.audio, config.ttsSampleRate);
    } else if (m.type === "event" && m.data?.event_type === "final") {
      clearTimeout(cur.timer);
      this.current = null;
      cur.resolve(true);
    } else if (m.type === "error") {
      clearTimeout(cur.timer);
      this.current = null;
      // Audio already sent for this item cannot be retracted; only retry if none was sent.
      cur.resolve(cur.seq > 0);
    }
  }

  private async synthRest(item: Item): Promise<boolean> {
    try {
      for (const piece of splitForTts(item.text, 1800)) {
        const res = await fetch(REST_URL, {
          method: "POST",
          headers: { "api-subscription-key": config.sarvamKey, "content-type": "application/json" },
          body: JSON.stringify({
            text: piece,
            target_language_code: this.language,
            speaker: this.speaker,
            model: config.ttsModel,
            pace: this.pace,
            speech_sample_rate: config.ttsSampleRate,
            output_audio_codec: "wav",
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return false;
        const j = (await res.json()) as { audios?: string[] };
        const wav = j.audios?.[0];
        if (!wav) return false;
        if (this.closed) return false;
        this.sink.wav(item.voiceId, wav);
      }
      return true;
    } catch {
      return false;
    }
  }
}
