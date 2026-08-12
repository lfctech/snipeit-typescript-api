import {
  SnipeITApiError,
  SnipeITNotFoundError,
  SnipeITResponseError,
  SnipeITStateError,
} from "./errors.js";
import { SnipeITHttpClient, type JsonRequestOptions, type Query } from "./http.js";
import type {
  Accessory, AccessoryCreateInput, AccessoryUpdateInput, ActionOptions, ApiObject, Asset, AssetCreateInput,
  AssetDownload, AssetUpdateInput, AssetUpload, Category, CategoryCreateInput, CategoryUpdateInput, CheckoutInput,
  Company, CompanyCreateInput, CompanyUpdateInput, Component, ComponentCreateInput, ComponentUpdateInput,
  Consumable, ConsumableCreateInput, ConsumableUpdateInput, CustomFieldEntry, Department, DepartmentCreateInput,
  DepartmentUpdateInput, DownloadOptions, Field, FieldCreateInput, Fieldset, FieldsetCreateInput, FieldsetUpdateInput,
  FieldUpdateInput, IterateOptions, License, LicenseCreateInput, LicenseUpdateInput, ListResponse, Location,
  LocationCreateInput, LocationUpdateInput, MaintenanceCreateInput, Manufacturer, ManufacturerCreateInput,
  ManufacturerUpdateInput, Model, ModelCreateInput, ModelUpdateInput, Resource, StatusLabel, StatusLabelCreateInput,
  StatusLabelUpdateInput, Supplier, SupplierCreateInput, SupplierUpdateInput, User, UserCreateInput, UserUpdateInput,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

export function serializeInput(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [snakeCase(key), value]));
}

export function extractPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new SnipeITResponseError("Unexpected response shape: expected an object");
  if (value["status"] === "error") throw new SnipeITApiError(`API returned status=error in a 200 response body: ${String(value["messages"] ?? "Unknown API error")}`);
  if (value["status"] === "success" && "payload" in value) return isRecord(value["payload"]) ? value["payload"] : {};
  return value;
}

function identifier(value: number | string): string {
  return encodeURIComponent(String(value));
}

export class ResourceManager<T extends Resource, C extends Record<string, unknown>, U extends Record<string, unknown>> {
  constructor(protected readonly http: SnipeITHttpClient, readonly path: string) {}

  async list(query: Query = {}, request: JsonRequestOptions = {}): Promise<ListResponse<T>> {
    const value: unknown = await this.http.get(this.path, query, request);
    if (!isRecord(value)) throw new SnipeITResponseError(`Unexpected response shape for list: expected object with 'rows', got ${typeof value}`);
    const rawRows = value["rows"];
    if (rawRows !== undefined && rawRows !== null && !Array.isArray(rawRows)) throw new SnipeITResponseError("Unexpected response shape: 'rows' must be an array");
    const rows = (rawRows ?? []) as T[];
    const result: ListResponse<T> = { ...value, rows };
    return result;
  }

  async *iterate(options: IterateOptions = {}): AsyncIterable<T> {
    const limit = options.limit;
    const pageSize = options.pageSize ?? 100;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new RangeError("limit must be a non-negative integer");
    if (!Number.isInteger(pageSize) || pageSize <= 0) throw new RangeError("pageSize must be a positive integer");
    const query = options.query ?? {};
    if (Object.prototype.hasOwnProperty.call(query, "offset")) throw new TypeError("Do not pass 'offset' in iterate().query; pagination controls it internally. Use limit to cap results.");
    let yielded = 0;
    while (limit === undefined || yielded < limit) {
      const remaining = limit === undefined ? pageSize : Math.min(pageSize, limit - yielded);
      if (remaining === 0) return;
      const page = await this.list({ ...query, limit: remaining, offset: yielded }, options.request);
      if (page.rows.length === 0) return;
      for (const item of page.rows) {
        yield item;
        yielded += 1;
        if (limit !== undefined && yielded >= limit) return;
      }
      if (typeof page.total === "number" && yielded >= page.total) return;
    }
  }

  async get(id: number | string, query: Query = {}, request: JsonRequestOptions = {}): Promise<T> {
    const value: unknown = await this.http.get(`${this.path}/${identifier(id)}`, query, request);
    if (!isRecord(value)) throw new SnipeITResponseError(`Unexpected response shape for get: expected object, got ${typeof value}`);
    return value as T;
  }

