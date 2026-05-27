#!/usr/bin/env node
// End-to-end LSP probe for OmniSharp.
//
// Spawns OmniSharp the same way src-tauri/src/lsp.rs does (same env scrub,
// same DOTNET_ROLL_FORWARD), drives it through initialize -> didOpen ->
// hover for a real .cs file in the workspace, and streams stdout/stderr to
// fixed files so the bat wrapper can grep them. The previous PowerShell
// probe was hitting Windows anonymous-pipe back-pressure (~4 KiB) and
// blocking OmniSharp; node's stream API doesn't have that problem.
//
// Usage:
//   node scripts/diagnose-omnisharp-probe.mjs <exe> <workspace> <stdoutLog> <stderrLog>

import { spawn } from "node:child_process";
import { createWriteStream, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const [, , exe, workspace, stdoutLog, stderrLog] = process.argv;
if (!exe || !workspace || !stdoutLog || !stderrLog) {
  console.error("usage: probe.mjs <exe> <workspace> <stdoutLog> <stderrLog>");
  process.exit(2);
}

function findCsFile(dir, depth = 0) {
  if (depth > 8) return null;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  // Prefer files at this level before recursing — Unity tends to put
  // shallow scripts directly under Assets/Scripts.
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".cs")) {
      return path.join(dir, e.name);
    }
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "Library" || e.name === "Temp" || e.name === "obj" || e.name === "bin") continue;
    const hit = findCsFile(path.join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

const preferred = [path.join(workspace, "Assets", "Scripts"), path.join(workspace, "Assets"), workspace];
let csFile = null;
for (const root of preferred) {
  try { statSync(root); } catch { continue; }
  csFile = findCsFile(root);
  if (csFile) break;
}
if (!csFile) {
  console.error(`no .cs file found under ${workspace}`);
  process.exit(3);
}
console.log(`probe target: ${csFile}`);
const csText = readFileSync(csFile, "utf8");
const csUri = "file:///" + csFile.replace(/\\/g, "/");
const rootUri = "file:///" + workspace.replace(/\\/g, "/");

// Mirror lsp.rs:124-141 env handling.
const env = { ...process.env };
for (const k of [
  "MSBUILD_EXE_PATH", "MSBuildExtensionsPath", "MSBuildExtensionsPath32",
  "MSBuildExtensionsPath64", "MSBuildSDKsPath", "MSBuildToolsPath",
  "MSBuildToolsPath32", "MSBuildToolsPath64", "VSINSTALLDIR", "VCINSTALLDIR",
  "VisualStudioVersion",
]) delete env[k];
env.DOTNET_ROLL_FORWARD = "Major";

const child = spawn(exe, ["-lsp", "-s", workspace], {
  env,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});

const stdoutFile = createWriteStream(stdoutLog);
const stderrFile = createWriteStream(stderrLog);
child.stdout.pipe(stdoutFile);
child.stderr.pipe(stderrFile);

// Track interesting log lines from the stdout stream so we can summarize.
const counters = { queued: 0, finished: 0, errors: 0, hoverResponses: 0 };
let hoverResponseSamples = [];
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  // Cheap line-ish scan; we don't need full LSP framing parsing for the
  // counters since the JSON bodies fit on one logical line.
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.includes("Queue project update for")) counters.queued++;
    if (line.includes("Successfully loaded project") || line.includes("Completing project load")) counters.finished++;
    if (line.includes('"method":"o#/error"')) counters.errors++;
    const m = line.match(/"id":(10[0-3])\b[^}]*"result":(.+?)(?:,"jsonrpc"|}$)/);
    if (m) {
      counters.hoverResponses++;
      if (hoverResponseSamples.length < 5) hoverResponseSamples.push(`id=${m[1]} -> ${m[2].slice(0, 400)}`);
    }
  }
});

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  child.stdin.write(header);
  child.stdin.write(body);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  send({
    jsonrpc: "2.0", id: 0, method: "initialize",
    params: {
      processId: process.pid,
      clientInfo: { name: "locus-diag" },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "diag" }],
      capabilities: { textDocument: { hover: { contentFormat: ["markdown", "plaintext"] } } },
    },
  });
  send({ jsonrpc: "2.0", method: "initialized", params: {} });
  send({
    jsonrpc: "2.0", method: "textDocument/didOpen",
    params: {
      textDocument: { uri: csUri, languageId: "csharp", version: 1, text: csText },
    },
  });

  const loadSeconds = 90;
  console.log(`waiting ${loadSeconds}s for project load (queued so far updates live)...`);
  for (let i = 0; i < loadSeconds; i++) {
    await sleep(1000);
    if (i % 10 === 9) {
      console.log(`  t=${i + 1}s queued=${counters.queued} finished=${counters.finished} errors=${counters.errors}`);
    }
  }

  // Send a few hover requests at heuristic positions — at least one of them
  // is likely to land on a symbol that has a hover.
  const probes = [
    { line: 10, character: 10 }, { line: 20, character: 10 },
    { line: 5,  character: 5  }, { line: 2,  character: 4  },
  ];
  let id = 100;
  for (const position of probes) {
    send({
      jsonrpc: "2.0", id, method: "textDocument/hover",
      params: { textDocument: { uri: csUri }, position },
    });
    id++;
  }

  await sleep(5000);

  // Graceful shutdown so OmniSharp flushes everything.
  send({ jsonrpc: "2.0", id: 999, method: "shutdown", params: null });
  send({ jsonrpc: "2.0", method: "exit", params: null });

  const exited = new Promise((r) => child.on("exit", r));
  const timeout = sleep(5000).then(() => "timeout");
  const reason = await Promise.race([exited.then(() => "exit"), timeout]);
  if (reason === "timeout") {
    try { child.kill(); } catch {}
  }

  stdoutFile.end();
  stderrFile.end();
  await new Promise((r) => stdoutFile.on("close", r));

  console.log(`done queued=${counters.queued} finished=${counters.finished} errors=${counters.errors} hoverResponses=${counters.hoverResponses}`);
  for (const s of hoverResponseSamples) console.log(`  ${s}`);
})().catch((err) => {
  console.error("probe failed:", err);
  try { child.kill(); } catch {}
  process.exit(1);
});
