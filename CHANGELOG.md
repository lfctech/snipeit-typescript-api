# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [Unreleased]

### Added
- Portable ESM TypeScript client built with strict TypeScript 7.0.2 and verified declarations for TypeScript 5.7.3.
- Injected-fetch HTTP core with bearer authentication, caller cancellation, timeouts, safe configurable retries, exponential full jitter, `Retry-After`, replay-safe body handling, raw verbs, malformed/empty response checks, structured errors, and secret-redacted structured logging.
- Typed plain-data managers for Accessories, Assets, Categories, Companies, Components, Consumables, Departments, Fields, Fieldsets, Licenses, Locations, Manufacturers, Models, Status Labels, Suppliers, and Users.
- Common CRUD, page listing, and lazy `AsyncIterable` pagination for all managers.
- Asset tag/serial lookups, checkout/check-in, audit/due/overdue, restore, maintenance, licenses, labels, and complete file operations.
- Read-only activity report manager `reports.listActivity()` with an explicit typed query mapping, validated list shape, and null-safe `activityTimestamp`/`activityActorName`/`activityItemLabel` row readers.
- Typed `assets.search()` asset filters and `assets.labelsResponse()` for streaming label PDFs with upstream headers.
- Custom-field label reads, label-to-column writes, response reconciliation, repeated updates without refetch, and unknown-field validation.
- Portable Blob/FormData/web-stream file APIs and isolated `@lfctech/snipeit/node` filesystem helpers.
- Unit, contract, property, coverage, declaration, packed-consumer, Docker integration, and nodejs_compat-disabled local Workers validation.
- Semantic parity matrix, architecture notes, usage documentation, and examples.

### Different by design
- Resource values are plain data with explicit manager operations rather than Pydantic-style mutable active records, dirty tracking, `save`, or `refresh`.
- Filesystem paths are unavailable from the portable export and require the Node subpath.
- Caller cancellation remains an `AbortError`; library timeouts use `SnipeITTimeoutError`.
