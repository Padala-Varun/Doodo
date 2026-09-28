/**
 * Pausable lesson clock. Animations and timeline waits read time from here, so
 * pausing the lesson freezes drawing exactly where it is (audio is paused
 * separately via the AudioContext).
 */
export class LessonClock {
  private pausedAt: number | null = null;
  private offset = 0;
  private waiters = new Set<() => void>();
  /** Aborts all pending sleeps (interrupt). */
  private generation = 0;

  now(): number {
    const t = this.pausedAt ?? performance.now();
    return t - this.offset;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  pause(): void {
    if (this.pausedAt === null) this.pausedAt = performance.now();
  }

  resume(): void {
    if (this.pausedAt !== null) {
      this.offset += performance.now() - this.pausedAt;
      this.pausedAt = null;
      for (const w of [...this.waiters]) w();
    }
  }

  /** Cancel every pending sleep/frame wait (they reject with Interrupted). */
  interrupt(): void {
    this.generation++;
    for (const w of [...this.waiters]) w();
  }

  get gen(): number {
    return this.generation;
  }

  /** Sleep `ms` of lesson time (pause-aware). */
  sleep(ms: number): Promise<void> {
    const gen = this.generation;
    const until = this.now() + ms;
    return new Promise((resolve, reject) => {
      const check = () => {
        if (gen !== this.generation) {
          cleanup();
          reject(new Interrupted());
          return;
        }
        if (this.paused) return; // woken again on resume
        const left = until - this.now();
        if (left <= 0) {
          cleanup();
          resolve();
        } else {
          clearTimeout(timer);
          timer = setTimeout(check, Math.min(left, 250));
        }
      };
      let timer: ReturnType<typeof setTimeout> = setTimeout(check, 0);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      this.waiters.add(check);
    });
  }

  /** Next animation frame that is not paused; rejects on interrupt. */
  frame(): Promise<number> {
    const gen = this.generation;
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (gen !== this.generation) {
          this.waiters.delete(wake);
          reject(new Interrupted());
          return;
        }
        if (this.paused) return; // resumed via wake
        this.waiters.delete(wake);
        resolve(this.now());
      };
      const wake = () => requestAnimationFrame(tick);
      this.waiters.add(wake);
      requestAnimationFrame(tick);
    });
  }

  /** Wait for a promise, but reject promptly on interrupt. */
  race<T>(p: Promise<T>): Promise<T> {
    const gen = this.generation;
    return new Promise<T>((resolve, reject) => {
      const wake = () => {
        if (gen !== this.generation) {
          this.waiters.delete(wake);
          reject(new Interrupted());
        }
      };
      this.waiters.add(wake);
      p.then(
        (v) => {
          this.waiters.delete(wake);
          resolve(v);
        },
        (e) => {
          this.waiters.delete(wake);
          reject(e);
        },
      );
    });
  }
}

export class Interrupted extends Error {
  constructor() {
    super("interrupted");
    this.name = "Interrupted";
  }
}
