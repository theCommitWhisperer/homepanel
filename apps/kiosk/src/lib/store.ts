import type { DataKey } from "@homepanel/protocol";

type Listener = () => void;

/** Latest value per data key. Listeners are per key so a widget only re-renders for its own keys. */
export class DataStore {
  private values = new Map<DataKey, unknown>();
  private stamps = new Map<DataKey, number>();
  private listeners = new Map<DataKey, Set<Listener>>();
  private anyListeners = new Set<Listener>();

  get<T = unknown>(key: DataKey): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  ts(key: DataKey): number | undefined {
    return this.stamps.get(key);
  }

  set(key: DataKey, value: unknown, ts = Date.now()) {
    this.values.set(key, value);
    this.stamps.set(key, ts);
    this.listeners.get(key)?.forEach((l) => l());
    this.anyListeners.forEach((l) => l());
  }

  /** Drop everything (e.g. on unauthorized) and notify listeners. */
  clear() {
    const keys = Array.from(this.values.keys());
    this.values.clear();
    this.stamps.clear();
    keys.forEach((k) => this.listeners.get(k)?.forEach((l) => l()));
    this.anyListeners.forEach((l) => l());
  }

  subscribe(key: DataKey, listener: Listener): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(key);
    };
  }

  subscribeAll(listener: Listener): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  listenerCount(key: DataKey) {
    return this.listeners.get(key)?.size ?? 0;
  }
}

/** Rolling numeric history (for sparklines), kept client-side. */
export class History {
  private series = new Map<string, { t: number; v: number }[]>();
  constructor(private windowMs = 10 * 60_000) {}

  /** Record a sample unless the previous one is newer than minIntervalMs. Returns true when recorded. */
  push(id: string, v: number, t = Date.now(), minIntervalMs = 0): boolean {
    let arr = this.series.get(id);
    if (!arr) this.series.set(id, (arr = []));
    const last = arr[arr.length - 1];
    if (last && t - last.t < minIntervalMs) return false;
    arr.push({ t, v });
    const cutoff = t - this.windowMs;
    while (arr.length && arr[0].t < cutoff) arr.shift();
    return true;
  }

  get(id: string): { t: number; v: number }[] {
    return this.series.get(id) ?? [];
  }
}

/**
 * Pick a grid for n tiles inside a w×h box. Prefers big, not-too-stretched tiles. Tiles never get
 * smaller than minW×minH; when they can't all fit, `scroll` is true and rows get a fixed minH height.
 */
export function fitGrid(n: number, w: number, h: number, minW = 0, minH = 0): { cols: number; rows: number; scroll: boolean } {
  if (n <= 0) return { cols: 1, rows: 1, scroll: false };
  if (w <= 0 || h <= 0) {
    const c = Math.ceil(Math.sqrt(n));
    return { cols: c, rows: Math.ceil(n / c), scroll: false };
  }
  let best: { cols: number; rows: number; score: number } | null = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = w / cols;
    const ch = h / rows;
    if (cw < minW || ch < minH) continue;
    const side = Math.min(cw, ch);
    const aspect = Math.max(cw, ch) / Math.max(1, Math.min(cw, ch));
    const empty = cols * rows - n;
    const score = side - Math.max(0, aspect - 2.2) * side * 0.25 - empty * side * 0.08;
    if (!best || score > best.score) best = { cols, rows, score };
  }
  if (best) return { cols: best.cols, rows: best.rows, scroll: false };
  const cols = Math.max(1, Math.min(n, Math.floor(w / Math.max(1, minW))));
  return { cols, rows: Math.ceil(n / cols), scroll: Math.ceil(n / cols) * minH > h };
}
