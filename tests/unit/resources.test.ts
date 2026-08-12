import { describe, expect, it, vi } from "vitest";
import { SnipeITApiError, SnipeITNotFoundError, SnipeITResponseError, SnipeITStateError } from "../../src/errors.js";
import { SnipeITHttpClient, type Fetch } from "../../src/http.js";
import { AssetsManager } from "../../src/resources.js";
import type { Asset } from "../../src/types.js";

const manager = (fetch: Fetch): AssetsManager => new AssetsManager(new SnipeITHttpClient({ baseUrl: "https://example.test", token: "token", fetch, retry: { maxRetries: 0 } }));

describe("resource shape and pagination behavior", () => {
  it("normalizes missing/null rows and rejects malformed shapes", async () => {
    await expect(manager(async () => Response.json({ total: 0 })).list()).resolves.toMatchObject({ rows: [] });
    await expect(manager(async () => Response.json({ rows: null })).list()).resolves.toMatchObject({ rows: [] });
    await expect(manager(async () => Response.json({ rows: {} })).list()).rejects.toBeInstanceOf(SnipeITResponseError);
    await expect(manager(async () => Response.json([])).list()).rejects.toBeInstanceOf(SnipeITResponseError);
    await expect(manager(async () => Response.json([])).get(1)).rejects.toBeInstanceOf(SnipeITResponseError);
  });

  it("caps pages, stops on total, and rejects caller-controlled offset", async () => {
    const requests: Array<{ limit: number; offset: number }> = [];
    const assets = manager(async (input) => {
      const url = new URL(String(input));
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      requests.push({ limit, offset });
      const all = [{ id: 1 }, { id: 2 }, { id: 3 }];
      return Response.json({ total: 3, rows: all.slice(offset, offset + limit) });
    });
    const found: Asset[] = [];
    for await (const asset of assets.iterate({ limit: 3, pageSize: 2 })) found.push(asset);
    expect(found.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(requests).toEqual([{ limit: 2, offset: 0 }, { limit: 1, offset: 2 }]);
    await expect(async () => { for await (const _item of assets.iterate({ query: { offset: 1 } })) void _item; }).rejects.toThrow("offset");
    await expect(async () => { for await (const _item of assets.iterate({ pageSize: 0 })) void _item; }).rejects.toThrow(RangeError);
  });
});

describe("asset lookup and actions", () => {
  it("supports tag and every serial response shape", async () => {
    await expect(manager(async () => Response.json({ id: 1, asset_tag: "A" })).getByTag("A/B")).resolves.toMatchObject({ id: 1 });
    await expect(manager(async () => Response.json({ id: 2 })).getBySerial("S1")).resolves.toMatchObject({ id: 2 });
    await expect(manager(async () => Response.json({ total: 1, rows: [{ id: 3 }] })).getBySerial("S2")).resolves.toMatchObject({ id: 3 });
    await expect(manager(async () => Response.json({ total: 2, rows: [{}, {}] })).getBySerial("dup")).rejects.toBeInstanceOf(SnipeITApiError);
    await expect(manager(async () => Response.json({ total: 0, rows: [] })).getBySerial("none")).rejects.toBeInstanceOf(SnipeITNotFoundError);
    await expect(manager(async () => Response.json({ rows: [] })).getBySerial("missing-total")).rejects.toBeInstanceOf(SnipeITNotFoundError);
    await expect(manager(async () => Response.json({ unexpected: true })).getBySerial("bad")).rejects.toBeInstanceOf(SnipeITApiError);
  });

  it("adds contextual lookup not-found errors", async () => {
    const notFound: Fetch = async () => Response.json({ messages: "localized" }, { status: 404 });
    await expect(manager(notFound).getByTag("TAG")).rejects.toThrow("TAG");
    await expect(manager(notFound).getBySerial("SERIAL")).rejects.toThrow("SERIAL");
  });

  it("maps checkout targets and refreshes actions by default", async () => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    const assets = manager(async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname, ...(body === undefined ? {} : { body }) });
      return Response.json((init?.method ?? "GET") === "GET" ? { id: 7, name: "fresh" } : { status: "success" });
    });
    await expect(assets.checkout(7, { checkoutToType: "user", assignedToId: 9, note: "x" })).resolves.toMatchObject({ name: "fresh" });
    expect(calls[0]?.body).toEqual({ checkout_to_type: "user", note: "x", assigned_user: 9 });
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    calls.length = 0;
    await assets.checkout(7, { checkoutToType: "asset", assignedToId: 8 }, { refresh: false });
    expect(calls[0]?.body).toMatchObject({ assigned_asset: 8 });
    calls.length = 0;
    await assets.checkout(7, { checkoutToType: "location", assignedToId: 6 }, { refresh: false });
    expect(calls[0]?.body).toMatchObject({ assigned_location: 6 });
    await expect(assets.checkout(7, { checkoutToType: "invalid" as "user", assignedToId: 1 })).rejects.toThrow(TypeError);
  });

  it("covers checkin, audit variants, restore, due/overdue, licenses, and maintenance", async () => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    const assets = manager(async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname, ...(body === undefined ? {} : { body }) });
      if (new URL(String(input)).pathname.endsWith("maintenances")) return Response.json({ status: "success", payload: { id: 44 } });
      return Response.json({ id: 1 });
    });
    await assets.checkin(1, { note: "ok" }, { refresh: false });
    await assets.audit(1, {}, { refresh: false });
    await assets.auditById(1, { locationId: 2 });
    await assets.restore(1, { refresh: false });
    await assets.listAuditDue();
    await assets.listAuditOverdue();
    await assets.getLicenses(1);
    await expect(assets.createMaintenance(1, {
      assetMaintenanceType: "Repair", name: "Fix", startDate: "2026-08-12", supplierId: 2,
    })).resolves.toEqual({ id: 44 });
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /api/v1/hardware/1/checkin", "POST /api/v1/hardware/1/audit", "POST /api/v1/hardware/1/audit",
      "POST /api/v1/hardware/1/restore", "GET /api/v1/hardware/audit/due", "GET /api/v1/hardware/audit/overdue",
      "GET /api/v1/hardware/1/licenses", "POST /api/v1/maintenances",
    ]);
    expect(calls.at(-1)?.body).toEqual({
      asset_maintenance_type: "Repair", name: "Fix", start_date: "2026-08-12", supplier_id: 2, asset_id: 1,
    });
  });

  it("omits a blank asset tag for server auto-increment", async () => {
    let body: Record<string, unknown> = {};
    const assets = manager(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ status: "success", payload: { id: 1 } });
    });
    await assets.create({ statusId: 1, modelId: 2, assetTag: "" });
    expect(body).toEqual({ status_id: 1, model_id: 2 });
  });
});

