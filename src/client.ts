import { SnipeITHttpClient, type JsonRequestOptions, type Query, type RequestOptions, type SnipeITHttpOptions } from "./http.js";
import { ReportsManager } from "./reports.js";
import {
  AccessoriesManager, AssetsManager, CategoriesManager, CompaniesManager, ComponentsManager, ConsumablesManager,
  DepartmentsManager, FieldsManager, FieldsetsManager, LicensesManager, LocationsManager, ManufacturersManager,
  ModelsManager, StatusLabelsManager, SuppliersManager, UsersManager,
} from "./resources.js";

export type SnipeITOptions = SnipeITHttpOptions;

export class SnipeIT {
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
  readonly reports: ReportsManager;
  readonly statusLabels: StatusLabelsManager;
  readonly suppliers: SuppliersManager;
  readonly users: UsersManager;
  readonly http: SnipeITHttpClient;

  constructor(options: SnipeITOptions) {
    this.http = new SnipeITHttpClient(options);
    this.accessories = new AccessoriesManager(this.http);
    this.assets = new AssetsManager(this.http);
    this.categories = new CategoriesManager(this.http);
    this.companies = new CompaniesManager(this.http);
    this.components = new ComponentsManager(this.http);
    this.consumables = new ConsumablesManager(this.http);
    this.departments = new DepartmentsManager(this.http);
    this.fields = new FieldsManager(this.http);
    this.fieldsets = new FieldsetsManager(this.http);
    this.licenses = new LicensesManager(this.http);
    this.locations = new LocationsManager(this.http);
    this.manufacturers = new ManufacturersManager(this.http);
    this.models = new ModelsManager(this.http);
    this.reports = new ReportsManager(this.http);
    this.statusLabels = new StatusLabelsManager(this.http);
    this.suppliers = new SuppliersManager(this.http);
    this.users = new UsersManager(this.http);
  }

  get baseUrl(): string { return this.http.baseUrl; }
  get timeoutMs(): number { return this.http.timeoutMs; }

  raw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    return this.http.raw(method, path, options);
  }

  request<T = Record<string, unknown>>(method: string, path: string, options: RequestOptions = {}): Promise<T | undefined> {
    return this.http.request<T>(method, path, options);
  }

  get<T = Record<string, unknown>>(path: string, query?: Query, options: JsonRequestOptions = {}): Promise<T> {
    return this.http.get<T>(path, query, options);
  }

  post<T = Record<string, unknown>>(path: string, data: unknown, options: JsonRequestOptions = {}): Promise<T> {
    return this.http.post<T>(path, data, options);
  }

  put<T = Record<string, unknown>>(path: string, data: unknown, options: JsonRequestOptions = {}): Promise<T> {
    return this.http.put<T>(path, data, options);
  }

  patch<T = Record<string, unknown>>(path: string, data: unknown, options: JsonRequestOptions = {}): Promise<T> {
    return this.http.patch<T>(path, data, options);
  }

  delete<T = Record<string, unknown>>(path: string, options: JsonRequestOptions = {}): Promise<T | undefined> {
    return this.http.delete<T>(path, options);
  }

  toString(): string { return `SnipeIT(${this.baseUrl}, token=***)`; }
}
