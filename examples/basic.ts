import { SnipeIT } from "@lfctech/snipeit";

const client = new SnipeIT({
  baseUrl: process.env["SNIPEIT_URL"] ?? "https://snipe.example.com",
  token: process.env["SNIPEIT_TOKEN"] ?? "replace-me",
});

for await (const asset of client.assets.iterate({ pageSize: 100, limit: 250 })) {
  console.log(asset.id, asset.asset_tag, asset.name);
}
