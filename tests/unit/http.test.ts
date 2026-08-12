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

function reachableText(value: unknown, seen = new Set<object>()): string {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return String(value);
  if (seen.has(value)) return "<cycle>";
  seen.add(value);
  return Reflect.ownKeys(value).map((key) => {
    let nested: unknown;
    try { nested = (value as Record<PropertyKey, unknown>)[key]; }
    catch { nested = "<unreadable>"; }
    return `${String(key)}:${reachableText(nested, seen)}`;
  }).join("|");
}

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

  it("enforces one body source and supports native ReadableStream requests", async () => {
    const fetch = vi.fn<Fetch>(async (input, init) => {
      expect((init as RequestInit & { duplex?: string } | undefined)?.duplex).toBe("half");
      const request = new Request(input, init);
      await expect(request.text()).resolves.toBe("stream-body");
      return json({ ok: true });
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("stream-body"));
        controller.close();
      },
    });
    await expect(make(fetch).request("POST", "hardware", { body: stream })).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledOnce();

    const unusedFetch = vi.fn<Fetch>(async () => json({ ok: true }));
    const client = make(unusedFetch);
    await expect(client.raw("POST", "hardware", { body: "static", bodyFactory: () => "factory" }))
      .rejects.toThrow("only one");
    await expect(client.raw("POST", "hardware", { json: {}, bodyFactory: () => "factory" }))
      .rejects.toThrow("only one");
    await expect(client.raw("GET", "hardware", { body: "body" })).rejects.toThrow("GET requests must not include a body");
    await expect(client.raw("HEAD", "hardware", { bodyFactory: () => "body" })).rejects.toThrow("HEAD requests must not include a body");
    expect(unusedFetch).not.toHaveBeenCalled();

    const producerError = new Error("producer failed");
    const producer = vi.fn((): BodyInit | null => { throw producerError; });
    await expect(client.raw("POST", "hardware", { bodyFactory: producer, retry: true })).rejects.toBe(producerError);
    expect(producer).toHaveBeenCalledOnce();
    expect(unusedFetch).not.toHaveBeenCalled();

    const aborter = new AbortController();
    const abortReason = new DOMException("cancelled during production", "AbortError");
    const abortingProducer = vi.fn((): BodyInit | null => {
      aborter.abort(abortReason);
      return "must-not-send";
    });
    await expect(client.raw("POST", "hardware", { bodyFactory: abortingProducer, signal: aborter.signal }))
      .rejects.toBe(abortReason);
    expect(abortingProducer).toHaveBeenCalledOnce();
    expect(unusedFetch).not.toHaveBeenCalled();

    const nullFetch = vi.fn<Fetch>(async (_input, init) => {
      expect(init?.body).toBeUndefined();
      return new Response(null);
    });
    await expect(make(nullFetch).raw("POST", "hardware", { bodyFactory: () => null })).resolves.toBeInstanceOf(Response);
    expect(nullFetch).toHaveBeenCalledOnce();
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

  it("does not await stalled response cancellation before retrying", async () => {
    let calls = 0;
    let cancelCalls = 0;
    const fetch = vi.fn<Fetch>(async () => {
      calls += 1;
      if (calls === 1) {
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            cancelCalls += 1;
            return new Promise<void>(() => undefined);
          },
        });
        return new Response(body, { status: 503 });
      }
      return json({ ok: true });
    });
    await expect(make(fetch, { timeoutMs: 10, retry: { maxRetries: 1, jitter: () => 0 } }).get("hardware"))
      .resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cancelCalls).toBe(1);
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

  it("chunks long request deadlines and Retry-After delays", async () => {
    vi.useFakeTimers();
    const maxTimerMs = 2_147_483_647;
    const thirtyDaysMs = 2_592_000_000;
    const remainderMs = thirtyDaysMs - maxTimerMs;
    try {
      let timeoutSignal: AbortSignal | null | undefined;
      const pendingFetch: Fetch = async (_input, init) => new Promise((_resolve, reject) => {
        timeoutSignal = init?.signal;
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      const timeoutRequest = make(pendingFetch, { timeoutMs: thirtyDaysMs, retry: { maxRetries: 0 } }).get("hardware");
      const timeoutAssertion = expect(timeoutRequest).rejects.toBeInstanceOf(SnipeITTimeoutError);
      await vi.advanceTimersByTimeAsync(maxTimerMs);
      expect(timeoutSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(remainderMs);
      await timeoutAssertion;

      let calls = 0;
      const retrying = make(async () => {
        calls += 1;
        return calls === 1
          ? new Response(null, { status: 503, headers: { "retry-after": "2592000" } })
          : json({ ok: true });
      }, { retry: { maxRetries: 1, jitter: () => 0 } }).get("hardware");
      await vi.advanceTimersByTimeAsync(maxTimerMs);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(remainderMs);
      await expect(retrying).resolves.toEqual({ ok: true });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
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
    expect(() => make(async () => json({}), { retry: { maxRetries: Number.MAX_SAFE_INTEGER + 1 } })).toThrow(/safe integer/u);
    expect(() => make(async () => json({}), { retry: { maxRetries: 101 } })).toThrow(/no greater than 100/u);
    await expect(client.get("hardware", undefined, { retry: { maxRetries: Number.MAX_SAFE_INTEGER + 1 } }))
      .rejects.toThrow(/safe integer/u);
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

  it("does not retain transport objects, response fragments, or rejected URL credentials", async () => {
    const sensitive = "UNIQUE-TRANSPORT-BEARER-SECRET";
    const transportError = Object.assign(new Error(`transport ${sensitive}`), {
      requestHeaders: { authorization: `Bearer ${sensitive}` },
      responseBody: sensitive,
    });
    const assertSecretSafe = (error: unknown): void => {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("cause");
      expect(reachableText(error)).not.toContain(sensitive);
      expect(JSON.stringify(error)).not.toContain(sensitive);
    };

    const connection = await make(async () => { throw transportError; }, { retry: { maxRetries: 0 } })
      .get("hardware").catch((error: unknown) => error);
    assertSecretSafe(connection);

    const timeoutFetch: Fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(transportError), { once: true });
    });
    const timeout = await make(timeoutFetch, { timeoutMs: 2, retry: { maxRetries: 0 } })
      .get("hardware").catch((error: unknown) => error);
    expect(timeout).toBeInstanceOf(SnipeITTimeoutError);
    assertSecretSafe(timeout);

    const failedBody = new ReadableStream<Uint8Array>({ start(controller) { controller.error(transportError); } });
    const postHeader = await make(async () => new Response(failedBody), { retry: { maxRetries: 0 } })
      .get("hardware").catch((error: unknown) => error);
    expect(postHeader).toBeInstanceOf(SnipeITConnectionError);
    assertSecretSafe(postHeader);

    const invalidJson = await make(async () => new Response(`not-json-${sensitive}`), { retry: { maxRetries: 0 } })
      .get("hardware").catch((error: unknown) => error);
    expect(invalidJson).toBeInstanceOf(SnipeITResponseError);
    assertSecretSafe(invalidJson);

    const baseUrlError = (() => {
      try {
        return new SnipeITHttpClient({ baseUrl: `https://user:${sensitive}@example.test`, token: "x", fetch: async () => json({}) });
      } catch (error) {
        return error;
      }
    })();
    expect(baseUrlError).toBeInstanceOf(TypeError);
    assertSecretSafe(baseUrlError);
  });

  it("redacts bearer echoes from API-controlled error bodies and metadata", async () => {
    const token = "secret-token";
    const validation = await make(async () => Response.json({
      messages: `Bearer ${token}`,
      errors: { [token]: [token, { nested: `prefix-${token}-suffix` }] },
    }, {
      status: 422,
      headers: { "x-request-id": token, "retry-after": token },
    }), { retry: { maxRetries: 0 } }).get("hardware").catch((error: unknown) => error);
    expect(validation).toBeInstanceOf(SnipeITValidationError);
    expect(reachableText(validation)).not.toContain(token);
    expect(JSON.stringify(validation)).not.toContain(token);

    const plainText = await make(async () => new Response(`Bearer ${token}`, { status: 400 }), { retry: { maxRetries: 0 } })
      .get("hardware").catch((error: unknown) => error);
    expect(plainText).toBeInstanceOf(SnipeITClientError);
    expect(reachableText(plainText)).not.toContain(token);

    const envelope = await make(async () => json({ status: "error", messages: `Bearer ${token}` }))
      .get("hardware").catch((error: unknown) => error);
    expect(envelope).toBeInstanceOf(SnipeITApiError);
    expect(reachableText(envelope)).not.toContain(token);
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
