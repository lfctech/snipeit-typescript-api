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
const MAX_RETRIES = 100;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_TOTAL_DELAY_MS = Number.MAX_SAFE_INTEGER;
const BASE_URL_ERROR = "URL must be https://<host> or http://localhost (no credentials, no path).";

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
  if (Number.isFinite(seconds)) return Math.min(MAX_TOTAL_DELAY_MS, Math.max(0, seconds * 1_000));
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

function retryCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RETRIES) {
    throw new RangeError(`maxRetries must be a non-negative safe integer no greater than ${MAX_RETRIES}`);
  }
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
  const maxRetries = retryCount(options.maxRetries ?? defaults?.maxRetries ?? 3);
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
  } catch {
    throw new TypeError(BASE_URL_ERROR);
  }
  const localhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
  const validProtocol = parsed.protocol === "https:" || (parsed.protocol === "http:" && localhost);
  const pathIsOrigin = parsed.pathname === "/" || parsed.pathname === "";
  if (!validProtocol || parsed.username !== "" || parsed.password !== "" || !pathIsOrigin || parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError(BASE_URL_ERROR);
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

function redactString(value: string, token: string): string {
  return value.split(token).join("***");
}

function redactResponseValue(value: unknown, token: string): unknown {
  if (typeof value === "string") return redactString(value, token);
  if (Array.isArray(value)) return value.map((item) => redactResponseValue(item, token));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactString(key, token), redactResponseValue(item, token),
    ]));
  }
  return value;
}

