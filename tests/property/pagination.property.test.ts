import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { SnipeITHttpClient, type Fetch } from "../../src/http.js";
import { AssetsManager } from "../../src/resources.js";

describe("pagination properties", () => {
  it("yields ordered unique items, respects limits, and never over-fetches", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 1, max: 25 }),
      fc.option(fc.integer({ min: 0, max: 120 }), { nil: undefined }),
      async (total, pageSize, requestedLimit) => {
        const calls: Array<{ offset: number; limit: number }> = [];
        const fetch: Fetch = async (input) => {
          const url = new URL(String(input));
          const offset = Number(url.searchParams.get("offset"));
          const limit = Number(url.searchParams.get("limit"));
          calls.push({ offset, limit });
          const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => ({ id: offset + index }));
          return Response.json({ total, rows });
        };
        const assets = new AssetsManager(new SnipeITHttpClient({ baseUrl: "https://example.test", token: "x", fetch }));
        const found: number[] = [];
        const options = requestedLimit === undefined ? { pageSize } : { pageSize, limit: requestedLimit };
        for await (const item of assets.iterate(options)) found.push(Number(item.id));
        const expectedCount = Math.min(total, requestedLimit ?? total);
        expect(found).toEqual(Array.from({ length: expectedCount }, (_, index) => index));
        expect(new Set(found).size).toBe(found.length);
        for (const call of calls) {
          expect(call.offset).toBeLessThanOrEqual(expectedCount);
          expect(call.limit).toBeLessThanOrEqual(pageSize);
          if (requestedLimit !== undefined) expect(call.limit).toBeLessThanOrEqual(requestedLimit - call.offset);
        }
      },
    ), { numRuns: 100 });
  });

  it("limit zero makes no request", async () => {
    const fetch = vi.fn<Fetch>();
    const assets = new AssetsManager(new SnipeITHttpClient({ baseUrl: "https://example.test", token: "x", fetch }));
    for await (const item of assets.iterate({ limit: 0 })) void item;
    expect(fetch).not.toHaveBeenCalled();
  });
});