describe("asset custom fields", () => {
  const source: Asset = {
    id: 1,
    name: "Laptop",
    custom_fields: {
      Owner: { field: "_snipeit_owner_1", value: "alice", element: "text" },
      Cost: { field: "_snipeit_cost_2", value: 10 },
    },
  };

  it("reads by label with a default and validates state", async () => {
    const assets = manager(async () => Response.json({}));
    expect(assets.getCustomField(source, "Owner")).toBe("alice");
    expect(assets.getCustomField(source, "Missing", "fallback")).toBe("fallback");
    expect(assets.getCustomField({ id: 1 }, "Missing", null)).toBeNull();
    await expect(assets.updateCustomFields({ ...source, id: null }, { Owner: "bob" })).rejects.toBeInstanceOf(SnipeITStateError);
    await expect(assets.updateCustomFields({ id: 1 }, { Owner: "bob" })).rejects.toBeInstanceOf(SnipeITStateError);
    await expect(assets.updateCustomFields(source, { Unknown: "x" })).rejects.toThrow("Available labels");
  });

  it("writes top-level columns and reconciles null/echoed responses repeatedly", async () => {
    const bodies: Record<string, unknown>[] = [];
    let current = "bob";
    const assets = manager(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const response = { status: "success", payload: { id: 1, custom_fields: null, _snipeit_owner_1: current, _snipeit_stray_9: "noise" } };
      current = "carol";
      return Response.json(response);
    });
    const once = await assets.updateCustomFields(source, { Owner: "bob", Cost: 10 });
    expect(bodies[0]).toEqual({ _snipeit_owner_1: "bob" });
    expect(once.custom_fields?.["Owner"]).toMatchObject({ value: "bob", field: "_snipeit_owner_1" });
    expect(once).not.toHaveProperty("_snipeit_owner_1");
    expect(once).not.toHaveProperty("_snipeit_stray_9");
    const twice = await assets.updateCustomFields(once, { Owner: "carol" });
    expect(bodies[1]).toEqual({ _snipeit_owner_1: "carol" });
    expect(twice.custom_fields?.["Owner"]).toMatchObject({ value: "carol" });
    expect(source.custom_fields?.["Owner"]).toMatchObject({ value: "alice" });
  });

  it("does no request for unchanged custom fields", async () => {
    const fetch = vi.fn<Fetch>();
    await expect(manager(fetch).updateCustomFields(source, { Owner: "alice" })).resolves.not.toBe(source);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("asset files and labels", () => {
  it("lists, uploads multipart with notes, and deletes using the Snipe-IT suffix", async () => {
    const calls: Array<{ method: string; path: string; body: BodyInit | null | undefined }> = [];
    const assets = manager(async (input, init) => {
      calls.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname, body: init?.body });
      return Response.json({ status: "success", payload: { ok: true } });
    });
    await assets.listFiles(1);
    await expect(assets.uploadFiles(1, [{ name: "note.txt", data: new Blob(["abc"], { type: "text/plain" }) }], "memo")).resolves.toEqual({ ok: true });
    const form = calls[1]?.body as FormData;
    expect(form.get("notes")).toBe("memo");
    expect((form.get("file[]") as File).name).toBe("note.txt");
    await assets.deleteFile(1, 2);
    expect(calls[2]?.path).toBe("/api/v1/hardware/1/files/2/delete");
    await expect(assets.uploadFiles(1, [])).rejects.toThrow("At least one");
  });

  it("streams downloads and reports progress with and without length", async () => {
    const progress = vi.fn();
    const assets = manager(async () => new Response("abcdef", { headers: { "content-length": "6", "content-type": "text/plain", "content-disposition": "attachment; filename=note.txt" } }));
    const download = await assets.downloadFile(1, 2, { progress });
    await expect(new Response(download.stream).text()).resolves.toBe("abcdef");
    expect(progress).toHaveBeenLastCalledWith(6, 6);
    expect(download).toMatchObject({ contentLength: 6, contentType: "text/plain", filename: "note.txt" });
    await expect(manager(async () => new Response(null)).downloadFile(1, 2)).rejects.toBeInstanceOf(SnipeITResponseError);
  });

  it("accepts direct PDF or JSON/base64 labels and rejects invalid payloads", async () => {
    let requestHeaders = new Headers();
    let requestBody = "";
    const assets = manager(async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      requestBody = String(init?.body);
      return Response.json({ status: "success", payload: { pdf: globalThis.btoa("%PDF") } });
    });
    const blob = await assets.labels(["A", { asset_tag: "B" }, " "]);
    expect(await blob.text()).toBe("%PDF");
    expect(blob.type).toBe("application/pdf");
    expect(requestHeaders.get("accept")).toBe("application/pdf, application/json");
    expect(JSON.parse(requestBody)).toEqual({ asset_tags: ["A", "B"] });
    const direct = manager(async () => new Response("%PDF-direct", { headers: { "content-type": "application/pdf" } }));
    await expect((await direct.labels(["A"])).text()).resolves.toBe("%PDF-direct");
    await expect(assets.labels([])).rejects.toThrow("At least one");
    await expect(assets.labels([" ", { asset_tag: null }])).rejects.toThrow("No valid");
    await expect(manager(async () => Response.json({ status: "success", payload: {} })).labels(["A"]))
      .rejects.toBeInstanceOf(SnipeITResponseError);
    await expect(manager(async () => Response.json({ status: "success", payload: { pdf: "%%%" } })).labels(["A"]))
      .rejects.toThrow("Invalid base64");
  });
});

