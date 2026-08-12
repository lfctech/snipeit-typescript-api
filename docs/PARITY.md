# Semantic parity matrix

Reference baseline: `snipeit-python-api` commit `ce46003fce275f3d5ced05312af29042382e0404`. “Parity” means endpoint, wire shape, default, edge/error behavior, and test—not merely method presence.

| Area | Python behavior/default/quirk | TypeScript equivalent | Verification |
|---|---|---|---|
| Construction | Origin-only HTTPS; HTTP only for `localhost`, `127.0.0.1`, `::1`; no URL credentials/path; strip trailing slash; nonblank token | `new SnipeIT({baseUrl, token})`, same validation | unit + property |
| Defaults | timeout 10s; max retries 3; backoff 0.3s; HEAD/GET/OPTIONS only | `timeoutMs=10000`, `maxRetries=3`, `backoffMs=300`, same methods | unit |
| Request headers | Bearer auth, JSON accept, package user agent | Same; caller headers merged, sensitive values never logged | contract |
| Raw HTTP | GET/POST/PUT/PATCH require JSON body; DELETE permits 204; raw response available | Public `request`, verbs, and `raw`; JSON helpers reject empty success except DELETE | unit |
| Status/errors | redirects error; 401 auth; 404 not found; 422 validation; other 4xx client; 5xx server; 200 `{status:error}` API error | Structured safe error hierarchy and metadata | unit + contract |
| Error messages | JSON `messages` string/list/map/null; non-JSON reason/text; validation `errors` | deterministic extraction and validation details, no response/token retention | unit + property |
| Transport | timeout vs connection mapping | `TimeoutError`, `ConnectionError`, caller `AbortError` | unit + Workers |
| Retries | 429/500/502/503/504; connect/read errors; exponential full jitter; Retry-After seconds/date; no mutating retries | Same safe defaults; explicit opt-in for mutation; no retry of non-replayable body without a factory | unit + property |
| Logging | request timing/debug and retry warnings; never token/header/body | injected structured logger; redacted metadata only | unit |
| Common resources | list/get/create/PATCH/delete for all managers; raw or success envelope payloads | `list/get/create/update/delete`; plain typed immutable-by-convention data | manager contract |
| Pagination | page size 100; offset internal; caller offset rejected; cap last page; stop on empty or integer total | lazy `iterate({limit,pageSize=100})`, identical request/stop rules | unit + property + Workers |
| Response shapes | list requires object and array `rows` (missing/null => empty); get object; payload envelope or raw | Shape checks with `ResponseShapeError` | unit |
| Assets CRUD | path `hardware`; create requires status/model; omit falsey tag for auto-increment | typed create; omit absent/blank tag | unit + integration |
| Asset lookup | `bytag`; localized 404; `byserial` accepts raw object or exactly-one envelope, errors on none/many/malformed | `getByTag`, `getBySerial`, same shape rules and contextual errors | unit |
| Asset assignment | checkout type user/asset/location maps assigned field; refresh true; checkin refresh true | explicit `checkout`/`checkin`; default follow-up GET, `refresh:false` returns action response | unit + integration |
| Audit/restore | asset and manager audit endpoints; due/overdue; restore; refresh true on object actions | explicit id methods; refresh default true where applicable | unit + integration |
| Maintenance/licenses | POST hardware/:id/maintenances unwrap payload; GET hardware/:id/licenses | `createMaintenance`, `getLicenses` | unit |
| Custom-field reads | label-keyed `{field,value,...}`; missing returns default | `getCustomField(asset,label,default)` | unit + property |
| Custom-field writes | label validates; label→column; top-level columns; null nested response; echoed columns; strip stray columns; repeated saves without refetch | `updateCustomFields(asset, values)` returns merged fresh Asset preserving label shape, rejects unknown/malformed labels | unit + property + integration |
| Asset files | list; multipart `file[]`; optional notes; JSON error handling; stream 64KiB download/progress; missing length; delete suffix `/delete` | portable Blob upload/list/download stream/progress/delete; Node path helpers isolate fs | unit + integration + Workers |
| Labels | nonempty valid tags; one PDF Accept; reject non-PDF; write bytes | portable `labels(tags): Blob`; Node `saveAssetLabels`; same validation/content type | unit + Workers |
| Accessories | common CRUD + POST `accessories/:relationshipId/checkin`, return payload | `checkinFromUser` unwraps payload | unit + integration |
| Users | common CRUD + GET `users/me` | `me()` | unit + integration |
| Categories | path categories; create requires name/category_type | typed `categoryType` input serialized snake_case | contract + integration |
| Companies | path companies; create name | typed manager | contract + integration |
| Components | path components; create name/qty/category | typed manager | contract + integration |
| Consumables | path consumables; create name/qty/category | typed manager | contract + integration |
| Departments | path departments; create name | typed manager | contract + integration |
| Fields | path fields; create name/element | typed manager | contract + integration |
| Fieldsets | path fieldsets; create name | typed manager | contract + integration |
| Licenses | path licenses; create name/seats/category | typed manager | contract + integration |
| Locations | path locations; create name; parenting remains extra typed input | typed manager | contract + integration |
| Manufacturers | path manufacturers; create name | typed manager | contract + integration |
| Models | path models; create name/category/manufacturer | typed manager | contract + integration |
| Status labels | non-obvious path `statuslabels`; create name/type | `statusLabels`, correct path | contract + integration |
| Suppliers | path suppliers; create name | typed manager | contract + integration |
| Portability | Python uses sync HTTPX and fs | async web API core; optional Node export; Worker without compatibility | Workers + import scan |
| Declaration compatibility | N/A | emitted using TS 7.0.2; consumed by pinned TS 5.7.3 | clean declaration consumer |
| Packaging | N/A | pnpm ESM, exact versions, lockfile, clean portable and Node packed consumers | pack tests |

## Intentional differences

- No Pydantic, mutable resource instances, snapshots, dirty fields, `mark_dirty`, `save`, or `refresh`. Callers pass explicit update objects and receive new plain data.
- Action methods take ids instead of binding behavior to mutable objects. Their default follow-up GET preserves the observable “refresh=true” behavior; `refresh:false` returns the action payload because there is no stale object to return.
- Portable file APIs accept `Blob`/web streams and return web streams/`Blob`. Filesystem path convenience is exclusively in `@lfctech/snipeit/node`.
- JavaScript caller cancellation remains distinguishable as `AbortError`; library timeouts map to `SnipeITTimeoutError`.
- Groups, Reports, Settings, general audit logs, and maintenance resources beyond asset maintenance are deliberately outside the wrapper. Public raw verbs cover them.
