import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeRoot = join(root, "apps/hatch/src-tauri");

// Local builds use ad-hoc signing even if this shell has release credentials.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("APPLE_")),
);
env.APPLE_SIGNING_IDENTITY = "-";

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`${command} failed (${result.signal ?? result.status}). Stopping.`);
  }
  return result.stdout;
}

function buildLocalMacOS() {
  if (process.platform !== "darwin") {
    throw new Error("desktop:build:local requires macOS. Use pnpm build on other supported hosts.");
  }
  if (process.argv.length > 2) {
    throw new Error("desktop:build:local takes no arguments; it builds for the current Mac.");
  }

  const host = run("rustc", ["-vV"], true).match(/^host: (.+)$/m)?.[1];
  if (!/^(aarch64|x86_64)-apple-darwin$/.test(host ?? "")) {
    throw new Error("A native macOS Rust toolchain is required.");
  }
  const metadata = JSON.parse(run("cargo", [
    "metadata", "--no-deps", "--locked", "--format-version", "1",
    "--manifest-path", join(nativeRoot, "Cargo.toml"),
  ], true));
  const config = JSON.parse(readFileSync(join(nativeRoot, "tauri.conf.json"), "utf8"));
  const macConfig = JSON.parse(readFileSync(join(nativeRoot, "tauri.macos.conf.json"), "utf8"));
  const productName = macConfig.productName ?? config.productName;
  if (typeof productName !== "string" || /[/\\]/.test(productName)
      || typeof metadata.target_directory !== "string") {
    throw new Error("Cannot resolve the configured application bundle path.");
  }
  const bundle = join(metadata.target_directory, host, "release/bundle/macos", `${productName}.app`);

  console.log(`[1/4] Building ${host} application…`);
  run("pnpm", [
    "--filter", "hatch", "desktop:build",
    "--config", "src-tauri/tauri.macos.conf.json", "--bundles", "app", "--target", host,
  ]);
  if (!statSync(bundle).isDirectory()) throw new Error(`Application bundle is missing: ${bundle}`);

  console.log("[2/4] Applying local ad-hoc signature…");
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", bundle]);
  console.log("[3/4] Verifying bundle signature…");
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);

  console.log("[4/4] Checking bundled license resources…");
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt"]) {
    const source = readFileSync(join(root, name));
    const bundled = readFileSync(join(bundle, "Contents/Resources/legal", name));
    if (!source.equals(bundled)) throw new Error(`Bundled ${name} differs from the source file.`);
  }
  console.log(`\nLocal build verified: ${bundle}`);
  console.log("Ad-hoc signed only; no notarization, upload, installation, or release was performed.");
}

try {
  buildLocalMacOS();
} catch (error) {
  console.error(`Local build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode ||= 1;
}
