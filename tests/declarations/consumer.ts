import { SnipeIT, SnipeITValidationError, type Asset, type ListResponse } from "../../dist/index.js";
import { downloadAssetFileToPath } from "../../dist/node.js";

const client = new SnipeIT({ baseUrl: "https://example.test", token: "token", fetch });
const page: Promise<ListResponse<Asset>> = client.assets.list({ limit: 2 });
const stream: AsyncIterable<Asset> = client.assets.iterate({ pageSize: 10 });
const update: Promise<Asset> = client.assets.updateCustomFields({ id: 1, custom_fields: { Owner: { field: "_snipeit_owner_1", value: "a" } } }, { Owner: "b" });
const saved: Promise<string> = downloadAssetFileToPath(client.assets, 1, 2, "./file.bin");
void page; void stream; void update; void saved;
const error: Error = new SnipeITValidationError("bad", { status: 422 }, { field: ["required"] });
void error;
