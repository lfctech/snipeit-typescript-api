import { describe, expect, it } from "vitest";
import { SnipeITResponseError } from "../../src/errors.js";
import { SnipeITHttpClient, type Fetch } from "../../src/http.js";
import {
  ReportsManager, activityActorName, activityItemLabel, activityTimestamp, serializeActivityQuery,
  type ActivityReportQuery, type ActivityRow,
} from "../../src/reports.js";

const manager = (fetch: Fetch): ReportsManager => new ReportsManager(new SnipeITHttpClient({ baseUrl: "https://example.test", token: "token", fetch, retry: { maxRetries: 0 } }));

describe("activity report requests", () => {
  it("requests reports/activity and maps every camelCase key to its Snipe-IT name", async () => {
    let requested = new URL("https://example.test");
    const reports = manager(async (input) => {
      requested = new URL(String(input));
      return Response.json({ total: 0, rows: [] });
    });
    await reports.listActivity({
      limit: 10, offset: 20, search: "laptop", targetType: "App\\Models\\User", targetId: 3,
      itemType: "asset", itemId: 4, actionType: "checkin from", sort: "created_at", order: "asc",
    });
    expect(requested.pathname).toBe("/api/v1/reports/activity");
    expect([...requested.searchParams.entries()]).toEqual([
      ["limit", "10"], ["offset", "20"], ["search", "laptop"], ["target_type", "App\\Models\\User"],
      ["target_id", "3"], ["item_type", "asset"], ["item_id", "4"], ["action_type", "checkin from"],
      ["sort", "created_at"], ["order", "asc"],
    ]);
    expect(reports.path).toBe("reports/activity");
  });

  it("omits undefined/null, forwards empty strings, and never forwards unknown keys", () => {
    expect(serializeActivityQuery()).toEqual({});
    expect(serializeActivityQuery({ limit: undefined, search: undefined } as unknown as ActivityReportQuery)).toEqual({});
    expect(serializeActivityQuery({ search: null, itemId: null } as unknown as ActivityReportQuery)).toEqual({});
    expect(serializeActivityQuery({ search: "", targetType: "" })).toEqual({ search: "", target_type: "" });
    expect(serializeActivityQuery({ search: "  padded  " })).toEqual({ search: "  padded  " });
    expect(serializeActivityQuery({ target_id: 5, unknown: "x", toString: "evil" } as unknown as ActivityReportQuery)).toEqual({});
    expect(serializeActivityQuery({ limit: 0, offset: 0, targetId: 0, itemId: 0 }))
      .toEqual({ limit: 0, offset: 0, target_id: 0, item_id: 0 });
  });

  it("rejects non-integer and negative numeric parameters", () => {
    for (const key of ["limit", "offset", "targetId", "itemId"] as const) {
      for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, "3"]) {
        expect(() => serializeActivityQuery({ [key]: value } as unknown as ActivityReportQuery)).toThrow(RangeError);
        expect(() => serializeActivityQuery({ [key]: value } as unknown as ActivityReportQuery)).toThrow(key);
      }
    }
  });

  it("validates the response shape and preserves extra top-level fields", async () => {
    await expect(manager(async () => Response.json({ total: 2, rows: [{ id: 1 }], custom: "keep" })).listActivity())
      .resolves.toEqual({ total: 2, rows: [{ id: 1 }], custom: "keep" });
    await expect(manager(async () => Response.json({ total: 0 })).listActivity()).resolves.toEqual({ total: 0, rows: [] });
    await expect(manager(async () => Response.json({ rows: null })).listActivity()).resolves.toEqual({ rows: [] });
    await expect(manager(async () => Response.json([])).listActivity()).rejects.toBeInstanceOf(SnipeITResponseError);
    await expect(manager(async () => Response.json(7)).listActivity()).rejects.toThrow(/expected object with 'rows'/u);
    await expect(manager(async () => Response.json({ rows: {} })).listActivity()).rejects.toThrow(/'rows' must be an array/u);
    for (const rows of [[null], ["bad"], [[]], [1]]) {
      await expect(manager(async () => Response.json({ rows })).listActivity()).rejects.toThrow(/every activity row must be an object/u);
    }
    for (const total of [null, "1", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(manager(async () => Response.json({ total, rows: [] })).listActivity()).rejects.toThrow(/'total' must be a non-negative safe integer/u);
    }
  });

  it("forwards caller headers and the abort signal to the request", async () => {
    let seenHeaders = new Headers();
    const reports = manager(async (input, init) => {
      seenHeaders = new Headers(init?.headers);
      if (new URL(String(input)).searchParams.get("search") === "slow") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return Response.json({ rows: [] });
    });
    await reports.listActivity({}, { headers: { "x-trace": "abc" } });
    expect(seenHeaders.get("x-trace")).toBe("abc");

    const controller = new AbortController();
    const reason = new DOMException("caller cancelled", "AbortError");
    const pending = reports.listActivity({ search: "slow" }, { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);

    const aborted = AbortSignal.abort(reason);
    await expect(reports.listActivity({}, { signal: aborted })).rejects.toBe(reason);
  });
});

