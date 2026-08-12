import { randomBytes } from "node:crypto";
import { SnipeIT } from "../../dist/index.js";

const baseUrl = process.env.SNIPEIT_TEST_URL;
const token = process.env.SNIPEIT_TEST_TOKEN;
if (!baseUrl || !token) throw new Error("SNIPEIT_TEST_URL and SNIPEIT_TEST_TOKEN are required");
const client = new SnipeIT({ baseUrl, token, timeoutMs: 30_000 });
const run = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const name = (prefix) => `ts-${prefix}-${run}`;
const id = (value) => {
  const result = Number(value?.id);
  if (!Number.isInteger(result) || result <= 0) throw new Error(`Expected positive resource id: ${JSON.stringify(value)}`);
  return result;
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function verify(manager, createInput, updateInput) {
  const created = await manager.create(createInput);
  const resourceId = id(created);
  const fetched = await manager.get(resourceId);
  assert(id(fetched) === resourceId, `${manager.path}.get mismatch`);
  const updated = await manager.update(resourceId, updateInput);
  assert(id(updated) === resourceId, `${manager.path}.update mismatch`);
  const listed = await manager.list({ limit: 500 });
  assert(listed.rows.some((item) => Number(item.id) === resourceId), `${manager.path}.list missing created resource`);
  return updated;
}

const me = await client.users.me();
assert(id(me) > 0, "authenticated current user failed");

const manufacturer = await verify(client.manufacturers, { name: name("manufacturer") }, { name: name("manufacturer-updated") });
const categoryAsset = await verify(client.categories, { name: name("cat-asset"), categoryType: "asset" }, { name: name("cat-asset-updated") });
const categoryAccessory = await client.categories.create({ name: name("cat-accessory"), categoryType: "accessory" });
const categoryComponent = await client.categories.create({ name: name("cat-component"), categoryType: "component" });
const categoryConsumable = await client.categories.create({ name: name("cat-consumable"), categoryType: "consumable" });
const categoryLicense = await client.categories.create({ name: name("cat-license"), categoryType: "license" });
const locationRoot = await verify(client.locations, { name: name("location") }, { name: name("location-updated") });
await verify(client.locations, { name: name("location-child"), parentId: id(locationRoot) }, { parentId: id(locationRoot) });
const status = await verify(client.statusLabels, { name: name("status"), type: "deployable" }, { name: name("status-updated") });
const model = await verify(client.models, {
  name: name("model"), categoryId: id(categoryAsset), manufacturerId: id(manufacturer), modelNumber: `MN-${run}`,
}, { name: name("model-updated") });
const user = await verify(client.users, {
  username: name("user"), firstName: "Type", lastName: "Script", email: `${name("user")}@example.invalid`,
  password: "Pass1234!", passwordConfirmation: "Pass1234!",
}, { firstName: "Updated" });

await verify(client.accessories, { name: name("accessory"), qty: 3, categoryId: id(categoryAccessory), manufacturerId: id(manufacturer) }, { qty: 4 });
await verify(client.companies, { name: name("company") }, { name: name("company-updated") });
await verify(client.components, { name: name("component"), qty: 2, categoryId: id(categoryComponent), manufacturerId: id(manufacturer) }, { qty: 3 });
await verify(client.consumables, { name: name("consumable"), qty: 5, categoryId: id(categoryConsumable), manufacturerId: id(manufacturer) }, { qty: 4 });
await verify(client.departments, { name: name("department") }, { name: name("department-updated") });
const fieldLabel = name("field-updated");
const field = await verify(client.fields, { name: name("field"), element: "text" }, { name: fieldLabel });
const fieldset = await verify(client.fieldsets, { name: name("fieldset") }, { name: name("fieldset-updated") });
await verify(client.licenses, { name: name("license"), seats: 1, categoryId: id(categoryLicense) }, { seats: 2 });
const supplier = await verify(client.suppliers, { name: name("supplier") }, { name: name("supplier-updated") });

const tag = `TS-${run}`;
const serial = `SER-${run}`;
let asset = await verify(client.assets, {
  statusId: id(status), modelId: id(model), assetTag: tag, name: name("asset"), serial, locationId: id(locationRoot),
}, { name: name("asset-updated") });
const assetId = id(asset);
assert(id(await client.assets.getByTag(tag)) === assetId, "tag lookup failed");
assert(id(await client.assets.getBySerial(serial)) === assetId, "serial lookup failed");
asset = await client.assets.checkout(assetId, { checkoutToType: "user", assignedToId: id(user), note: "integration" });
asset = await client.assets.checkin(assetId, { note: "integration" });
asset = await client.assets.audit(assetId, { note: "integration" });
await client.assets.auditById(assetId, { note: "manager integration" });
await client.assets.listAuditDue();
await client.assets.listAuditOverdue();
await client.assets.getLicenses(assetId);
await client.assets.createMaintenance(assetId, { assetImprovement: "repair", supplierId: id(supplier), title: name("maintenance") });

const bytes = randomBytes(65_536);
await client.assets.uploadFiles(assetId, [{ name: `${name("attachment")}.txt`, data: new Blob([bytes], { type: "text/plain" }) }], "integration upload");
const files = await client.assets.listFiles(assetId);
const rows = files.rows ?? files.files ?? files.payload ?? [];
assert(Array.isArray(rows) && rows.length > 0, "file list was empty after upload");
const file = rows.find((item) => String(item.name ?? item.filename ?? item.original_name ?? "").includes("attachment")) ?? rows.at(-1);
const fileId = id(file);
let progress = 0;
const downloaded = await client.assets.downloadFile(assetId, fileId, { progress: (written) => { progress = written; } });
const roundTrip = new Uint8Array(await new Response(downloaded.stream).arrayBuffer());
assert(roundTrip.length === bytes.length && roundTrip.every((value, index) => value === bytes[index]), "file bytes did not round-trip");
assert(progress === bytes.length, "download progress did not reach payload size");
await client.assets.deleteFile(assetId, fileId);

const labelPdf = await client.assets.labels([tag]);
assert(labelPdf.size > 0 && labelPdf.type.includes("pdf"), "label PDF failed");

await client.post(`fields/${id(field)}/associate`, { fieldset_id: id(fieldset) });
const customModel = await client.models.create({
  name: name("custom-model"), categoryId: id(categoryAsset), manufacturerId: id(manufacturer), fieldsetId: id(fieldset), modelNumber: `CF-${run}`,
});
let customAsset = await client.assets.create({ statusId: id(status), modelId: id(customModel), assetTag: `CF-${run}` });
customAsset = await client.assets.get(id(customAsset));
assert(customAsset.custom_fields && customAsset.custom_fields[fieldLabel], "custom field read shape missing label");
customAsset = await client.assets.updateCustomFields(customAsset, { [fieldLabel]: "alice" });
customAsset = await client.assets.updateCustomFields(customAsset, { [fieldLabel]: "bob" });
assert(client.assets.getCustomField(customAsset, fieldLabel) === "bob", "custom field repeated local reconciliation failed");
const customFetched = await client.assets.get(id(customAsset));
assert(client.assets.getCustomField(customFetched, fieldLabel) === "bob", "custom field did not persist");

const restoreAsset = await client.assets.create({ statusId: id(status), modelId: id(model), assetTag: `RESTORE-${run}` });
await client.assets.delete(id(restoreAsset));
await client.assets.restore(id(restoreAsset), { refresh: false });
assert(id(await client.assets.get(id(restoreAsset))) === id(restoreAsset), "asset restore failed");

const iterated = [];
for await (const item of client.assets.iterate({ limit: 2, pageSize: 1 })) iterated.push(item);
assert(iterated.length === 2, "real async pagination failed");

console.log(JSON.stringify({ ok: true, managers: 16, assetActions: true, customFields: true, files: true, labels: true, restore: true }));
