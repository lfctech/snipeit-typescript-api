import { SnipeIT, SnipeITNotFoundError, activityActorName, activityItemLabel, activityTimestamp } from "../../dist/index.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const mockFetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/slow")) {
    return new Promise((_resolve, reject) => {
      if (init.signal?.aborted) reject(init.signal.reason);
      else init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  }
  if (url.pathname.endsWith("/missing")) return Response.json({ messages: "missing" }, { status: 404 });
  if (url.pathname.endsWith("/hardware") && init.method === "GET") {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return Response.json({ total: 2, rows: offset === 0 ? [{ id: 1 }] : [{ id: 2 }] });
  }
  if (url.pathname.endsWith("/hardware/1/files") && init.method === "POST") {
    assert(init.body instanceof FormData, "upload did not use FormData");
    assert(init.body.getAll("file[]").length === 1, "upload did not use file[]");
    return Response.json({ status: "success", payload: { uploaded: true } });
  }
  if (url.pathname.endsWith("/hardware/1/files/2") && init.method === "GET") {
    return new Response(encoder.encode("worker-download"), { headers: { "content-length": "15" } });
  }
  if (url.pathname.endsWith("/reports/activity") && init.method === "GET") {
    assert(url.searchParams.get("item_type") === "asset", "activity query was not serialized");
    assert(url.searchParams.get("limit") === "1", "activity limit was not serialized");
    return Response.json({ total: 1, rows: [{ id: 5, created_at: { datetime: "2026-08-12 09:00:00", formatted: "Wed Aug 12" }, user: { name: "Ada" }, item: { name: "Laptop" } }] });
  }
  return Response.json({ ok: true });
};

async function checks() {
  const client = new SnipeIT({ baseUrl: "https://example.test", token: "worker-token", fetch: mockFetch });
  const ping = await client.get("ping");
  assert(ping.ok === true, "request failed");

  const ids = [];
  for await (const asset of client.assets.iterate({ pageSize: 1 })) ids.push(asset.id);
  assert(ids.join(",") === "1,2", "pagination failed");

  const uploaded = await client.assets.uploadFiles(1, [{ name: "worker.txt", data: new Blob(["upload"]) }]);
  assert(uploaded.uploaded === true, "upload failed");

  const download = await client.assets.downloadFile(1, 2);
  assert(decoder.decode(await new Response(download.stream).arrayBuffer()) === "worker-download", "download failed");

  const controller = new AbortController();
  const reason = new DOMException("worker cancellation", "AbortError");
  const pending = client.get("slow", undefined, { signal: controller.signal }).catch((error) => error);
  controller.abort(reason);
  assert(await pending === reason, "caller cancellation was not preserved");

  const missing = await client.get("missing").catch((error) => error);
  assert(missing instanceof SnipeITNotFoundError && missing.status === 404, "structured error failed");

  const activity = await client.reports.listActivity({ limit: 1, itemType: "asset" });
  const row = activity.rows[0];
  assert(activity.total === 1 && row?.id === 5, "activity report failed");
  assert(activityTimestamp(row) === "2026-08-12 09:00:00", "activity timestamp precedence failed");
  assert(activityActorName(row) === "Ada", "activity actor name failed");
  assert(activityItemLabel(row) === "Laptop", "activity item label failed");
  return { import: true, request: true, pagination: true, upload: true, download: true, cancellation: true, errors: true, reports: true };
}

export default {
  async fetch() {
    try { return Response.json({ ok: true, checks: await checks() }); }
    catch (error) { return Response.json({ ok: false, error: error instanceof Error ? error.stack : String(error) }, { status: 500 }); }
  },
};
