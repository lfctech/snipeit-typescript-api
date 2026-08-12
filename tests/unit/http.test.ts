import { describe, expect, it, vi } from "vitest";
import {
  SnipeITApiError, SnipeITAuthenticationError, SnipeITClientError, SnipeITConnectionError,
  SnipeITNotFoundError, SnipeITResponseError, SnipeITServerError, SnipeITTimeoutError,
  SnipeITValidationError,
} from "../../src/errors.js";
import { parseRetryAfter, redactHeaders, SnipeITHttpClient, type Fetch } from "../../src/http.js";

const json = (value: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
  ...init,
});
const make = (fetch: Fetch, extra: Partial<ConstructorParameters<typeof SnipeITHttpClient>[0]> = {}): SnipeITHttpClient =>
  new SnipeITHttpClient({ baseUrl: "https://snipe.example.test", token: "secret-token", fetch, ...extra });

describe("SnipeITHttpClient", () => {
  it("validates origins and tokens and exposes safe defaults", () => {
    for (const baseUrl of ["http://example.test", "https://u:p@example.test", "https://example.test/x", "https://example.test/?x=1", "ftp://example.test"]) {
      expect(() => new SnipeITHttpClient({ baseUrl, token: "x", fetch: async () => json({}) })).toThrow(TypeError);
    }
    for (const baseUrl of ["https://example.test/", "http://localhost:8080", "http://127.0.0.1", "http://[::1]:3000"]) {
      expect(new SnipeITHttpClient({ baseUrl, token: "x", fetch: async () => json({}) }).baseUrl).toMatch(/^http/);
    }
    expect(() => new SnipeITHttpClient({ baseUrl: "https://example.test", token: "  ", fetch: async () => json({}) })).toThrow("token must be non-empty");
    const client = make(async () => json({}));
    expect(client.timeoutMs).toBe(10_000);
    expect(client.toString()).toBe("SnipeITHttpClient(https://snipe.example.test, token=***)");
    expect(client.toString()).not.toContain("secret-token");
  });

  it("builds API URLs, serializes query/JSON and enforces auth", async () => {
    const fetch = vi.fn<Fetch>(async (input, init) => {
      expect(String(input)).toBe("https://snipe.example.test/api/v1/hardware?limit=2&tag=a&tag=b&empty=");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer secret-token");
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-test")).toBe("yes");
      expect(init?.body).toBe('{"name":"asset"}');
      expect(init?.redirect).toBe("manual");
      return json({ id: 1 });
    });
    await expect(make(fetch).request("POST", "hardware", {
      query: { limit: 2, tag: ["a", "b"], skipped: undefined, empty: null },
      headers: { "x-test": "yes", authorization: "attacker" },
      json: { name: "asset" },
    })).resolves.toEqual({ id: 1 });
    expect(fetch).toHaveBeenCalledOnce();
    await expect(make(fetch).get("https://evil.test/api/v1/hardware")).rejects.toThrow("different origin");
  });

  it("returns raw binary responses without consuming them", async () => {
    const response = new Response("pdf", { headers: { "content-type": "application/pdf" } });
    const result = await make(async () => response).raw("GET", "hardware/labels");
    expect(result).toBeInstanceOf(Response);
    expect(result.headers.get("content-type")).toBe("application/pdf");
    await expect(result.text()).resolves.toBe("pdf");
  });

  it.each([
    [401, SnipeITAuthenticationError],
    [404, SnipeITNotFoundError],
    [409, SnipeITClientError],
    [500, SnipeITServerError],
  ] as const)("maps HTTP %i and stringifies list messages", async (status, ErrorClass) => {
    const error = await make(async () => json({ messages: ["first", "second"] }, { status }), { retry: { maxRetries: 0 } })
      .get("hardware").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error).toMatchObject({ message: "first; second", status, metadata: { method: "GET", path: "/api/v1/hardware", status } });
    expect(error).not.toHaveProperty("response");
  });

  it("extracts validation details and handles map/null/non-JSON errors", async () => {
    const validation = await make(async () => json({ messages: { name: "required" }, errors: { name: ["required"] } }, { status: 422 }), { retry: { maxRetries: 0 } })
      .post("hardware", {}).catch((caught: unknown) => caught);
    expect(validation).toBeInstanceOf(SnipeITValidationError);
    expect(validation).toMatchObject({ message: "name: required", errors: { name: ["required"] } });
    const nullMessage = await make(async () => json({ messages: null }, { status: 400 }), { retry: { maxRetries: 0 } }).get("x").catch((e: unknown) => e);
    expect(nullMessage).toMatchObject({ message: "" });
    const text = await make(async () => new Response("plain failure", { status: 400 }), { retry: { maxRetries: 0 } }).get("x").catch((e: unknown) => e);
    expect(text).toMatchObject({ message: "plain failure" });
  });

  it("rejects redirects, API error envelopes, malformed and empty JSON", async () => {
    const redirect = await make(async () => new Response(null, { status: 302, headers: { location: "https://login.test/?token=x" } }), { retry: { maxRetries: 0 } })
      .get("hardware").catch((e: unknown) => e);
    expect(redirect).toBeInstanceOf(SnipeITApiError);
    expect(String(redirect)).toContain("Unexpected redirect");
    await expect(make(async () => json({ status: "error", messages: "bad" })).get("hardware")).rejects.toBeInstanceOf(SnipeITApiError);
    await expect(make(async () => new Response("not-json")).get("hardware")).rejects.toBeInstanceOf(SnipeITResponseError);
    await expect(make(async () => new Response(null, { status: 204 })).get("hardware")).rejects.toBeInstanceOf(SnipeITResponseError);
    await expect(make(async () => new Response(null, { status: 204 })).delete("hardware/1")).resolves.toBeUndefined();
    await expect(make(async () => new Response(null)).request("GET", "hardware", { allowEmpty: true })).resolves.toBeUndefined();
  });

  it("retries safe methods on statuses and connection errors", async () => {
    let statusCalls = 0;
    const statusFetch = vi.fn<Fetch>(async () => ++statusCalls < 3 ? new Response(null, { status: 503 }) : json({ ok: true }));
    await expect(make(statusFetch, { retry: { maxRetries: 2, jitter: () => 0 } }).get("hardware")).resolves.toEqual({ ok: true });
    expect(statusFetch).toHaveBeenCalledTimes(3);

    const connectionFetch = vi.fn<Fetch>(async () => { throw new TypeError("down"); });
    await expect(make(connectionFetch, { retry: { maxRetries: 2, jitter: () => 0 } }).get("hardware")).rejects.toBeInstanceOf(SnipeITConnectionError);
    expect(connectionFetch).toHaveBeenCalledTimes(3);

    let readCalls = 0;
    const readFetch = vi.fn<Fetch>(async () => {
      readCalls += 1;
      if (readCalls === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("reset after headers")); } }));
      return json({ ok: true });
    });
    await expect(make(readFetch, { retry: { maxRetries: 1, jitter: () => 0 } }).get("hardware")).resolves.toEqual({ ok: true });
    expect(readFetch).toHaveBeenCalledTimes(2);

    let mixedCalls = 0;
    const mixedFetch = vi.fn<Fetch>(async () => {
      mixedCalls += 1;
      if (mixedCalls === 1) return new Response(null, { status: 503 });
      if (mixedCalls === 2) return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("reset after retry")); } }));
      return json({ shouldNotBeReached: true });
    });
    await expect(make(mixedFetch, { retry: { maxRetries: 1, jitter: () => 0 } }).get("hardware"))
      .rejects.toBeInstanceOf(SnipeITConnectionError);
    expect(mixedFetch).toHaveBeenCalledTimes(2);

    const mutationReadFetch = vi.fn<Fetch>(async () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("reset")); } })));
    await expect(make(mutationReadFetch, { retry: { maxRetries: 1, jitter: () => 0 } }).post("hardware", {}))
      .rejects.toBeInstanceOf(SnipeITConnectionError);
    expect(mutationReadFetch).toHaveBeenCalledOnce();
  });

  it("does not retry mutation unless enabled and only replays safe bodies", async () => {
    const failing = vi.fn<Fetch>(async () => new Response(null, { status: 503 }));
    const http = make(failing, { retry: { maxRetries: 2, jitter: () => 0 } });
    await expect(http.post("hardware", { x: 1 })).rejects.toBeInstanceOf(SnipeITServerError);
    expect(failing).toHaveBeenCalledOnce();
    failing.mockClear();
    await expect(http.post("hardware", { x: 1 }, { retry: true })).rejects.toBeInstanceOf(SnipeITServerError);
    expect(failing).toHaveBeenCalledTimes(3);

    const disconnect = vi.fn<Fetch>(async () => { throw new TypeError("down"); });
    const streamHttp = make(disconnect, { retry: { maxRetries: 1, jitter: () => 0 } });
    await expect(streamHttp.raw("POST", "files", { body: new ReadableStream(), retry: true })).rejects.toBeInstanceOf(SnipeITConnectionError);
    expect(disconnect).toHaveBeenCalledOnce();
    disconnect.mockClear();
    await expect(streamHttp.raw("POST", "files", { bodyFactory: () => new ReadableStream(), retry: true })).rejects.toBeInstanceOf(SnipeITConnectionError);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("preserves caller cancellation and distinguishes timeouts", async () => {
    const pending: Fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    const controller = new AbortController();
    const reason = new DOMException("stop", "AbortError");
    const cancelled = make(pending).get("hardware", undefined, { signal: controller.signal });
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    await expect(make(pending, { timeoutMs: 2 }).get("hardware")).rejects.toBeInstanceOf(SnipeITTimeoutError);
  });

  it("logs safe metadata only and validates request options", async () => {
    const logs: unknown[] = [];
    const client = make(async () => json({ ok: true }), { logger: { debug: (message, metadata) => logs.push({ message, metadata }) } });
    await client.request("POST", "hardware", { query: { secret: "query-secret" }, headers: { cookie: "header-secret" }, json: { password: "body-secret" } });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("body-secret");
    await expect(client.request("POST", "x", { json: {}, body: "x" })).rejects.toThrow("only one");
    expect(() => make(async () => json({}), { retry: { maxRetries: -1 } })).toThrow(RangeError);
  });
});

