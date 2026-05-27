#!/usr/bin/env node
// Download and extract a pinned OmniSharp release into `src-tauri/gen/managed-omnisharp/`,
// then optionally run the `omnisharp_handshake` integration test against it.
//
// Usage:
//   bun run scripts/prepare-managed-omnisharp.mjs              # just prepare
//   bun run scripts/prepare-managed-omnisharp.mjs --test       # prepare + run cargo test
//
// Override the version with LOCUS_OMNISHARP_VERSION=v1.39.13.
//
// On success the absolute path to the OmniSharp executable is printed on the
// last stdout line, so a shell caller can do:
//   OMNISHARP=$(bun run scripts/prepare-managed-omnisharp.mjs | tail -n 1)

import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_VERSION = "v1.39.15";
const VERSION = process.env.LOCUS_OMNISHARP_VERSION?.trim() || DEFAULT_VERSION;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const cacheDir = path.join(repoRoot, ".cache", "managed-omnisharp", VERSION);
const outputRoot = path.join(repoRoot, "src-tauri", "gen", "managed-omnisharp");

const args = new Set(process.argv.slice(2));
const runTest = args.has("--test");

function platformAsset() {
  const platform = process.platform;
  const arch = process.arch;
  // Use the `-net6.0` variants everywhere. The .NET-Framework / mono builds
  // (no suffix) ship a Microsoft.Build that's frozen at v15.x and can only
  // load MSBuild instances from a matching CLR; on a modern host (Win10+
  // with .NET 8 SDK) MSBuildLocator picks up VS Build Tools 2017 and Roslyn
  // crashes loading every .csproj with "ProjectCacheService.DisposeAsync
  // has no implementation". The net6.0 variant runs on the .NET runtime and
  // happily loads the SDK-style MSBuild from `dotnet\sdk\<ver>\MSBuild.dll`.
  // It needs a .NET 6+ runtime — `DOTNET_ROLL_FORWARD=Major` (set in
  // src-tauri/src/lsp.rs) lets the apphost roll forward to .NET 8 if 6
  // isn't installed.
  if (platform === "win32") {
    if (arch === "x64") return { name: `omnisharp-win-x64-net6.0.zip`, dirKey: "windows-x64", format: "zip", exe: "OmniSharp.exe" };
    if (arch === "arm64") return { name: `omnisharp-win-arm64-net6.0.zip`, dirKey: "windows-arm64", format: "zip", exe: "OmniSharp.exe" };
    if (arch === "ia32") return { name: `omnisharp-win-x86-net6.0.zip`, dirKey: "windows-x86", format: "zip", exe: "OmniSharp.exe" };
  }
  if (platform === "darwin") {
    if (arch === "x64") return { name: `omnisharp-osx-x64-net6.0.zip`, dirKey: "macos-x64", format: "zip", exe: "OmniSharp" };
    if (arch === "arm64") return { name: `omnisharp-osx-arm64-net6.0.zip`, dirKey: "macos-arm64", format: "zip", exe: "OmniSharp" };
  }
  if (platform === "linux") {
    if (arch === "x64") return { name: `omnisharp-linux-x64-net6.0.tar.gz`, dirKey: "linux-x64", format: "tar.gz", exe: "OmniSharp" };
    if (arch === "arm64") return { name: `omnisharp-linux-arm64-net6.0.tar.gz`, dirKey: "linux-arm64", format: "tar.gz", exe: "OmniSharp" };
  }
  throw new Error(`Unsupported platform/arch: ${platform}/${arch}`);
}

function request(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Locus managed OmniSharp bundler" } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        const location = response.headers.location;
        response.resume();
        if (!location) return reject(new Error(`redirect without location for ${url}`));
        request(new URL(location, url).toString()).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`request failed ${response.statusCode}: ${url}`));
      }
      resolve(response);
    });
    req.on("error", reject);
  });
}

