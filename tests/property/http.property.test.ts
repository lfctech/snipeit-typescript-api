import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fullJitter, parseRetryAfter, SnipeITHttpClient } from "../../src/http.js";

describe("HTTP properties", () => {
  it("full jitter remains inside the requested interval", () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }), (base) => {
      const result = fullJitter(base);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(base);
    }));
    expect(fullJitter(-1)).toBe(0);
  });

  it("numeric Retry-After is always nonnegative milliseconds", () => {
    fc.assert(fc.property(fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }), (seconds) => {
      const result = parseRetryAfter(String(seconds), 0);
      expect(result).toBeDefined();
      expect(result).toBeGreaterThanOrEqual(0);
    }));
  });

  it("rejects arbitrary non-loopback plain HTTP hosts and blank tokens", () => {
    fc.assert(fc.property(fc.domain().filter((host) => !host.startsWith("localhost")), (host) => {
      expect(() => new SnipeITHttpClient({ baseUrl: `http://${host}`, token: "x", fetch: async () => new Response("{}") })).toThrow(TypeError);
    }));
    fc.assert(fc.property(fc.string({ unit: fc.constantFrom(" ", "\t", "\n"), minLength: 1 }), (token) => {
      expect(() => new SnipeITHttpClient({ baseUrl: "https://example.test", token, fetch: async () => new Response("{}") })).toThrow(TypeError);
    }));
  });
});