describe("HTTP helpers", () => {
  it("parses Retry-After and redacts sensitive headers", () => {
    expect(parseRetryAfter("1.5", 0)).toBe(1500);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:02 GMT", 1000)).toBe(1000);
    expect(parseRetryAfter("invalid")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(redactHeaders({ Authorization: "token", Cookie: "x", "X-Test": "ok" })).toEqual({ authorization: "***", cookie: "***", "x-test": "ok" });
  });
});


describe("audited HTTP lifecycle and secret safety", () => {
  it("does not expose the bearer token through keys, declarations, or JSON serialization", () => {
    const http = make(async () => json({ ok: true }));
    expect(Object.keys(http)).not.toContain("token");
    expect(JSON.stringify(http)).not.toContain("secret-token");
    expect(JSON.stringify({ http })).not.toContain("secret-token");
  });

  it("strips credentials, paths, queries, and fragments from redirect metadata", async () => {
    const error = await make(async () => new Response(null, {
      status: 302,
      headers: { location: "https://user:password@login.test/callback/REDIRECT-SECRET?token=REDIRECT-SECRET#REDIRECT-SECRET" },
    }), { retry: { maxRetries: 0 } }).get("hardware").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SnipeITApiError);
    expect(String(error)).not.toContain("REDIRECT-SECRET");
    expect(JSON.stringify((error as SnipeITApiError).metadata)).not.toContain("REDIRECT-SECRET");
    expect((error as SnipeITApiError).metadata.location).toBe("https://login.test");
  });

  it("keeps timeout active after headers while consuming JSON", async () => {
    const hanging = new ReadableStream<Uint8Array>({ start() { /* headers only */ } });
    await expect(make(async () => new Response(hanging), { timeoutMs: 5 }).get("hardware"))
      .rejects.toBeInstanceOf(SnipeITTimeoutError);
  });

  it("preserves caller cancellation after headers and during body consumption", async () => {
    const controller = new AbortController();
    const reason = new DOMException("stop after headers", "AbortError");
    const hanging = new ReadableStream<Uint8Array>({ start() { /* headers only */ } });
    const pending = make(async () => new Response(hanging)).get("hardware", undefined, { signal: controller.signal });
    await Promise.resolve();
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
