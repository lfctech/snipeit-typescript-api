import { describe, expect, it } from "vitest";
import { SnipeITHttpClient, type Fetch } from "../../src/http.js";
import { AssetsManager, serializeAssetListQuery } from "../../src/resources.js";
import type { AssetListQuery } from "../../src/types.js";

const manager = (fetch: Fetch): AssetsManager => new AssetsManager(new SnipeITHttpClient({ baseUrl: "https://example.test", token: "token", fetch, retry: { maxRetries: 0 } }));

describe("typed asset search", () => {
  it("delegates to hardware with every confirmed parameter name", async () => {
    let requested = new URL("https://example.test");
    const assets = manager(async (input) => {
      requested = new URL(String(input));
      return Response.json({ total: 1, rows: [{ id: 1 }] });
    });
    await expect(assets.search({
      limit: 5, offset: 10, search: "mac", sort: "asset_tag", order: "desc", orderNumber: "PO-1", statusId: 2,
      statusType: "Deployed", locationId: 3, categoryId: 4, modelId: 5, manufacturerId: 6, companyId: 7,
      assignedTo: 8, assignedType: "App\\Models\\User",
    })).resolves.toMatchObject({ total: 1, rows: [{ id: 1 }] });
    expect(requested.pathname).toBe("/api/v1/hardware");
    expect([...requested.searchParams.entries()]).toEqual([
      ["limit", "5"], ["offset", "10"], ["search", "mac"], ["sort", "asset_tag"], ["order", "desc"],
      ["order_number", "PO-1"], ["status_id", "2"], ["status", "Deployed"], ["location_id", "3"],
      ["category_id", "4"], ["model_id", "5"], ["manufacturer_id", "6"], ["company_id", "7"],
      ["assigned_to", "8"], ["assigned_type", "App\\Models\\User"],
    ]);
    await expect(assets.search()).resolves.toMatchObject({ rows: [{ id: 1 }] });
  });

  it("omits absent values, ignores unknown keys, and validates integers", () => {
    expect(serializeAssetListQuery()).toEqual({});
    expect(serializeAssetListQuery({ search: undefined, statusId: undefined } as unknown as AssetListQuery)).toEqual({});
    expect(serializeAssetListQuery({ search: null, modelId: null } as unknown as AssetListQuery)).toEqual({});
    expect(serializeAssetListQuery({ status_id: 1, nope: true } as unknown as AssetListQuery)).toEqual({});
    expect(serializeAssetListQuery({ search: "" })).toEqual({ search: "" });
    for (const key of ["limit", "offset", "statusId", "locationId", "categoryId", "modelId", "manufacturerId", "companyId", "assignedTo"] as const) {
      for (const value of [-1, 2.5, "4"]) {
        expect(() => serializeAssetListQuery({ [key]: value } as unknown as AssetListQuery)).toThrow(RangeError);
      }
    }
  });
});

describe("raw label responses", () => {
  it("returns the upstream response with headers and a readable stream", async () => {
    let requestHeaders = new Headers();
    let requestBody = "";
    const assets = manager(async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      requestBody = String(init?.body);
      return new Response("%PDF-stream", { headers: { "content-type": "application/pdf", "content-disposition": "attachment; filename=labels.pdf" } });
    });
    const response = await assets.labelsResponse(["A", { asset_tag: "B" }, " "], { headers: { "x-trace": "abc" } });
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=labels.pdf");
    expect(requestHeaders.get("accept")).toBe("application/pdf, application/json");
    expect(requestHeaders.get("x-trace")).toBe("abc");
    expect(JSON.parse(requestBody)).toEqual({ asset_tags: ["A", "B"] });
    await expect(new Response(response.body).text()).resolves.toBe("%PDF-stream");
    await expect(assets.labelsResponse([])).rejects.toThrow("At least one");
    await expect(assets.labelsResponse([" ", { asset_tag: null }])).rejects.toThrow("No valid");
  });
});
