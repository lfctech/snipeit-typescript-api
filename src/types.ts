import type { JsonRequestOptions, Query } from "./http.js";

export interface Resource {
  id?: number | string | null;
  [key: string]: unknown;
}

export interface NamedResource extends Resource {
  name?: string | null;
}

export interface ListResponse<T> {
  rows: T[];
  total?: number;
  [key: string]: unknown;
}

export interface IterateOptions {
  readonly limit?: number;
  readonly pageSize?: number;
  readonly query?: Query;
  readonly request?: JsonRequestOptions;
}

export type UpdateInput<T extends Resource> = Partial<Omit<T, "id">> & Record<string, unknown>;

export interface Accessory extends NamedResource { qty?: number; category?: Resource | null; }
export interface Asset extends NamedResource {
  asset_tag?: string | null;
  serial?: string | null;
  model?: NamedResource | null;
  custom_fields?: Readonly<Record<string, CustomFieldEntry | unknown>> | null;
}
export interface Category extends NamedResource { category_type?: string | null; }
export interface Company extends NamedResource {}
export interface Component extends NamedResource { qty?: number; category?: Resource | null; }
export interface Consumable extends NamedResource { qty?: number; category?: Resource | null; }
export interface Department extends NamedResource {}
export interface Field extends NamedResource { element?: string | null; }
export interface Fieldset extends NamedResource {}
export interface License extends NamedResource { seats?: number; category?: Resource | null; }
export interface Location extends NamedResource { parent?: Resource | null; }
export interface Manufacturer extends NamedResource {}
export interface Model extends NamedResource { model_number?: string | null; category?: Resource | null; manufacturer?: Resource | null; }
export interface StatusLabel extends NamedResource { type?: string | null; }
export interface Supplier extends NamedResource {}
export interface User extends NamedResource { username?: string | null; first_name?: string | null; last_name?: string | null; }

export interface CustomFieldEntry {
  readonly field: string;
  readonly value?: unknown;
  readonly [key: string]: unknown;
}

export interface BaseCreateInput { readonly [key: string]: unknown; }
export interface AccessoryCreateInput extends BaseCreateInput { readonly name: string; readonly qty: number; readonly categoryId: number; }
export interface AssetCreateInput extends BaseCreateInput { readonly statusId: number; readonly modelId: number; readonly assetTag?: string | null; }
export interface CategoryCreateInput extends BaseCreateInput { readonly name: string; readonly categoryType: string; }
export interface CompanyCreateInput extends BaseCreateInput { readonly name: string; }
export interface ComponentCreateInput extends BaseCreateInput { readonly name: string; readonly qty: number; readonly categoryId: number; }
export interface ConsumableCreateInput extends BaseCreateInput { readonly name: string; readonly qty: number; readonly categoryId: number; }
export interface DepartmentCreateInput extends BaseCreateInput { readonly name: string; }
export interface FieldCreateInput extends BaseCreateInput { readonly name: string; readonly element: string; }
export interface FieldsetCreateInput extends BaseCreateInput { readonly name: string; }
export interface LicenseCreateInput extends BaseCreateInput { readonly name: string; readonly seats: number; readonly categoryId: number; }
export interface LocationCreateInput extends BaseCreateInput { readonly name: string; }
export interface ManufacturerCreateInput extends BaseCreateInput { readonly name: string; }
export interface ModelCreateInput extends BaseCreateInput { readonly name: string; readonly categoryId: number; readonly manufacturerId: number; }
export interface StatusLabelCreateInput extends BaseCreateInput { readonly name: string; readonly type: string; }
export interface SupplierCreateInput extends BaseCreateInput { readonly name: string; }
export interface UserCreateInput extends BaseCreateInput { readonly username: string; }

export type AccessoryUpdateInput = UpdateInput<Accessory>;
export type AssetUpdateInput = UpdateInput<Asset> & { statusId?: number; modelId?: number; assetTag?: string | null };
export type CategoryUpdateInput = UpdateInput<Category> & { categoryType?: string };
export type CompanyUpdateInput = UpdateInput<Company>;
export type ComponentUpdateInput = UpdateInput<Component> & { categoryId?: number };
export type ConsumableUpdateInput = UpdateInput<Consumable> & { categoryId?: number };
export type DepartmentUpdateInput = UpdateInput<Department>;
export type FieldUpdateInput = UpdateInput<Field>;
export type FieldsetUpdateInput = UpdateInput<Fieldset>;
export type LicenseUpdateInput = UpdateInput<License> & { categoryId?: number };
export type LocationUpdateInput = UpdateInput<Location> & { parentId?: number | null };
export type ManufacturerUpdateInput = UpdateInput<Manufacturer>;
export type ModelUpdateInput = UpdateInput<Model> & { categoryId?: number; manufacturerId?: number };
export type StatusLabelUpdateInput = UpdateInput<StatusLabel>;
export type SupplierUpdateInput = UpdateInput<Supplier>;
export type UserUpdateInput = UpdateInput<User>;

export type CheckoutTargetType = "user" | "asset" | "location";
export interface CheckoutInput extends BaseCreateInput {
  readonly checkoutToType: CheckoutTargetType;
  readonly assignedToId: number;
}

export interface ActionOptions extends JsonRequestOptions { readonly refresh?: boolean; }
export interface MaintenanceCreateInput extends BaseCreateInput {
  readonly assetMaintenanceType: string;
  readonly name: string;
  readonly startDate: string;
  readonly supplierId?: number | null;
  readonly completionDate?: string | null;
  readonly isWarranty?: boolean;
  readonly notes?: string | null;
  readonly cost?: number | null;
}

/** Typed `GET hardware` filters; every field is a parameter confirmed against the Snipe-IT 8.2.0 description. */
export interface AssetListQuery {
  readonly limit?: number;
  readonly offset?: number;
  readonly search?: string;
  readonly sort?: string;
  readonly order?: AssetSortDirection;
  readonly orderNumber?: string;
  readonly statusId?: number;
  readonly statusType?: AssetStatusType;
  readonly locationId?: number;
  readonly categoryId?: number;
  readonly modelId?: number;
  readonly manufacturerId?: number;
  readonly companyId?: number;
  readonly assignedTo?: number;
  readonly assignedType?: string;
}

export type AssetSortDirection = "asc" | "desc";
export type AssetStatusType = "RTD" | "Deployed" | "Undeployable" | "Deleted" | "Archived" | "Requestable";

export interface AssetUpload {
  readonly name: string;
  readonly data: Blob;
}

export interface DownloadOptions extends JsonRequestOptions {
  readonly progress?: (written: number, total: number | undefined) => void;
}

export interface AssetDownload {
  readonly stream: ReadableStream<Uint8Array>;
  readonly contentLength?: number;
  readonly contentType?: string;
  readonly filename?: string;
}

export type ApiObject = Record<string, unknown>;
