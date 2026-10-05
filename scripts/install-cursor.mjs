import { cp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(
  os.homedir(),
  ".cursor",
  "extensions",
  "local.active-0.1.0",
);

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(
  path.join(root, "package.json"),
  path.join(destination, "package.json"),
);
await cp(path.join(root, "out"), path.join(destination, "out"), {
  recursive: true,
});

console.log(`Installed Active to ${destination}`);
console.log("Reload Cursor to pick it up.");