describe("user and accessory special actions", () => {
  it("hits users/me and unwraps accessory checkin payload", async () => {
    const paths: string[] = [];
    const http = new SnipeITHttpClient({ baseUrl: "https://example.test", token: "token", fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return Response.json(path.endsWith("checkin") ? { status: "success", payload: { checkedIn: true } } : { id: 9, username: "me" });
    } });
    const { AccessoriesManager, UsersManager } = await import("../../src/resources.js");
    await expect(new UsersManager(http).me()).resolves.toMatchObject({ username: "me" });
    await expect(new AccessoriesManager(http).checkinFromUser(4)).resolves.toEqual({ checkedIn: true });
    expect(paths).toEqual(["/api/v1/users/me", "/api/v1/accessories/4/checkin"]);
  });
});


describe("audited Snipe-IT response-shape regressions", () => {
  it("uses a non-null nested custom_fields PATCH response as authoritative", async () => {
    const original: Asset = {
      id: 1,
      custom_fields: { Owner: { field: "_snipeit_owner_1", value: "old" } },
    };
    const assets = manager(async () => Response.json({
      status: "success",
      payload: {
        id: 1,
        custom_fields: {
          Owner: { field: "_snipeit_owner_1", value: "server-normalized" },
          NewField: { field: "_snipeit_new_2", value: "new" },
        },
        _snipeit_owner_1: "top-level-conflict",
      },
    }));
    const updated = await assets.updateCustomFields(original, { Owner: "requested" });
    expect(updated.custom_fields?.["Owner"]).toMatchObject({ value: "server-normalized" });
    expect(updated.custom_fields?.["NewField"]).toMatchObject({ value: "new" });
    expect(original.custom_fields?.["Owner"]).toMatchObject({ value: "old" });
  });

  it("accepts an authoritative empty custom-field map and rejects malformed non-null values", async () => {
    const original: Asset = { id: 1, custom_fields: { Owner: { field: "_snipeit_owner_1", value: "old" } } };
    const empty = manager(async () => Response.json({ status: "success", payload: { id: 1, custom_fields: {} } }));
    await expect(empty.updateCustomFields(original, { Owner: "new" })).resolves.toMatchObject({ custom_fields: {} });
    const malformed = manager(async () => Response.json({ status: "success", payload: { id: 1, custom_fields: "bad" } }));
    await expect(malformed.updateCustomFields(original, { Owner: "new" })).rejects.toBeInstanceOf(SnipeITResponseError);
  });

  it.each([
    { total: 1, rows: { id: 7 } },
    { total: "1", rows: [{ id: 7 }] },
    { total: -1, rows: [] },
    { total: 1, rows: ["bad"] },
  ])("classifies malformed byserial envelopes as response errors: %j", async (response) => {
    await expect(manager(async () => Response.json(response)).getBySerial("SER"))
      .rejects.toBeInstanceOf(SnipeITResponseError);
  });
});
