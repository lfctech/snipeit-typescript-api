# @lfctech/snipeit

A production-oriented, fully typed Snipe-IT API client for TypeScript and JavaScript. The core uses only web APIs, works with an injected `fetch`, and is portable to Node 20+, browsers, Deno, Bun, and Cloudflare Workers without `nodejs_compat`. Filesystem conveniences live in the separate `@lfctech/snipeit/node` export.

## Install

```sh
pnpm add @lfctech/snipeit
```

This package is ESM-only. It is built with stable TypeScript 7 and its declarations are verified with TypeScript 5.7.3.

## Client

```ts
import { SnipeIT } from "@lfctech/snipeit";

const snipe = new SnipeIT({
  baseUrl: "https://snipe.example.com",
  token: process.env.SNIPEIT_TOKEN!,
});

const asset = await snipe.assets.get(42);
console.log(asset.asset_tag);
```

`baseUrl` must be an origin-only HTTPS URL. Plain HTTP is accepted only for `localhost`, `127.0.0.1`, and `::1`. Credentials, paths, query strings, and fragments are rejected. Tokens must be nonblank.

Options include an injected `fetch`, `timeoutMs` (default `10000`), a structured `logger`, `userAgent`, and retry configuration. Default retries are three attempts after the initial request, statuses 429/500/502/503/504, 300 ms exponential base with full jitter, and `Retry-After` support; `maxRetries` must be a non-negative safe integer no greater than 100. Only HEAD, GET, and OPTIONS retry by default. Opt a replay-safe mutation in explicitly with `{ retry: true }`; one-shot bodies require `bodyFactory`. Low-level requests accept exactly one of `json`, `body`, or `bodyFactory`; GET and HEAD bodies are rejected.

Every request accepts a caller `AbortSignal`. Caller cancellation is preserved as its abort reason; library timeouts throw `SnipeITTimeoutError`.

## Resources

Sixteen managers are created eagerly:

| Property | API path | Specialized methods |
|---|---|---|
| `accessories` | `accessories` | `checkinFromUser` |
| `assets` | `hardware` | lookups, assignment, audits, restore, maintenance, licenses, labels, files, custom fields |
| `categories` | `categories` | — |
| `companies` | `companies` | — |
| `components` | `components` | — |
| `consumables` | `consumables` | — |
| `departments` | `departments` | — |
| `fields` | `fields` | — |
| `fieldsets` | `fieldsets` | — |
| `licenses` | `licenses` | — |
| `locations` | `locations` | — |
| `manufacturers` | `manufacturers` | — |
| `models` | `models` | — |
| `statusLabels` | `statuslabels` | — |
| `suppliers` | `suppliers` | — |
| `users` | `users` | `me` |

All managers expose `list`, `iterate`, `get`, `create`, `update`, and `delete`. Read values are typed plain data and retain unknown server fields for version resilience. Write inputs use idiomatic camel-case names and are converted to Snipe-IT's top-level snake case.

```ts
const page = await snipe.assets.list({ search: "laptop", limit: 25 });

for await (const asset of snipe.assets.iterate({
  query: { status: "Ready to Deploy" },
  pageSize: 100,
  limit: 500,
})) {
  console.log(asset.id, asset.asset_tag);
}

const created = await snipe.assets.create({ statusId: 2, modelId: 8 }); // tag auto-increments
const changed = await snipe.assets.update(created.id!, { name: "Build laptop" });
await snipe.assets.delete(changed.id!);
```

Do not put `offset` in `iterate().query`; iteration owns the offset. It requests at most the remaining limit and stops on an empty page or a reached integer `total`.

## Asset actions

```ts
await snipe.assets.getByTag("LFC-1001");
await snipe.assets.getBySerial("ABC123");

await snipe.assets.checkout(42, {
  checkoutToType: "user", // user | asset | location
  assignedToId: 7,
  note: "Issued by automation",
});
await snipe.assets.checkin(42, { note: "Returned" });
await snipe.assets.audit(42, { locationId: 3 });
await snipe.assets.restore(42);
```

