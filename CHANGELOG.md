# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [Unreleased]

### Internal / testing
- Update Vitest and coverage-v8 to 4.1.11 for GHSA-82fw-gwwq-j7x9.
- Resolve development-tool advisories with scoped security overrides:
  Miniflare's Sharp 0.35.5 and Undici 7.29.1, and magicast/PostCSS's
  source-map-js 1.2.2. Retain the pinned Wrangler/Miniflare versions and
  supported Node lanes; remove overrides when their upstream dependency
  declarations select patched versions. These packages are development-only.
- Run Docker integration CI against Snipe-IT 8.8.0 alongside the minimum
  supported 8.7.1 runtime; select either local image with `SNIPEIT_IMAGE`.
- Keep cold-start readiness requests alive until their bounded timeout, and
  remove custom fieldset dependencies before deleting test fields on 8.8.0.

### Added
- Portable ESM TypeScript client built with strict TypeScript 7.0.2 and verified declarations for TypeScript 5.7.3.
- Injected-fetch HTTP core with bearer authentication, caller cancellation, timeouts, safe configurable retries, exponential full jitter, `Retry-After`, replay-safe body handling, raw verbs, malformed/empty response checks, structured errors, and secret-redacted structured logging.
- Typed plain-data managers for Accessories, Assets, Categories, Companies, Components, Consumables, Departments, Fields, Fieldsets, Licenses, Locations, Manufacturers, Models, Status Labels, Suppliers, and Users.
- Common CRUD, page listing, and lazy `AsyncIterable` pagination for all managers.
- Asset tag/serial lookups, checkout/check-in, audit/due/overdue, restore, maintenance, licenses, labels, and complete file operations.
- Custom-field label reads, label-to-column writes, response reconciliation, repeated updates without refetch, and unknown-field validation.
- Portable Blob/FormData/web-stream file APIs and isolated `@lfctech/snipeit/node` filesystem helpers.
- Unit, contract, property, coverage, declaration, packed-consumer, Docker integration, and nodejs_compat-disabled local Workers validation.
- Semantic parity matrix, architecture notes, usage documentation, and examples.

### Different by design
- Resource values are plain data with explicit manager operations rather than Pydantic-style mutable active records, dirty tracking, `save`, or `refresh`.
- Filesystem paths are unavailable from the portable export and require the Node subpath.
- Caller cancellation remains an `AbortError`; library timeouts use `SnipeITTimeoutError`.
