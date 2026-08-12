import {
  SnipeITApiError,
  SnipeITAuthenticationError,
  SnipeITClientError,
  SnipeITConnectionError,
  SnipeITNotFoundError,
  SnipeITResponseError,
  SnipeITServerError,
  SnipeITTimeoutError,
  SnipeITValidationError,
  type ErrorMetadata,
} from "./errors.js";
import { VERSION } from "./version.js";

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[];
export type Query = Readonly<Record<string, QueryValue>>;

export interface Logger {
  debug?(message: string, metadata: Readonly<Record<string, unknown>>): void;
  warn?(message: string, metadata: Readonly<Record<string, unknown>>): void;
}

export interface RetryOptions {
  readonly maxRetries?: number;
  readonly backoffMs?: number;
  readonly statuses?: ReadonlySet<number> | readonly number[];
  readonly allowedMethods?: ReadonlySet<string> | readonly string[];
  readonly respectRetryAfter?: boolean;
  readonly jitter?: (baseMs: number) => number;
}

export interface SnipeITHttpOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetch?: Fetch;
  readonly retry?: RetryOptions;
  readonly logger?: Logger;
  readonly userAgent?: string;
}

export interface RequestRetryOptions extends RetryOptions {
  /** Explicitly opt this request's method into retrying. */
  readonly enabled?: boolean;
}

export interface RequestOptions {
  readonly query?: Query;
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly json?: unknown;
  readonly body?: BodyInit | null;
  /** Produces a fresh body for each attempt; use for otherwise one-shot bodies. */
  readonly bodyFactory?: () => BodyInit | null;
  readonly retry?: boolean | RequestRetryOptions;
  readonly allowEmpty?: boolean;
}

export interface JsonRequestOptions extends Omit<RequestOptions, "json" | "body" | "bodyFactory"> {}

const DEFAULT_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_METHODS = new Set(["HEAD", "GET", "OPTIONS"]);
const REDACTED_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-api-key"]);

interface ResolvedRetry {
  maxRetries: number;
  backoffMs: number;
  statuses: ReadonlySet<number>;
  allowedMethods: ReadonlySet<string>;
  respectRetryAfter: boolean;
  jitter: (baseMs: number) => number;
}

export function fullJitter(baseMs: number): number {
  return baseMs <= 0 ? 0 : Math.random() * baseMs;
}

export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(trimmed);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - nowMs);
}

export function redactHeaders(input?: HeadersInit): Record<string, string> {
  if (input === undefined) return {};
  const output: Record<string, string> = {};
  new Headers(input).forEach((value, key) => {
    output[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? "***" : value;
  });
  return output;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative finite number`);
  return value;
}

function asSet<T>(value: ReadonlySet<T> | readonly T[] | undefined, fallback: ReadonlySet<T>): ReadonlySet<T> {
  return value === undefined ? fallback : new Set(value);
}

function resolveRetry(options: RetryOptions = {}, defaults?: ResolvedRetry): ResolvedRetry {
  const maxRetries = nonNegativeInteger(options.maxRetries ?? defaults?.maxRetries ?? 3, "maxRetries");
  const backoffMs = nonNegativeFinite(options.backoffMs ?? defaults?.backoffMs ?? 300, "backoffMs");
  return {
    maxRetries,
    backoffMs,
    statuses: asSet(options.statuses, defaults?.statuses ?? DEFAULT_STATUSES),
    allowedMethods: new Set(
      [...asSet(options.allowedMethods, defaults?.allowedMethods ?? DEFAULT_METHODS)].map((method) => method.toUpperCase()),
    ),
    respectRetryAfter: options.respectRetryAfter ?? defaults?.respectRetryAfter ?? true,
    jitter: options.jitter ?? defaults?.jitter ?? fullJitter,
  };
}

function validateBaseUrl(value: string): { baseUrl: string; apiUrl: URL } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new TypeError(`URL must be https://<host> or http://localhost (no credentials, no path). Got: ${value}`, {
      cause,
    });
  }
  const localhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
  const validProtocol = parsed.protocol === "https:" || (parsed.protocol === "http:" && localhost);
  const pathIsOrigin = parsed.pathname === "/" || parsed.pathname === "";
  if (!validProtocol || parsed.username !== "" || parsed.password !== "" || !pathIsOrigin || parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError(`URL must be https://<host> or http://localhost (no credentials, no path). Got: ${value}`);
  }
  const baseUrl = parsed.origin;
  return { baseUrl, apiUrl: new URL("api/v1/", `${baseUrl}/`) };
}

