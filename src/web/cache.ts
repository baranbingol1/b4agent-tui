/**
 * LRU with a time-to-live and a byte cap (hardening point 10). Only
 * successful results go in; callers never cache errors.
 */
export class TtlLru<V> {
  private map = new Map<string, { value: V; bytes: number; expires: number }>();
  private total = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxBytes: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() > hit.expires) {
      this.delete(key);
      return undefined;
    }
    // Re-insert to mark it most recently used.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, bytes: number): void {
    this.delete(key);
    if (bytes > this.maxBytes) return;
    this.map.set(key, { value, bytes, expires: this.now() + this.ttlMs });
    this.total += bytes;
    for (const k of this.map.keys()) {
      if (this.total <= this.maxBytes) break;
      this.delete(k);
    }
  }

  delete(key: string): void {
    const hit = this.map.get(key);
    if (!hit) return;
    this.total -= hit.bytes;
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.total;
  }
}