function stringifyMessages(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join("; ");
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`).join("; ");
  return String(value);
}

function responseMetadata(response: Response, method: string, url: URL, token: string): ErrorMetadata {
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
  if (requestId !== null) metadata.requestId = redactString(requestId, token);
  if (retryAfter !== null) metadata.retryAfter = redactString(retryAfter, token);
  if (location !== null) {
    try { metadata.location = redactString(new URL(location, url).origin, token); }
    catch { metadata.location = "<invalid>"; }
  }
  return metadata;
}

async function errorBody(response: Response, token: string): Promise<{ message: string; errors?: unknown }> {
  const fallback = redactString(response.statusText || `HTTP ${response.status}`, token);
  const text = await response.text();
  if (text === "") return { message: fallback };
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      const messages = redactResponseValue("messages" in record ? record["messages"] : fallback, token);
      const message = stringifyMessages(messages);
      return "errors" in record ? { message, errors: redactResponseValue(record["errors"], token) } : { message };
    }
    return { message: fallback };
  } catch {
    return { message: redactString(text || fallback, token) };
  }
}

async function raiseForStatus(response: Response, method: string, url: URL, token: string): Promise<void> {
  if (response.status < 300) return;
  const metadata = responseMetadata(response, method, url, token);
  if (response.status < 400) {
    throw new SnipeITApiError(
      `Unexpected redirect (${response.status}) to ${metadata.location ?? "<unknown>"}. This is usually a reverse-proxy or authentication-middleware misconfiguration.`,
      metadata,
    );
  }
  const body = await errorBody(response, token);
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

function retryDelay(retry: ResolvedRetry, attempt: number): number {
  const exponential = Math.min(MAX_TOTAL_DELAY_MS, retry.backoffMs * 2 ** attempt);
  const jittered = retry.jitter(exponential);
  if (!Number.isFinite(jittered) || jittered < 0) throw new RangeError("retry jitter must return a non-negative finite number");
  return Math.min(MAX_TOTAL_DELAY_MS, jittered);
}

function scheduleTimeout(callback: () => void, durationMs: number): () => void {
  let remainingMs = Math.min(MAX_TOTAL_DELAY_MS, Math.max(0, durationMs));
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let cancelled = false;
  const scheduleNext = (): void => {
    const delayMs = Math.min(MAX_TIMER_MS, remainingMs);
    timer = globalThis.setTimeout(() => {
      if (cancelled) return;
      remainingMs -= delayMs;
      if (remainingMs > 0) scheduleNext();
      else callback();
    }, delayMs);
  };
  scheduleNext();
  return () => {
    cancelled = true;
    if (timer !== undefined) globalThis.clearTimeout(timer);
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const cancelTimer = scheduleTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      cancelTimer();
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
          controller.error(new SnipeITTimeoutError(`Request timed out after ${lifecycle.timeoutMs / 1_000} seconds.`, metadata));
        } else {
          controller.error(new SnipeITConnectionError(`Connection error while reading ${lifecycle.method} ${lifecycle.path}`, metadata));
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
  private readonly attemptCounts = new WeakMap<object, number>();

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
    return (await this.rawWithAttempts(method, path, options)).response;
  }

  private async rawWithAttempts(method: string, path: string, options: RequestOptions = {}): Promise<{ response: Response; attempts: number }> {
    const normalizedMethod = method.toUpperCase();
    const url = this.resolveUrl(path);
    addQuery(url, options.query);
    const headers = new Headers(options.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (!headers.has("user-agent")) headers.set("user-agent", this.userAgent);
    headers.set("authorization", `Bearer ${this.#token}`);

    const bodySourceCount = [options.json !== undefined, options.body !== undefined, options.bodyFactory !== undefined]
      .filter(Boolean).length;
    if (bodySourceCount > 1) throw new TypeError("Use only one of json, body, or bodyFactory");
    if ((normalizedMethod === "GET" || normalizedMethod === "HEAD") && bodySourceCount > 0) {
      throw new TypeError(`${normalizedMethod} requests must not include a body`);
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
      let cancelTimeout: (() => void) | undefined;
      let cleaned = false;
      const callerSignal = options.signal;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        cancelTimeout?.();
        callerSignal?.removeEventListener("abort", forwardAbort);
      };
      const forwardAbort = (): void => {
        controller.abort(callerSignal?.reason);
        cleanup();
      };
      if (callerSignal?.aborted === true) throw callerSignal.reason ?? new DOMException("The operation was aborted", "AbortError");
      callerSignal?.addEventListener("abort", forwardAbort, { once: true });
      let body: BodyInit | null | undefined;
      try { body = options.bodyFactory === undefined ? staticBody : options.bodyFactory(); }
      catch (error) {
        cleanup();
        throw error;
      }
      if (controller.signal.aborted) {
        cleanup();
        throw callerSignal?.reason ?? new DOMException("The operation was aborted", "AbortError");
      }
      const timeoutMs = nonNegativeFinite(options.timeoutMs ?? this.timeoutMs, "timeoutMs");
      cancelTimeout = scheduleTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException("Request timed out", "TimeoutError"));
        cleanup();
      }, timeoutMs);

      let response: Response;
      try {
        const init: RequestInit = { method: normalizedMethod, headers, signal: controller.signal, redirect: "manual" };
        if (body !== undefined && body !== null) {
          init.body = body;
          if (body instanceof ReadableStream) (init as RequestInit & { duplex: "half" }).duplex = "half";
        }
        response = await this.fetchImpl(url, init);
      } catch {
        cleanup();
        if (controller.signal.aborted && !timedOut) throw callerSignal?.reason ?? new DOMException("The operation was aborted", "AbortError");
        if (timedOut) {
          this.logger?.warn?.("Snipe-IT request timed out", { method: normalizedMethod, path: url.pathname, timeoutMs });
          throw new SnipeITTimeoutError(`Request timed out after ${timeoutMs / 1_000} seconds.`, { method: normalizedMethod, path: url.pathname });
        }
        if (attempt < maxRetries) {
          const delayMs = retryDelay(retry, attempt);
          this.logger?.warn?.("Retrying Snipe-IT request after connection error", { method: normalizedMethod, path: url.pathname, attempt: attempt + 1, maxRetries, delayMs });
          await sleep(delayMs, callerSignal);
          continue;
        }
        this.logger?.warn?.("Snipe-IT connection error", { method: normalizedMethod, path: url.pathname });
        throw new SnipeITConnectionError(`Connection error on ${normalizedMethod} ${url.pathname}`, { method: normalizedMethod, path: url.pathname });
      }

      this.logger?.debug?.("Snipe-IT request completed", { method: normalizedMethod, path: url.pathname, status: response.status, elapsedMs: Date.now() - started });
      if (attempt < maxRetries && retry.statuses.has(response.status)) {
        const retryAfter = retry.respectRetryAfter ? parseRetryAfter(response.headers.get("retry-after")) : undefined;
        const delayMs = retryAfter ?? retryDelay(retry, attempt);
        this.logger?.warn?.("Retrying Snipe-IT request after HTTP status", { method: normalizedMethod, path: url.pathname, status: response.status, attempt: attempt + 1, maxRetries, delayMs });
        try { void response.body?.cancel().catch(() => undefined); } catch { /* response cleanup is best effort */ }
        cleanup();
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
        await raiseForStatus(managed, normalizedMethod, url, this.#token);
      } catch (error) {
        if (typeof error === "object" && error !== null) this.attemptCounts.set(error, attempt + 1);
        try { void managed.body?.cancel(error).catch(() => undefined); } catch { /* body may already be consumed */ }
        cleanup();
        throw error;
      }
      return { response: managed, attempts: attempt + 1 };
    }
  }

  async request<T = Record<string, unknown>>(method: string, path: string, options: RequestOptions = {}): Promise<T | undefined> {
    const normalizedMethod = method.toUpperCase();
    const requestRetry = typeof options.retry === "object" ? options.retry : {};
    const retry = resolveRetry(requestRetry, this.retryDefaults);
    const explicitlyEnabled = options.retry === true || (typeof options.retry === "object" && options.retry.enabled === true);
    const methodAllowed = explicitlyEnabled || (options.retry !== false && retry.allowedMethods.has(normalizedMethod));
    const replaySafe = options.json !== undefined || isReplaySafe(options.body, options.bodyFactory);
    const maxRetries = methodAllowed && replaySafe ? retry.maxRetries : 0;
    const maxAttempts = maxRetries + 1;
    let attemptsUsed = 0;

    while (attemptsUsed < maxAttempts) {
      const retriesRemaining = maxAttempts - attemptsUsed - 1;
      const boundedRetry: boolean | RequestRetryOptions = options.retry === false
        ? false
        : {
            ...(typeof options.retry === "object" ? options.retry : {}),
            ...(options.retry === true ? { enabled: true } : {}),
            maxRetries: retriesRemaining,
          };
      const boundedOptions: RequestOptions = { ...options, retry: boundedRetry };
      let response: Response;
      try {
        const raw = await this.rawWithAttempts(normalizedMethod, path, boundedOptions);
        attemptsUsed += raw.attempts;
        response = raw.response;
      } catch (error) {
        const failedWhileReadingErrorResponse = error instanceof SnipeITConnectionError && error.metadata.status !== undefined;
        const consumed = typeof error === "object" && error !== null ? this.attemptCounts.get(error) : undefined;
        if (!failedWhileReadingErrorResponse || consumed === undefined || attemptsUsed + consumed >= maxAttempts) throw error;
        attemptsUsed += consumed;
        const delayMs = retryDelay(retry, attemptsUsed - 1);
        this.logger?.warn?.("Retrying Snipe-IT request after response read error", {
          method: normalizedMethod, path: this.resolveUrl(path).pathname, attempt: attemptsUsed, maxRetries, delayMs,
        });
        await sleep(delayMs, options.signal);
        continue;
      }
      if (response.status === 204) return undefined;
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (!(error instanceof SnipeITConnectionError) || attemptsUsed >= maxAttempts) throw error;
        const delayMs = retryDelay(retry, attemptsUsed - 1);
        this.logger?.warn?.("Retrying Snipe-IT request after response read error", {
          method: normalizedMethod, path: this.resolveUrl(path).pathname, attempt: attemptsUsed, maxRetries, delayMs,
        });
        await sleep(delayMs, options.signal);
        continue;
      }
      if (text === "") {
        if (options.allowEmpty === true) return undefined;
        throw new SnipeITResponseError(`Expected a JSON body from ${normalizedMethod}, but server returned an empty response.`, {
          method: normalizedMethod, path: this.resolveUrl(path).pathname, status: response.status,
        });
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new SnipeITResponseError("Expected JSON response but received invalid or non-JSON content.", {
          method: normalizedMethod, path: this.resolveUrl(path).pathname, status: response.status,
        });
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (record["status"] === "error") {
          throw new SnipeITApiError(stringifyMessages(redactResponseValue(record["messages"] ?? "Unknown API error", this.#token)), {
            method: normalizedMethod, path: this.resolveUrl(path).pathname, status: response.status,
          });
        }
      }
      return value as T;
    }
    throw new SnipeITConnectionError(`Connection error on ${normalizedMethod} ${this.resolveUrl(path).pathname}`, {
      method: normalizedMethod, path: this.resolveUrl(path).pathname,
    });
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