  async create(input: C, request: JsonRequestOptions = {}): Promise<T> {
    const value = await this.http.post<unknown>(this.path, serializeInput(input), request);
    return extractPayload(value) as T;
  }

  async update(id: number | string, input: U, request: JsonRequestOptions = {}): Promise<T> {
    const value = await this.http.patch<unknown>(`${this.path}/${identifier(id)}`, serializeInput(input), request);
    return extractPayload(value) as T;
  }

  delete(id: number | string, request: JsonRequestOptions = {}): Promise<ApiObject | undefined> {
    return this.http.delete<ApiObject>(`${this.path}/${identifier(id)}`, request);
  }
}

class NamedManager<T extends Resource, C extends Record<string, unknown>, U extends Record<string, unknown>> extends ResourceManager<T, C, U> {}

export class AccessoriesManager extends NamedManager<Accessory, AccessoryCreateInput, AccessoryUpdateInput> {
  constructor(http: SnipeITHttpClient) { super(http, "accessories"); }
  async checkinFromUser(accessoryUserId: number, request: JsonRequestOptions = {}): Promise<ApiObject> {
    const value = await this.http.post<unknown>(`accessories/${identifier(accessoryUserId)}/checkin`, {}, request);
    return extractPayload(value);
  }
}
export class CategoriesManager extends NamedManager<Category, CategoryCreateInput, CategoryUpdateInput> { constructor(http: SnipeITHttpClient) { super(http, "categories"); } }
export class CompaniesManager extends NamedManager<Company, CompanyCreateInput, CompanyUpdateInput> { constructor(http: SnipeITHttpClient) { super(http, "companies"); } }
export class ComponentsManager extends NamedManager<Component, ComponentCreateInput, ComponentUpdateInput> { constructor(http: SnipeITHttpClient) { super(http, "components"); } }
export class ConsumablesManager extends NamedManager<Consumable, ConsumableCreateInput, ConsumableUpdateInput> { constructor(http: SnipeITHttpClient) { super(http, "consumables"); } }
export class DepartmentsManager extends NamedManager<Department, DepartmentCreateInput, DepartmentUpdateInput> { constructor(http: SnipeITHttpClient) { super(http, "departments"); } }
export class FieldsManager extends NamedManager<Field, FieldCreateInput, FieldUpdateInput> { constructor(http: SnipeITHttpClient) { super(http, "fields"); } }
export class FieldsetsManager extends NamedManager<Fieldset, FieldsetCreateInput, FieldsetUpdateInput> { constructor(http: SnipeITHttpClient) { super(http, "fieldsets"); } }
export class LicensesManager extends NamedManager<License, LicenseCreateInput, LicenseUpdateInput> { constructor(http: SnipeITHttpClient) { super(http, "licenses"); } }
export class LocationsManager extends NamedManager<Location, LocationCreateInput, LocationUpdateInput> { constructor(http: SnipeITHttpClient) { super(http, "locations"); } }
export class ManufacturersManager extends NamedManager<Manufacturer, ManufacturerCreateInput, ManufacturerUpdateInput> { constructor(http: SnipeITHttpClient) { super(http, "manufacturers"); } }
export class ModelsManager extends NamedManager<Model, ModelCreateInput, ModelUpdateInput> { constructor(http: SnipeITHttpClient) { super(http, "models"); } }
export class StatusLabelsManager extends NamedManager<StatusLabel, StatusLabelCreateInput, StatusLabelUpdateInput> { constructor(http: SnipeITHttpClient) { super(http, "statuslabels"); } }
export class SuppliersManager extends NamedManager<Supplier, SupplierCreateInput, SupplierUpdateInput> { constructor(http: SnipeITHttpClient) { super(http, "suppliers"); } }

export class UsersManager extends NamedManager<User, UserCreateInput, UserUpdateInput> {
  constructor(http: SnipeITHttpClient) { super(http, "users"); }
  async me(request: JsonRequestOptions = {}): Promise<User> {
    const value: unknown = await this.http.get("users/me", undefined, request);
    if (!isRecord(value)) throw new SnipeITResponseError("Unexpected response shape for users/me: expected object");
    return value as User;
  }
}

function splitActionOptions(options: ActionOptions): { refresh: boolean; request: JsonRequestOptions } {
  const { refresh = true, ...request } = options;
  return { refresh, request };
}

function actionData(input: Readonly<Record<string, unknown>>, omitted: ReadonlySet<string> = new Set()): Record<string, unknown> {
  return serializeInput(Object.fromEntries(Object.entries(input).filter(([key]) => !omitted.has(key))));
}

