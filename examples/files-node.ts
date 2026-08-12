import { SnipeIT } from "@lfctech/snipeit";
import { downloadAssetFileToPath, uploadAssetFilesFromPaths } from "@lfctech/snipeit/node";

const client = new SnipeIT({ baseUrl: "https://snipe.example.com", token: "replace-me" });
await uploadAssetFilesFromPaths(client.assets, 42, ["./receipt.pdf"], "Purchase receipt");
await downloadAssetFileToPath(client.assets, 42, 9, "./downloads/receipt.pdf", {
  progress: (written, total) => console.log({ written, total }),
});
