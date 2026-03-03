import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsCache } from "./cache";

describe("SkillsCache", () => {
  let cache: SkillsCache;

  beforeEach(() => {
    cache = new SkillsCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("get / set", () => {
    it("returns null for missing key", () => {
      expect(cache.get("missing", 60)).toBeNull();
    });

    it("returns stored data within TTL", () => {
      cache.set("key", { foo: "bar" });
      expect(cache.get("key", 60)).toEqual({ foo: "bar" });
    });

    it("returns null when TTL has expired", () => {
      cache.set("key", "hello");
      vi.advanceTimersByTime(61_000);
      expect(cache.get("key", 60)).toBeNull();
    });

    it("evicts the entry on expiry", () => {
      cache.set("key", "hello");
      vi.advanceTimersByTime(61_000);
      cache.get("key", 60); // triggers eviction
      // After eviction, a fresh get with a longer TTL also returns null
      expect(cache.get("key", 3600)).toBeNull();
    });

    it("returns data exactly at the TTL boundary (not yet expired)", () => {
      cache.set("key", 42);
      vi.advanceTimersByTime(60_000); // exactly 60 s — not > 60 s, so still valid
      expect(cache.get("key", 60)).toBe(42);
    });

    it("overwrites an existing entry", () => {
      cache.set("key", "first");
      cache.set("key", "second");
      expect(cache.get("key", 60)).toBe("second");
    });

    it("handles multiple independent keys", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      expect(cache.get("a", 60)).toBe(1);
      expect(cache.get("b", 60)).toBe(2);
    });
  });

  describe("getLayout / setLayout", () => {
    it("returns null for missing layout key", () => {
      expect(cache.getLayout("missing")).toBeNull();
    });

    it("returns stored flat layout", () => {
      cache.setLayout("repo", "flat");
      expect(cache.getLayout("repo")).toBe("flat");
    });

    it("returns stored nested layout", () => {
      cache.setLayout("repo", "nested");
      expect(cache.getLayout("repo")).toBe("nested");
    });

    it("layout persists regardless of time passing", () => {
      cache.setLayout("repo", "flat");
      vi.advanceTimersByTime(999_999_999);
      // getLayout has no TTL check — should still return the value
      expect(cache.getLayout("repo")).toBe("flat");
    });

    it("overwrites an existing layout", () => {
      cache.setLayout("repo", "flat");
      cache.setLayout("repo", "nested");
      expect(cache.getLayout("repo")).toBe("nested");
    });
  });
});
