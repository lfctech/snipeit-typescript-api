# Architecture

`@lfctech/snipeit` is an ESM-first TypeScript client designed from observed Snipe-IT behavior. The Python project is a read-only behavioral specification, not an implementation template.

## Boundaries

- `src/index.ts` and everything it exports use only standard ECMAScript and web APIs (`fetch`, `AbortController`, `Blob`, `FormData`, `ReadableStream`). They import no Node module and reference no Node global.
- `src/node.ts` is the sole filesystem boundary and is published only as `@lfctech/snipeit/node`.
- HTTP is dependency-free and accepts an injected `fetch`, making the core portable to browsers, Node 20+, Bun, Deno, and Cloudflare Workers without `nodejs_compat`.
- Resources are typed plain data. Managers expose explicit Promise-returning operations; there are no mutable active-record models, dirty tracking, `save`, or `refresh`.
- Manager `iterate()` methods provide lazy `AsyncIterable` pagination. `list()` is one page and preserves `total` plus `rows`.

## Request lifecycle

The client validates a base origin and token, creates a request-local abort controller, combines caller cancellation with a timeout, and executes retries only for configured methods and replay-safe bodies. Defaults match the reference: 10 seconds, three retries, 0.3-second exponential base, full jitter, statuses 429/500/502/503/504, and HEAD/GET/OPTIONS only. `Retry-After` seconds and HTTP dates are honored without jitter.

Responses are mapped to structured errors without retaining tokens, request headers, response objects, or bodies in metadata. Logs receive only redacted structured fields. JSON endpoints reject unexpected empty or malformed success bodies. Raw response APIs support PDFs, multipart uploads, and streaming downloads.

## Resource layer

A generic manager implements `list`, `iterate`, `get`, `create`, `update`, and `delete`. Sixteen concrete managers define endpoint paths and typed create/update data. Asset-specific operations cover lookups, checkout/check-in, audits, due/overdue lists, restore, maintenance, licenses, labels, and files. Users expose `me`; accessories expose user check-in.

`src/reports.ts` holds the single read-only manager: `reports.listActivity()` wraps `GET reports/activity` with the same defensive list-shape checks. It does not extend the generic manager because the endpoint has no CRUD surface. Its query type and the typed `assets.search()` filters each use a hand-written camelCase-to-snake_case table rather than the generic `snakeCase` helper, so an unrecognized caller key can never reach the wire. Activity rows are heavily nullable, so `activityTimestamp`, `activityActorName`, and `activityItemLabel` are pure readers that return `undefined` instead of display placeholders; `activityTimestamp` prefers machine-readable values over pre-localized `formatted` strings.

Asset custom fields intentionally have separate read and write forms. Reads remain label-keyed. Writes accept labels, validate them against the fetched asset, translate to top-level `_snipeit_*` columns, and merge Snipe-IT's `custom_fields: null` plus echoed-column PATCH response into a fresh plain object so repeated updates need no refetch.