async function download(url, destination) {
  const response = await request(url);
  const total = Number(response.headers["content-length"] || 0);
  let received = 0;
  let lastPct = -1;
  await new Promise((resolve, reject) => {
    const file = createWriteStream(destination);
    response.on("data", (chunk) => {
      received += chunk.length;
      if (total > 0) {
        const pct = Math.floor((received / total) * 100);
        if (pct !== lastPct && pct % 5 === 0) {
          process.stderr.write(`\r[locus] download ${pct}% (${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB)`);
          lastPct = pct;
        }
      }
    });
    response.pipe(file);
    file.on("finish", () => file.close(() => {
      process.stderr.write("\n");
      resolve();
    }));
    file.on("error", reject);
  });
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${argv.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function extract(archivePath, destDir, format) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  if (format === "zip") {
    if (process.platform === "win32") {
      // PowerShell ships everywhere on Win10+ and handles zip natively.
      run("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
      ]);
    } else {
      run("unzip", ["-q", "-o", archivePath, "-d", destDir]);
    }
  } else if (format === "tar.gz") {
    run("tar", ["-xzf", archivePath, "-C", destDir]);
  } else {
    throw new Error(`Unknown archive format: ${format}`);
  }
}

function verifyOmnisharp(exePath) {
  // OmniSharp prints help if invoked with no LSP flag but with `--help`.
  const result = spawnSync(exePath, ["--help"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`OmniSharp self-test failed: status=${result.status} stderr=${result.stderr ?? ""}`);
  }
}

function writeManifest(asset, version, exePath) {
  mkdirSync(outputRoot, { recursive: true });
  const rel = path.relative(outputRoot, exePath).replace(/\\/g, "/");
  writeFileSync(
    path.join(outputRoot, "manifest.json"),
    `${JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      omnisharpVersion: version,
      runtimes: [{ id: asset.dirKey, executable: rel, sourceArchive: asset.name }],
    }, null, 2)}\n`,
  );
}

async function main() {
  const asset = platformAsset();
  const url = `https://github.com/OmniSharp/omnisharp-roslyn/releases/download/${VERSION}/${asset.name}`;
  const archivePath = path.join(cacheDir, asset.name);
  const targetDir = path.join(outputRoot, asset.dirKey);

  mkdirSync(cacheDir, { recursive: true });
  if (!existsSync(archivePath)) {
    process.stderr.write(`[locus] Downloading OmniSharp ${VERSION} (${asset.name})...\n`);
    await download(url, archivePath);
  } else {
    process.stderr.write(`[locus] Using cached archive: ${path.relative(repoRoot, archivePath)}\n`);
  }

  process.stderr.write(`[locus] Extracting to ${path.relative(repoRoot, targetDir)}...\n`);
  extract(archivePath, targetDir, asset.format);

  const exePath = path.join(targetDir, asset.exe);
  if (!existsSync(exePath)) {
    throw new Error(`OmniSharp executable not found after extraction: ${exePath}`);
  }
  if (process.platform !== "win32") {
    chmodSync(exePath, 0o755);
  }
  verifyOmnisharp(exePath);
  writeManifest(asset, VERSION, exePath);

  process.stderr.write(`[locus] OmniSharp ready: ${exePath}\n`);

  if (runTest) {
    process.stderr.write(`[locus] Running cargo test omnisharp_handshake (this may take 30-60s)...\n`);
    const result = spawnSync(
      "cargo",
      ["test", "--test", "omnisharp_handshake", "--", "--ignored", "--nocapture"],
      {
        stdio: "inherit",
        cwd: path.join(repoRoot, "src-tauri"),
        env: { ...process.env, LOCUS_OMNISHARP_PATH: exePath },
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`cargo test failed with exit code ${result.status ?? "unknown"}`);
    }
  }

  // Last line of stdout = the absolute exe path (so callers can capture it).
  process.stdout.write(`${exePath}\n`);
}

main().catch((error) => {
  console.error(`\n[locus] Failed to prepare managed OmniSharp: ${error.stack ?? error.message ?? error}`);
  process.exit(1);
});