`checkout`, `checkin`, `audit`, and `restore` perform a follow-up GET by default and return the fresh asset. Pass `{ refresh: false }` as the final argument to skip that round trip and receive the action response. Manager-style `auditById` returns the raw audit response. `listAuditDue`, `listAuditOverdue`, `createMaintenance`, and `getLicenses` cover the remaining supported asset endpoints.

## Custom fields

Snipe-IT reads custom fields by display label but writes top-level internal column names. PATCH responses often contain `custom_fields: null`, echo updated `_snipeit_*` columns at the top level, and leak unrelated columns. `updateCustomFields` handles this wire quirk without mutable models:

```ts
let asset = await snipe.assets.get(42);
console.log(snipe.assets.getCustomField(asset, "Owner", "unassigned"));

asset = await snipe.assets.updateCustomFields(asset, { Owner: "alice" });
asset = await snipe.assets.updateCustomFields(asset, { Owner: "bob" }); // no refetch required
```

Labels are validated against `asset.custom_fields`. Unknown or malformed labels throw `SnipeITStateError`. The returned asset is a fresh object: its label-keyed read shape is preserved and updated, while echoed top-level `_snipeit_*` keys are removed.

## Files and labels

Portable APIs use `Blob`, `FormData`, and `ReadableStream`:

```ts
await snipe.assets.uploadFiles(42, [
  { name: "receipt.pdf", data: new Blob([bytes], { type: "application/pdf" }) },
], "Purchase receipt");

const download = await snipe.assets.downloadFile(42, 9, {
  signal: controller.signal,
  progress: (written, total) => console.log(written, total),
});
for await (const chunk of download.stream) consume(chunk);

await snipe.assets.deleteFile(42, 9);
const pdf = await snipe.assets.labels(["LFC-1001", "LFC-1002"]);
```

Node path helpers are explicitly separate:

```ts
import {
  downloadAssetFileToPath,
  saveAssetLabels,
  uploadAssetFilesFromPaths,
} from "@lfctech/snipeit/node";

await uploadAssetFilesFromPaths(snipe.assets, 42, ["./receipt.pdf"], "Receipt");
await downloadAssetFileToPath(snipe.assets, 42, 9, "./downloads/receipt.pdf");
await saveAssetLabels(snipe.assets, "./labels/assets.pdf", ["LFC-1001"]);
```

Downloads stream to a temporary sibling file, sync, then rename; failures remove partial output. Upload paths are checked for regular-file existence and readability.

## Raw HTTP and errors

Outside-scope Snipe-IT endpoints remain reachable through `request`, `raw`, `get`, `post`, `put`, `patch`, and `delete` on `SnipeIT` or `client.http`. Cross-origin URLs are rejected so bearer credentials cannot be forwarded accidentally.

```ts
const settings = await snipe.get<Record<string, unknown>>("settings");
const response = await snipe.raw("GET", "hardware/42/files/9", { signal });
```

Errors derive from `SnipeITError`: `SnipeITConnectionError`, `SnipeITTimeoutError`, `SnipeITAuthenticationError` (401), `SnipeITNotFoundError` (404), `SnipeITValidationError` (422, with `errors`), `SnipeITClientError`, `SnipeITServerError`, `SnipeITApiError`, `SnipeITResponseError`, and `SnipeITStateError`. Metadata contains only safe method/path/status and selected response headers; response objects, bodies, bearer tokens, cookies, and API keys are never retained or logged.

```ts
import { SnipeITNotFoundError, SnipeITValidationError } from "@lfctech/snipeit";
try {
  await snipe.assets.get(999999);
} catch (error) {
  if (error instanceof SnipeITNotFoundError) console.error(error.metadata.status);
  if (error instanceof SnipeITValidationError) console.error(error.errors);
}
```

## Scope and development

Groups, Reports, Settings, general audit logs, and maintenance beyond supported asset maintenance are outside the typed wrapper; use raw methods. See [`docs/PARITY.md`](docs/PARITY.md) for the behavioral matrix and justified differences, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for boundaries.

```sh
pnpm install --frozen-lockfile
pnpm validate
pnpm test:docker # requires Docker; starts its own stack and readiness workflow
```

The Workers check runs built core code locally with `nodejs_compat` disabled. Nothing in the validation process deploys or publishes the package.