function contentDispositionFilename(value: string | null): string | undefined {
  if (value === null) return undefined;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded !== undefined) {
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  }
  return /filename="?([^";]+)"?/i.exec(value)?.[1];
}

function withProgress(stream: ReadableStream<Uint8Array>, total: number | undefined, callback: (written: number, total: number | undefined) => void): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let written = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) { controller.close(); return; }
        written += result.value.byteLength;
        callback(written, total);
        controller.enqueue(result.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

export class AssetsManager extends ResourceManager<Asset, AssetCreateInput, AssetUpdateInput> {
  constructor(http: SnipeITHttpClient) { super(http, "hardware"); }

  override create(input: AssetCreateInput, request: JsonRequestOptions = {}): Promise<Asset> {
    const normalized: Record<string, unknown> = { ...input };
    if (!input.assetTag) delete normalized["assetTag"];
    return super.create(normalized as AssetCreateInput, request);
  }

  async getByTag(assetTag: string, query: Query = {}, request: JsonRequestOptions = {}): Promise<Asset> {
    try {
      const value: unknown = await this.http.get(`hardware/bytag/${encodeURIComponent(assetTag)}`, query, request);
      if (!isRecord(value)) throw new SnipeITResponseError("Unexpected response shape for bytag: expected object");
      return value as Asset;
    } catch (error) {
      if (error instanceof SnipeITNotFoundError) throw new SnipeITNotFoundError(`Asset with tag ${JSON.stringify(assetTag)} not found.`, error.metadata);
      throw error;
    }
  }

  async getBySerial(serial: string, query: Query = {}, request: JsonRequestOptions = {}): Promise<Asset> {
    let value: unknown;
    try { value = await this.http.get(`hardware/byserial/${encodeURIComponent(serial)}`, query, request); }
    catch (error) {
      if (error instanceof SnipeITNotFoundError) throw new SnipeITNotFoundError(`Asset with serial ${JSON.stringify(serial)} not found.`, error.metadata);
      throw error;
    }
    if (isRecord(value) && "rows" in value) {
      if (!("total" in value)) throw new SnipeITNotFoundError(`Asset with serial ${JSON.stringify(serial)} not found.`);
      if (!Array.isArray(value["rows"])) throw new SnipeITResponseError(`Unexpected response shape for byserial ${JSON.stringify(serial)}: 'rows' must be an array`);
      if (!Number.isInteger(value["total"]) || (value["total"] as number) < 0) throw new SnipeITResponseError(`Unexpected response shape for byserial ${JSON.stringify(serial)}: 'total' must be a non-negative integer`);
      const rows = value["rows"];
      const total = value["total"] as number;
      if (rows.length === 1 && total === 1) {
        if (!isRecord(rows[0])) throw new SnipeITResponseError(`Unexpected response shape for byserial ${JSON.stringify(serial)}: row must be an object`);
        return rows[0] as Asset;
      }
      if (total > 1) throw new SnipeITApiError(`Expected 1 asset with serial ${JSON.stringify(serial)}, but found ${total}.`);
      throw new SnipeITNotFoundError(`Asset with serial ${JSON.stringify(serial)} not found.`);
    }
    if (isRecord(value) && value["id"] !== undefined && value["id"] !== null) return value as Asset;
    throw new SnipeITApiError(`Unexpected response shape for byserial ${JSON.stringify(serial)}.`);
  }

  async checkout(id: number | string, input: CheckoutInput, options: ActionOptions = {}): Promise<Asset | ApiObject> {
    const { refresh, request } = splitActionOptions(options);
    const data = actionData(input, new Set(["assignedToId"]));
    if (input.checkoutToType === "user") data["assigned_user"] = input.assignedToId;
    else if (input.checkoutToType === "asset") data["assigned_asset"] = input.assignedToId;
    else if (input.checkoutToType === "location") data["assigned_location"] = input.assignedToId;
    else throw new TypeError("checkoutToType must be one of 'user', 'asset', or 'location'");
    const action = await this.http.post<ApiObject>(`hardware/${identifier(id)}/checkout`, data, request);
    return refresh ? this.get(id, {}, request) : action;
  }

  async checkin(id: number | string, data: ApiObject = {}, options: ActionOptions = {}): Promise<Asset | ApiObject> {
    const { refresh, request } = splitActionOptions(options);
    const action = await this.http.post<ApiObject>(`hardware/${identifier(id)}/checkin`, serializeInput(data), request);
    return refresh ? this.get(id, {}, request) : action;
  }

  async audit(id: number | string, data: ApiObject = {}, options: ActionOptions = {}): Promise<Asset | ApiObject> {
    const { refresh, request } = splitActionOptions(options);
    const action = await this.http.post<ApiObject>(`hardware/${identifier(id)}/audit`, serializeInput(data), request);
    return refresh ? this.get(id, {}, request) : action;
  }

  auditById(id: number | string, data: ApiObject = {}, request: JsonRequestOptions = {}): Promise<ApiObject> {
    return this.http.post<ApiObject>(`hardware/${identifier(id)}/audit`, serializeInput(data), request);
  }

  async restore(id: number | string, options: ActionOptions = {}): Promise<Asset | ApiObject> {
    const { refresh, request } = splitActionOptions(options);
    const action = await this.http.post<ApiObject>(`hardware/${identifier(id)}/restore`, {}, request);
    return refresh ? this.get(id, {}, request) : action;
  }

  listAuditDue(request: JsonRequestOptions = {}): Promise<ApiObject> { return this.http.get<ApiObject>("hardware/audit/due", undefined, request); }
  listAuditOverdue(request: JsonRequestOptions = {}): Promise<ApiObject> { return this.http.get<ApiObject>("hardware/audit/overdue", undefined, request); }
  getLicenses(id: number | string, request: JsonRequestOptions = {}): Promise<ApiObject> { return this.http.get<ApiObject>(`hardware/${identifier(id)}/licenses`, undefined, request); }

  async createMaintenance(id: number | string, input: MaintenanceCreateInput, request: JsonRequestOptions = {}): Promise<ApiObject> {
    const value = await this.http.post<unknown>("maintenances", serializeInput({ ...input, assetId: id }), request);
    return extractPayload(value);
  }

  getCustomField<T = unknown>(asset: Asset, label: string, defaultValue?: T): unknown | T {
    const fields = asset.custom_fields;
    if (!isRecord(fields)) return defaultValue as T;
    const entry = fields[label];
    return isRecord(entry) && "value" in entry ? entry["value"] : defaultValue as T;
  }

  async updateCustomFields(asset: Asset, updates: Readonly<Record<string, unknown>>, request: JsonRequestOptions = {}): Promise<Asset> {
    if (asset.id === undefined || asset.id === null) throw new SnipeITStateError("Cannot update custom fields without an asset id");
    if (!isRecord(asset.custom_fields)) throw new SnipeITStateError("Cannot update custom fields: 'custom_fields' is not available on this asset. Fetch it and retry.");
    const patch: Record<string, unknown> = {};
    for (const [label, newValue] of Object.entries(updates)) {
      const entry = asset.custom_fields[label];
      if (!isRecord(entry) || typeof entry["field"] !== "string") {
        const available = Object.keys(asset.custom_fields).sort().join(", ");
        throw new SnipeITStateError(`Custom field ${JSON.stringify(label)} is unknown or malformed. Available labels: ${available}`);
      }
      if (entry["value"] !== newValue) patch[entry["field"]] = newValue;
    }
    if (Object.keys(patch).length === 0) return { ...asset };
    const response = await this.http.patch<unknown>(`hardware/${identifier(asset.id)}`, patch, request);
    const payload = extractPayload(response);
    const payloadFields = payload["custom_fields"];
    const nestedFieldsAreAuthoritative = isRecord(payloadFields);
    const fieldSource = nestedFieldsAreAuthoritative ? payloadFields : asset.custom_fields;
    if (payloadFields !== undefined && payloadFields !== null && !isRecord(payloadFields)) {
      throw new SnipeITResponseError("Unexpected custom_fields PATCH response shape: expected an object or null");
    }
    const fields: Record<string, unknown> = {};
    for (const [label, rawEntry] of Object.entries(fieldSource)) fields[label] = isRecord(rawEntry) ? { ...rawEntry } : rawEntry;
    for (const rawEntry of Object.values(fields)) {
      if (!isRecord(rawEntry) || typeof rawEntry["field"] !== "string") continue;
      const column = rawEntry["field"];
      if (!nestedFieldsAreAuthoritative && column in payload) rawEntry["value"] = payload[column];
    }
    const merged: Asset = { ...asset, ...payload, custom_fields: fields };
    for (const key of Object.keys(merged)) if (key.startsWith("_snipeit_")) delete merged[key];
    return merged;
  }

  listFiles(id: number | string, request: JsonRequestOptions = {}): Promise<ApiObject> {
    return this.http.get<ApiObject>(`hardware/${identifier(id)}/files`, undefined, request);
  }

  async uploadFiles(id: number | string, files: readonly AssetUpload[], notes?: string | null, request: JsonRequestOptions = {}): Promise<ApiObject> {
    if (files.length === 0) throw new TypeError("At least one file required");
    const form = new FormData();
    for (const file of files) {
      if (file.name.trim() === "") throw new TypeError("Upload file names must be non-empty");
      form.append("file[]", file.data, file.name);
    }
    if (notes !== undefined && notes !== null) form.append("notes", notes);
    const value = await this.http.request<unknown>("POST", `hardware/${identifier(id)}/files`, { ...request, body: form });
    return extractPayload(value);
  }

  async downloadFile(id: number | string, fileId: number | string, options: DownloadOptions = {}): Promise<AssetDownload> {
    const { progress, ...request } = options;
    const response = await this.http.raw("GET", `hardware/${identifier(id)}/files/${identifier(fileId)}`, request);
    if (response.body === null) throw new SnipeITResponseError("File download response had no body");
    const lengthHeader = response.headers.get("content-length");
    const parsedLength = lengthHeader === null ? undefined : Number(lengthHeader);
    const contentLength = parsedLength !== undefined && Number.isFinite(parsedLength) ? parsedLength : undefined;
    const stream = progress === undefined ? response.body : withProgress(response.body, contentLength, progress);
    const result: { stream: ReadableStream<Uint8Array>; contentLength?: number; contentType?: string; filename?: string } = { stream };
    const contentType = response.headers.get("content-type");
    const filename = contentDispositionFilename(response.headers.get("content-disposition"));
    if (contentLength !== undefined) result.contentLength = contentLength;
    if (contentType !== null) result.contentType = contentType;
    if (filename !== undefined) result.filename = filename;
    return result;
  }

  async deleteFile(id: number | string, fileId: number | string, request: JsonRequestOptions = {}): Promise<void> {
    await this.http.delete(`hardware/${identifier(id)}/files/${identifier(fileId)}/delete`, request);
  }

  async labels(assetsOrTags: readonly (string | Pick<Asset, "asset_tag">)[], request: JsonRequestOptions = {}): Promise<Blob> {
    if (assetsOrTags.length === 0) throw new TypeError("At least one asset or tag required");
    const tags = assetsOrTags.flatMap((item) => {
      const tag = typeof item === "string" ? item : item.asset_tag;
      return typeof tag === "string" && tag.trim() !== "" ? [tag] : [];
    });
    if (tags.length === 0) throw new TypeError("No valid asset tags found");
    const headers = new Headers(request.headers);
    headers.set("accept", "application/pdf, application/json");
    const response = await this.http.raw("POST", "hardware/labels", { ...request, headers, json: { asset_tags: tags } });
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("application/pdf")) return response.blob();
    let value: unknown;
    try { value = await response.json(); }
    catch (cause) {
      throw new SnipeITResponseError("Unexpected hardware/labels response: expected PDF or JSON", {
        method: "POST", path: "/api/v1/hardware/labels", status: response.status,
      }, { cause });
    }
    const payload = extractPayload(value);
    const encoded = payload["pdf"];
    if (typeof encoded !== "string" || encoded === "") {
      throw new SnipeITResponseError("Unexpected hardware/labels response shape: expected a non-empty base64 PDF payload");
    }
    let binary: string;
    try { binary = globalThis.atob(encoded); }
    catch (cause) { throw new SnipeITResponseError("Invalid base64 PDF in hardware/labels response", undefined, { cause }); }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new Blob([bytes], { type: "application/pdf" });
  }
}

export interface Managers {
  readonly accessories: AccessoriesManager;
  readonly assets: AssetsManager;
  readonly categories: CategoriesManager;
  readonly companies: CompaniesManager;
  readonly components: ComponentsManager;
  readonly consumables: ConsumablesManager;
  readonly departments: DepartmentsManager;
  readonly fields: FieldsManager;
  readonly fieldsets: FieldsetsManager;
  readonly licenses: LicensesManager;
  readonly locations: LocationsManager;
  readonly manufacturers: ManufacturersManager;
  readonly models: ModelsManager;
  readonly statusLabels: StatusLabelsManager;
  readonly suppliers: SuppliersManager;
  readonly users: UsersManager;
}
