interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

class SkillsCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string, ttlSeconds: number): T | null {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > ttlSeconds * 1000) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  }

  set<T>(key: string, data: T): void {
    this.store.set(key, { data, fetchedAt: Date.now() });
  }

  // Layout cache has no TTL — persists for the session
  getLayout(key: string): "flat" | "nested" | null {
    const entry = this.store.get(key) as CacheEntry<"flat" | "nested"> | undefined;
    return entry?.data ?? null;
  }

  setLayout(key: string, layout: "flat" | "nested"): void {
    this.store.set(key, { data: layout, fetchedAt: Date.now() });
  }
}

export const cache = new SkillsCache();
