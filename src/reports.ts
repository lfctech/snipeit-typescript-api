import { SnipeITResponseError } from "./errors.js";
import { SnipeITHttpClient, type JsonRequestOptions, type Query, type QueryValue } from "./http.js";
import type { ListResponse, Resource } from "./types.js";

export type ActivityItemType = "asset" | "accessory" | "consumable" | "component" | "license" | "user";
export type ActivityActionType =
  | "checkout" | "checkin from" | "update" | "create" | "delete" | "audit" | "uploaded" | "accepted"
  | "declined" | "requested";
export type ActivitySortField = "id" | "created_at" | "target_id" | "user_id" | "accept_signature" | "action_type";
export type ActivitySortDirection = "asc" | "desc";

export interface ActivityReportQuery {
  readonly limit?: number;
  readonly offset?: number;
  readonly search?: string;
  readonly targetType?: string;
  readonly targetId?: number;
  readonly itemType?: ActivityItemType;
  readonly itemId?: number;
  readonly actionType?: ActivityActionType;
  readonly sort?: ActivitySortField;
  readonly order?: ActivitySortDirection;
}

export interface ActivityTimestamp {
  readonly datetime?: string | null;
  readonly formatted?: string | null;
  readonly date?: string | null;
  readonly [key: string]: unknown;
}

export interface ActivityActor extends Resource {
  readonly name?: string | null;
  readonly first_name?: string | null;
  readonly last_name?: string | null;
  readonly username?: string | null;
}

export interface ActivityRelatedItem extends Resource {
  readonly name?: string | null;
  readonly asset_tag?: string | null;
  readonly serial?: string | null;
  readonly type?: string | null;
}

export interface ActivityRow extends Resource {
  readonly created_at?: ActivityTimestamp | string | null;
  readonly action_type?: string | null;
  readonly action_source?: string | null;
  readonly note?: string | null;
  readonly remote_ip?: string | null;
  readonly user_agent?: string | null;
  readonly item?: ActivityRelatedItem | null;
  readonly target?: ActivityRelatedItem | null;
  readonly admin?: ActivityActor | null;
  readonly user?: ActivityActor | null;
  readonly created_by?: ActivityActor | null;
  readonly [key: string]: unknown;
}

/**
 * Exhaustive camelCase to Snipe-IT snake_case parameter table for GET reports/activity.
 * Written out by hand rather than derived from a regex so an unrecognized caller key can
 * never be forwarded upstream.
 */
const ACTIVITY_QUERY_KEYS = {
  limit: "limit",
  offset: "offset",
  search: "search",
  targetType: "target_type",
  targetId: "target_id",
  itemType: "item_type",
  itemId: "item_id",
  actionType: "action_type",
  sort: "sort",
  order: "order",
} as const satisfies Readonly<Record<keyof ActivityReportQuery, string>>;

const ACTIVITY_INTEGER_KEYS: ReadonlySet<string> = new Set(["limit", "offset", "targetId", "itemId"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function serializeActivityQuery(query: ActivityReportQuery = {}): Query {
  const serialized: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (!Object.prototype.hasOwnProperty.call(ACTIVITY_QUERY_KEYS, key)) continue;
    const mapped = ACTIVITY_QUERY_KEYS[key as keyof typeof ACTIVITY_QUERY_KEYS];
    if (ACTIVITY_INTEGER_KEYS.has(key)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${key} must be a non-negative safe integer`);
      }
      serialized[mapped] = value;
      continue;
    }
    // Strings pass through untrimmed because the caller owns normalization, and an empty
    // string is still forwarded: http.ts serializes it as `key=`, which upstream treats as set.
    serialized[mapped] = value as QueryValue;
  }
  return serialized;
}

/**
 * Machine-readable activity timestamp, preferring `created_at.datetime`, then a plain
 * `created_at` string, then `created_at.date`, and only then `created_at.formatted`.
 * The precedence matters: `formatted` is a pre-localized display string, and preferring it
 * (as the old tools site did) reinterprets timestamps in the wrong timezone.
 */
export function activityTimestamp(row: ActivityRow): string | undefined {
  const created: unknown = row["created_at"];
  if (typeof created === "string") return nonEmptyString(created);
  if (!isRecord(created)) return undefined;
  return nonEmptyString(created["datetime"]) ?? nonEmptyString(created["date"]) ?? nonEmptyString(created["formatted"]);
}

const ACTIVITY_ACTOR_KEYS = ["user", "created_by", "admin"] as const;

/** Best available actor name, or `undefined`; display placeholders belong to the UI. */
export function activityActorName(row: ActivityRow): string | undefined {
  const actors = ACTIVITY_ACTOR_KEYS.map((key): unknown => row[key]).filter(isRecord);
  for (const actor of actors) {
    const name = nonEmptyString(actor["name"]);
    if (name !== undefined) return name;
  }
  for (const actor of actors) {
    const first = nonEmptyString(actor["first_name"]);
    const last = nonEmptyString(actor["last_name"]);
    if (first !== undefined && last !== undefined) return `${first} ${last}`;
    const single = first ?? last ?? nonEmptyString(actor["username"]);
    if (single !== undefined) return single;
  }
  return undefined;
}

/** Best available label for the row's item, or `undefined` when nothing is available. */
export function activityItemLabel(row: ActivityRow): string | undefined {
  const item: unknown = row["item"];
  if (isRecord(item)) {
    const label = nonEmptyString(item["name"]) ?? nonEmptyString(item["asset_tag"]) ?? nonEmptyString(item["serial"]);
    if (label !== undefined) return label;
  }
  const target: unknown = row["target"];
  return isRecord(target) ? nonEmptyString(target["name"]) : undefined;
}

export class ReportsManager {
  readonly path = "reports/activity";

  constructor(protected readonly http: SnipeITHttpClient) {}

  async listActivity(query: ActivityReportQuery = {}, request: JsonRequestOptions = {}): Promise<ListResponse<ActivityRow>> {
    const value: unknown = await this.http.get(this.path, serializeActivityQuery(query), request);
    if (!isRecord(value)) throw new SnipeITResponseError(`Unexpected response shape for activity report: expected object with 'rows', got ${typeof value}`);
    const rawRows = value["rows"];
    if (rawRows !== undefined && rawRows !== null && !Array.isArray(rawRows)) throw new SnipeITResponseError("Unexpected response shape: 'rows' must be an array");
    const rows = rawRows ?? [];
    if (!rows.every(isRecord)) throw new SnipeITResponseError("Unexpected response shape: every activity row must be an object");
    if ("total" in value && (!Number.isSafeInteger(value["total"]) || (value["total"] as number) < 0)) {
      throw new SnipeITResponseError("Unexpected response shape: 'total' must be a non-negative safe integer");
    }
    const result: ListResponse<ActivityRow> = { ...value, rows: rows as ActivityRow[] };
    return result;
  }
}