function addQuery(url: URL, query: Query | undefined): void {
  if (query === undefined) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else if (value !== null) {
      url.searchParams.set(key, String(value));
    } else {
      url.searchParams.set(key, "");
    }
  }
}

function stringifyMessages(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join("; ");
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`).join("; ");
  return String(value);
}

function responseMetadata(response: Response, method: string, url: URL): ErrorMetadata {
  const metadata: {
    method: string;
    path: string;
    status: number;
    requestId?: string;
    retryAfter?: string;
    location?: string;
  } = { method, path: url.pathname, status: response.status };
  const requestId = response.headers.get("x-request-id");
  const retryAfter = response.headers.get("retry-after");
  const location = response.headers.get("location");
  if (requestId !== null) metadata.requestId = requestId;
  if (retryAfter !== null) metadata.retryAfter = retryAfter;
  if (location !== null) {
    try { metadata.location = new URL(location, url).origin; }
    catch { metadata.location = "<invalid>"; }
  }
  return metadata;
}

async function errorBody(response: Response): Promise<{ message: string; errors?: unknown }> {
  const fallback = response.statusText || `HTTP ${response.status}`;
  const text = await response.text();
  if (text === "") return { message: fallback };
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      const message = stringifyMessages("messages" in record ? record["messages"] : fallback);
      return "errors" in record ? { message, errors: record["errors"] } : { message };
    }
    return { message: fallback };
  } catch {
    return { message: text || fallback };
  }
}

async function raiseForStatus(response: Response, method: string, url: URL): Promise<void> {
  if (response.status < 300) return;
  const metadata = responseMetadata(response, method, url);
  if (response.status < 400) {
    throw new SnipeITApiError(
      `Unexpected redirect (${response.status}) to ${metadata.location ?? "<unknown>"}. This is usually a reverse-proxy or authentication-middleware misconfiguration.`,
      metadata,
    );
  }
  const body = await errorBody(response);
  if (response.status === 401) throw new SnipeITAuthenticationError(body.message, metadata);
  if (response.status === 404) throw new SnipeITNotFoundError(body.message, metadata);
  if (response.status === 422) throw new SnipeITValidationError(body.message, metadata, body.errors);
  if (response.status < 500) throw new SnipeITClientError(body.message, metadata);
  throw new SnipeITServerError(body.message, metadata);
}

function isReplaySafe(body: BodyInit | null | undefined, factory: (() => BodyInit | null) | undefined): boolean {
  if (factory !== undefined || body === undefined || body === null) return true;
  return (
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const timer = globalThis.setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      globalThis.clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

interface ResponseLifecycle {
  readonly signal: AbortSignal;
  readonly callerSignal?: AbortSignal;
  readonly timedOut: () => boolean;
  readonly timeoutMs: number;
  readonly method: string;
  readonly path: string;
  readonly cleanup: () => void;
}

function readWithSignal(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    reader.read().then(
      (result) => { signal.removeEventListener("abort", aborted); resolve(result); },
      (error: unknown) => { signal.removeEventListener("abort", aborted); reject(error); },
    );
  });
}

function manageResponse(response: Response, lifecycle: ResponseLifecycle): Response {
  if (response.body === null) {
    lifecycle.cleanup();
    return response;
  }
  const reader = response.body.getReader();
  const metadata = { method: lifecycle.method, path: lifecycle.path, status: response.status };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await readWithSignal(reader, lifecycle.signal);
        if (result.done) {
          lifecycle.cleanup();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (cause) {
        lifecycle.cleanup();
        void reader.cancel(cause).catch(() => undefined);
        if (lifecycle.callerSignal?.aborted === true && !lifecycle.timedOut()) {
          controller.error(lifecycle.callerSignal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        } else if (lifecycle.timedOut()) {
          controller.error(new SnipeITTimeoutError(`Request timed out after ${lifecycle.timeoutMs / 1_000} seconds.`, metadata, { cause }));
        } else {
          controller.error(new SnipeITConnectionError(`Connection error while reading ${lifecycle.method} ${lifecycle.path}`, metadata, { cause }));
        }
      }
    },
    async cancel(reason) {
      lifecycle.cleanup();
      await reader.cancel(reason);
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export class SnipeITHttpClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly #token: string;
  private readonly apiUrl: URL;
  private readonly fetchImpl: Fetch;
  private readonly retryDefaults: ResolvedRetry;
  private readonly logger: Logger | undefined;
  private readonly userAgent: string;

  constructor(options: SnipeITHttpOptions) {
    const validated = validateBaseUrl(options.baseUrl);
    if (options.token.trim() === "") throw new TypeError("token must be non-empty");
    this.baseUrl = validated.baseUrl;
    this.apiUrl = validated.apiUrl;
    this.#token = options.token;
    this.timeoutMs = nonNegativeFinite(options.timeoutMs ?? 10_000, "timeoutMs");
    const availableFetch = options.fetch ?? globalThis.fetch;
    if (availableFetch === undefined) throw new TypeError("A fetch implementation is required");
    this.fetchImpl = availableFetch.bind(globalThis) as Fetch;
    this.retryDefaults = resolveRetry(options.retry);
    this.logger = options.logger;
    this.userAgent = options.userAgent ?? `@lfctech/snipeit/${VERSION}`;
  }

  toString(): string {
    return `SnipeITHttpClient(${this.baseUrl}, token=***)`;
  }

  async raw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const normalizedMethod = method.toUpperCase();
    const url = this.resolveUrl(path);
    addQuery(url, options.query);
    const headers = new Headers(options.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (!headers.has("user-agent")) headers.set("user-agent", this.userAgent);
    headers.set("authorization", `Bearer ${this.#token}`);

    if (options.json !== undefined && (options.body !== undefined || options.bodyFactory !== undefined)) {
      throw new TypeError("Use only one of json, body, or bodyFactory");
    }
    let staticBody = options.body;
    if (options.json !== undefined) {
      staticBody = JSON.stringify(options.json);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }

    const requestRetry = typeof options.retry === "object" ? options.retry : {};
    const retry = resolveRetry(requestRetry, this.retryDefaults);
    const explicitlyEnabled = options.retry === true || (typeof options.retry === "object" && options.retry.enabled === true);
    const methodAllowed = explicitlyEnabled || (options.retry !== false && retry.allowedMethods.has(normalizedMethod));
    const replaySafe = isReplaySafe(staticBody, options.bodyFactory);
    const maxRetries = methodAllowed && replaySafe ? retry.maxRetries : 0;

    for (let attempt = 0; ; attempt += 1) {
      const started = Date.now();
      const controller = new AbortController();
      let timedOut = false;
      let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
      let cleaned = false;
      const callerSignal = options.signal;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        if (timeout !== undefined) globalThis.clearTimeout(timeout);
        callerSignal?.removeEventListener("abort", forwardAbort);
      };
      const forwardAbort = (): void => {
        controller.abort(callerSignal?.reason);
        cleanup();
      };
      if (callerSignal?.aborted === true) throw callerSignal.reason ?? new DOMException("The operation was aborted", "AbortError");
      callerSignal?.addEventListener("abort", forwardAbort, { once: true });
      const timeoutMs = nonNegativeFinite(options.timeoutMs ?? this.timeoutMs, "timeoutMs");
      timeout = globalThis.setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException("Request timed out", "TimeoutError"));
        cleanup();
      }, timeoutMs);

      let response: Response;
      try {
        const body = options.bodyFactory?.() ?? staticBody;
        const init: RequestInit = { method: normalizedMethod, headers, signal: controller.signal, redirect: "manual" };
        if (body !== undefined && body !== null && normalizedMethod !== "GET" && normalizedMethod !== "HEAD") init.body = body;
        response = await this.fetchImpl(url, init);
      } catch (cause) {
        cleanup();
        if (controller.signal.aborted && !timedOut) throw callerSignal?.reason ?? new DOMException("The operation was aborted", "AbortError");
        if (timedOut) {
          this.logger?.warn?.("Snipe-IT request timed out", { method: normalizedMethod, path: url.pathname, timeoutMs });
          throw new SnipeITTimeoutError(`Request timed out after ${timeoutMs / 1_000} seconds.`, { method: normalizedMethod, path: url.pathname }, { cause });
        }
        if (attempt < maxRetries) {
          const delayMs = Math.max(0, retry.jitter(retry.backoffMs * 2 ** attempt));
          this.logger?.warn?.("Retrying Snipe-IT request after connection error", { method: normalizedMethod, path: url.pathname, attempt: attempt + 1, maxRetries, delayMs });
          await sleep(delayMs, callerSignal);
          continue;
        }
        this.logger?.warn?.("Snipe-IT connection error", { method: normalizedMethod, path: url.pathname });
        throw new SnipeITConnectionError(`Connection error on ${normalizedMethod} ${url.pathname}`, { method: normalizedMethod, path: url.pathname }, { cause });
      }

      this.logger?.debug?.("Snipe-IT request completed", { method: normalizedMethod, path: url.pathname, status: response.status, elapsedMs: Date.now() - started });
      if (attempt < maxRetries && retry.statuses.has(response.status)) {
        cleanup();
        const retryAfter = retry.respectRetryAfter ? parseRetryAfter(response.headers.get("retry-after")) : undefined;
        const delayMs = retryAfter ?? Math.max(0, retry.jitter(retry.backoffMs * 2 ** attempt));
        this.logger?.warn?.("Retrying Snipe-IT request after HTTP status", { method: normalizedMethod, path: url.pathname, status: response.status, attempt: attempt + 1, maxRetries, delayMs });
        try { await response.body?.cancel(); } catch { /* response cleanup is best effort */ }
        await sleep(delayMs, callerSignal);
        continue;
      }
      const managed = manageResponse(response, {
        signal: controller.signal,
        ...(callerSignal === undefined ? {} : { callerSignal }),
        timedOut: () => timedOut,
        timeoutMs,
        method: normalizedMethod,
        path: url.pathname,
        cleanup,
      });
      try {
        await raiseForStatus(managed, normalizedMethod, url);
      } catch (error) {
        try { await managed.body?.cancel(error); } catch { /* body may already be consumed */ }
        cleanup();
        throw error;
      }
      return managed;
    }
  }

  async request<T = Record<string, unknown>>(method: string, path: string, options: RequestOptions = {}): Promise<T | undefined> {
    const response = await this.raw(method, path, options);
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (text === "") {
      if (options.allowEmpty === true) return undefined;
      throw new SnipeITResponseError(`Expected a JSON body from ${method.toUpperCase()}, but server returned an empty response.`, {
        method: method.toUpperCase(), path: this.resolveUrl(path).pathname, status: response.status,
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      throw new SnipeITResponseError("Expected JSON response but received invalid or non-JSON content.", {
        method: method.toUpperCase(), path: this.resolveUrl(path).pathname, status: response.status,
      }, { cause });
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record["status"] === "error") {
        throw new SnipeITApiError(stringifyMessages(record["messages"] ?? "Unknown API error"), {
          method: method.toUpperCase(), path: this.resolveUrl(path).pathname, status: response.status,
        });
      }
    }
    return value as T;
  }

  async get<T = Record<string, unknown>>(path: string, query?: Query, options: JsonRequestOptions = {}): Promise<T> {
    const value = await this.request<T>("GET", path, { ...options, ...(query === undefined ? {} : { query }) });
    return this.requireBody("GET", value);
  }

  async post<T = Record<string, unknown>>(path: string, json: unknown, options: JsonRequestOptions = {}): Promise<T> {
    const value = await this.request<T>("POST", path, { ...options, json });
    return this.requireBody("POST", value);
  }

  async put<T = Record<string, unknown>>(path: string, json: unknown, options: JsonRequestOptions = {}): Promise<T> {
    const value = await this.request<T>("PUT", path, { ...options, json });
    return this.requireBody("PUT", value);
  }

  async patch<T = Record<string, unknown>>(path: string, json: unknown, options: JsonRequestOptions = {}): Promise<T> {
    const value = await this.request<T>("PATCH", path, { ...options, json });
    return this.requireBody("PATCH", value);
  }

  delete<T = Record<string, unknown>>(path: string, options: JsonRequestOptions = {}): Promise<T | undefined> {
    return this.request<T>("DELETE", path, options);
  }

  private resolveUrl(path: string): URL {
    let resolved: URL;
    try {
      const absolute = new URL(path);
      if (absolute.origin !== this.apiUrl.origin) throw new TypeError("Refusing to send credentials to a different origin");
      resolved = absolute;
    } catch (cause) {
      if (cause instanceof TypeError && cause.message === "Refusing to send credentials to a different origin") throw cause;
      resolved = new URL(path.replace(/^\/+/, ""), this.apiUrl);
    }
    if (resolved.origin !== this.apiUrl.origin) throw new TypeError("Refusing to send credentials to a different origin");
    return resolved;
  }

  private requireBody<T>(method: string, value: T | undefined): T {
    if (value === undefined) throw new SnipeITResponseError(`Expected a JSON body from ${method}, but server returned 204 No Content.`);
    return value;
  }
}
