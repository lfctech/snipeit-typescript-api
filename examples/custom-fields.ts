import { SnipeIT } from "@lfctech/snipeit";

const client = new SnipeIT({ baseUrl: "https://snipe.example.com", token: "replace-me" });
let asset = await client.assets.get(42);
console.log(client.assets.getCustomField(asset, "Owner", "unassigned"));
asset = await client.assets.updateCustomFields(asset, { Owner: "alice" });
asset = await client.assets.updateCustomFields(asset, { Owner: "bob" });
console.log(client.assets.getCustomField(asset, "Owner"));