describe("activity row readers", () => {
  it("prefers machine timestamps over pre-localized display strings", () => {
    expect(activityTimestamp({ created_at: { datetime: "2026-08-12 09:00:00", date: "2026-08-12", formatted: "Wed Aug 12, 2026 9:00AM" } }))
      .toBe("2026-08-12 09:00:00");
    expect(activityTimestamp({ created_at: "2026-08-12T09:00:00Z" })).toBe("2026-08-12T09:00:00Z");
    expect(activityTimestamp({ created_at: { date: "2026-08-12", formatted: "Wed Aug 12, 2026" } })).toBe("2026-08-12");
    expect(activityTimestamp({ created_at: { formatted: "Wed Aug 12, 2026" } })).toBe("Wed Aug 12, 2026");
    expect(activityTimestamp({ created_at: { datetime: null, date: null, formatted: "  " } })).toBeUndefined();
    expect(activityTimestamp({ created_at: null })).toBeUndefined();
    expect(activityTimestamp({ created_at: "   " })).toBeUndefined();
    expect(activityTimestamp({})).toBeUndefined();
    expect(activityTimestamp({ created_at: 1 } as unknown as ActivityRow)).toBeUndefined();
    expect(activityTimestamp({ created_at: [] } as unknown as ActivityRow)).toBeUndefined();
  });

  it("walks the actor fallback chain and never invents a placeholder", () => {
    expect(activityActorName({ user: { name: "Ada" }, created_by: { name: "Bob" }, admin: { name: "Cy" } })).toBe("Ada");
    expect(activityActorName({ created_by: { name: "Bob" }, admin: { name: "Cy" } })).toBe("Bob");
    expect(activityActorName({ admin: { name: "Cy" } })).toBe("Cy");
    expect(activityActorName({ user: { name: "   " }, admin: { name: "Cy" } })).toBe("Cy");
    expect(activityActorName({ user: { first_name: "Ada", last_name: "Lovelace" } })).toBe("Ada Lovelace");
    expect(activityActorName({ user: { first_name: "Ada" } })).toBe("Ada");
    expect(activityActorName({ user: { last_name: "Lovelace" } })).toBe("Lovelace");
    expect(activityActorName({ user: { username: "ada" } })).toBe("ada");
    expect(activityActorName({ user: { name: null, first_name: null, last_name: null, username: null }, created_by: { username: "bob" } })).toBe("bob");
    expect(activityActorName({ user: null, created_by: null, admin: null })).toBeUndefined();
    expect(activityActorName({})).toBeUndefined();
    expect(activityActorName({ user: "bad" } as unknown as ActivityRow)).toBeUndefined();
  });

  it("walks the item label fallback chain", () => {
    expect(activityItemLabel({ item: { name: "Laptop", asset_tag: "A1", serial: "S1" }, target: { name: "Ada" } })).toBe("Laptop");
    expect(activityItemLabel({ item: { asset_tag: "A1", serial: "S1" } })).toBe("A1");
    expect(activityItemLabel({ item: { serial: "S1" } })).toBe("S1");
    expect(activityItemLabel({ item: { name: " ", asset_tag: null, serial: null }, target: { name: "Ada" } })).toBe("Ada");
    expect(activityItemLabel({ target: { name: "Ada" } })).toBe("Ada");
    expect(activityItemLabel({ item: null, target: null })).toBeUndefined();
    expect(activityItemLabel({ item: {}, target: {} })).toBeUndefined();
    expect(activityItemLabel({})).toBeUndefined();
    expect(activityItemLabel({ item: "bad", target: 2 } as unknown as ActivityRow)).toBeUndefined();
  });
});
