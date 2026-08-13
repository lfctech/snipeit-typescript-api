import { describe, expect, it } from "vitest";
import { SnipeIT } from "../../src/client.js";
import { ReportsManager } from "../../src/reports.js";
import { ResourceManager, type Managers } from "../../src/resources.js";
import type { Resource } from "../../src/types.js";

const expected = {
  accessories: "accessories",
  assets: "hardware",
  categories: "categories",
  companies: "companies",
  components: "components",
  consumables: "consumables",
  departments: "departments",
  fields: "fields",
  fieldsets: "fieldsets",
  licenses: "licenses",
  locations: "locations",
  manufacturers: "manufacturers",
  models: "models",
  statusLabels: "statuslabels",
  suppliers: "suppliers",
  users: "users",
} as const;

describe("all resource managers", () => {
  it("exposes exactly sixteen managers with complete common CRUD behavior", async () => {
    const collectionPaths = new Set(Object.values(expected).map((path) => `/api/v1/${path}`));
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = new SnipeIT({
      baseUrl: "https://example.test",
      token: "token",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ method, path: url.pathname, body });
        if (method === "DELETE") return new Response(null, { status: 204 });
        if (method === "POST") return Response.json({ status: "success", payload: { id: 2, ...body } });
        if (method === "PATCH") return Response.json({ status: "success", payload: { id: 1, ...body } });
        if (collectionPaths.has(url.pathname)) return Response.json({ total: 1, rows: [{ id: 1, name: "one" }] });
        return Response.json({ id: 1, name: "one" });
      },
    });

    expect(Object.keys(expected)).toHaveLength(16);
    for (const [property, path] of Object.entries(expected)) {
      const manager = client[property as keyof typeof expected] as unknown as ResourceManager<Resource, Record<string, unknown>, Record<string, unknown>>;
      expect(manager.path).toBe(path);
      await expect(manager.list()).resolves.toMatchObject({ total: 1, rows: [{ id: 1 }] });
      await expect(manager.get(1)).resolves.toMatchObject({ id: 1 });
      await expect(manager.create({ name: "new", categoryId: 9 })).resolves.toMatchObject({ id: 2, category_id: 9 });
      await expect(manager.update(1, { name: "changed", parentId: 3 })).resolves.toMatchObject({ id: 1, parent_id: 3 });
      await expect(manager.delete(1)).resolves.toBeUndefined();
    }
    expect(calls).toHaveLength(80);
  });

  it("exposes a read-only reports manager on the client and the Managers contract", async () => {
    const paths: string[] = [];
    const client = new SnipeIT({
      baseUrl: "https://example.test",
      token: "token",
      fetch: async (input) => {
        paths.push(new URL(String(input)).pathname);
        return Response.json({ total: 1, rows: [{ id: 5, action_type: "checkout" }] });
      },
    });
    expect(client.reports).toBeInstanceOf(ReportsManager);
    expect(client.reports).not.toBeInstanceOf(ResourceManager);
    const managers: Pick<Managers, "reports"> = client;
    await expect(managers.reports.listActivity({ limit: 1 })).resolves.toMatchObject({ total: 1, rows: [{ id: 5 }] });
    expect(paths).toEqual(["/api/v1/reports/activity"]);
    const methods = Object.getOwnPropertyNames(ReportsManager.prototype).filter((name) => name !== "constructor");
    expect(methods).toEqual(["listActivity"]);
  });

  it("exposes a safe client identity and raw verb façade", async () => {
    const client = new SnipeIT({ baseUrl: "https://example.test", token: "super-secret", fetch: async () => Response.json({ ok: true }) });
    expect(client.toString()).toBe("SnipeIT(https://example.test, token=***)");
    expect(client.toString()).not.toContain("super-secret");
    await expect(client.get("ping")).resolves.toEqual({ ok: true });
    await expect(client.post("ping", {})).resolves.toEqual({ ok: true });
    await expect(client.put("ping", {})).resolves.toEqual({ ok: true });
    await expect(client.patch("ping", {})).resolves.toEqual({ ok: true });
    await expect(client.delete("ping")).resolves.toEqual({ ok: true });
    await expect(client.request("OPTIONS", "ping")).resolves.toEqual({ ok: true });
    await expect(client.raw("GET", "ping")).resolves.toBeInstanceOf(Response);
  });
});
