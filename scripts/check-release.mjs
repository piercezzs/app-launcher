import { readFileSync } from "node:fs";

const app = JSON.parse(readFileSync(new URL("../apps/hatch/package.json", import.meta.url), "utf8"));
const cargo = readFileSync(new URL("../apps/hatch/src-tauri/Cargo.toml", import.meta.url), "utf8");
const rustVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const tag = process.argv[2];
if (rustVersion !== app.version) {
  throw new Error(`Rust version ${rustVersion} does not match app version ${app.version}`);
}
if (tag && tag !== `v${app.version}`) {
  throw new Error(`Release tag ${tag} must be v${app.version}`);
}
console.log(`Validated app version ${app.version}${tag ? ` and tag ${tag}` : ""}`);
