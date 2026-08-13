import {
  SnipeIT, SnipeITValidationError, activityActorName, activityItemLabel, activityTimestamp,
  type ActivityReportQuery, type ActivityRow, type Asset, type ListResponse,
} from "../../dist/index.js";
import { downloadAssetFileToPath } from "../../dist/node.js";

const client = new SnipeIT({ baseUrl: "https://example.test", token: "token", fetch });
const page: Promise<ListResponse<Asset>> = client.assets.list({ limit: 2 });
const search: Promise<ListResponse<Asset>> = client.assets.search({ statusType: "Deployed", categoryId: 3 });
const stream: AsyncIterable<Asset> = client.assets.iterate({ pageSize: 10 });
const update: Promise<Asset> = client.assets.updateCustomFields({ id: 1, custom_fields: { Owner: { field: "_snipeit_owner_1", value: "a" } } }, { Owner: "b" });
const saved: Promise<string> = downloadAssetFileToPath(client.assets, 1, 2, "./file.bin");
const activityQuery: ActivityReportQuery = { limit: 10, itemType: "asset", actionType: "checkout", sort: "created_at", order: "desc" };
const activity: Promise<ListResponse<ActivityRow>> = client.reports.listActivity(activityQuery, { headers: { "x-trace": "1" } });
const readRow = async (): Promise<(string | undefined)[]> => {
  const [row] = (await activity).rows;
  return row === undefined ? [] : [activityTimestamp(row), activityActorName(row), activityItemLabel(row)];
};
void page; void search; void stream; void update; void saved; void activity; void readRow;
const error: Error = new SnipeITValidationError("bad", { status: 422 }, { field: ["required"] });
void error;
