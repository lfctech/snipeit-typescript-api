import { SnipeIT, SnipeITValidationError, type Asset, type ListResponse } from "../../dist/index.js";
import { downloadAssetFileToPath } from "../../dist/node.js";

const client = new SnipeIT({ baseUrl: "https://example.test", token: "token", fetch });
const page: Promise<ListResponse<Asset>> = client.assets.list({ limit: 2 });
const stream: AsyncIterable<Asset> = client.assets.iterate({ pageSize: 10 });
const update: Promise<Asset> = client.assets.updateCustomFields({ id: 1, custom_fields: { Owner: { field: "_snipeit_owner_1", value: "a" } } }, { Owner: "b" });
const saved: Promise<string> = downloadAssetFileToPath(client.assets, 1, 2, "./file.bin");
const maintenance = client.assets.createMaintenance(1, {
  maintenanceTypeId: 2,
  name: "Repair",
  startDate: "2026-09-03",
});
void page; void stream; void update; void saved; void maintenance;
// @ts-expect-error Snipe-IT 8.7.1 requires a numeric maintenance type identifier.
client.assets.createMaintenance(1, { assetMaintenanceType: "Repair", name: "Repair", startDate: "2026-09-03" });
const error: Error = new SnipeITValidationError("bad", { status: 422 }, { field: ["required"] });
void error;
