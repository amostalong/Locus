// Custom file system provider for the `file://` scheme that serves
// content from monaco's already-opened models, with a fallback to
// reading from disk (via Tauri IPC) when the file hasn't been opened.
//
// This mirrors VS Code's FileService behavior: when Go to Definition,
// peek, or hover needs file content that isn't loaded, it reads from
// the OS filesystem instead of failing.

import * as monaco from "monaco-editor";
import {
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileType,
  type IFileChange,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IStat,
} from "@codingame/monaco-vscode-files-service-override";

import { editorReadFile } from "./editorFs";

type Listener<T> = (e: T) => unknown;
type Disposable = { dispose(): void };

class TrivialEmitter<T> {
  private listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
}

export class ModelBackedFileSystemProvider
  implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities: FileSystemProviderCapabilities =
    FileSystemProviderCapabilities.FileReadWrite;

  private readonly _capChanges = new TrivialEmitter<void>();
  readonly onDidChangeCapabilities = this._capChanges.event;

  private readonly _fileChanges = new TrivialEmitter<readonly IFileChange[]>();
  readonly onDidChangeFile = this._fileChanges.event;

  private _workspaceRoot = "";

  // OmniSharp metadata fetcher — set when LSP is ready.
  // Called with the raw fsPath (e.g. \$metadata$\Project\...) when Monaco
  // tries to open a decompiled Unity/framework symbol file.
  private _metadataFetcher: ((path: string) => Promise<string>) | null = null;
  private readonly _metadataCache = new Map<string, Uint8Array>();
  // URIs of Monaco models created as empty placeholders before LSP was ready.
  private readonly _placeholderUris = new Set<string>();

  setMetadataFetcher(fn: (path: string) => Promise<string>): void {
    this._metadataFetcher = fn;
    // Dispose any empty models created before LSP was ready so the next
    // Go-to-Definition re-fetches the real decompiled source.
    this._metadataCache.clear();
    for (const uriStr of this._placeholderUris) {
      monaco.editor.getModel(monaco.Uri.parse(uriStr))?.dispose();
    }
    this._placeholderUris.clear();
  }

  private isMetadataPath(resource: monaco.Uri): boolean {
    return resource.fsPath.includes("$metadata$");
  }

  private async fetchMetadata(resource: monaco.Uri): Promise<Uint8Array> {
    const key = resource.fsPath;
    const cached = this._metadataCache.get(key);
    if (cached) return cached;

    if (!this._metadataFetcher) {
      // LSP not ready yet — return empty placeholder instead of throwing.
      // Throwing here causes an unhandled rejection in Monaco's model resolver.
      // Track the URI so setMetadataFetcher() can dispose the empty model later.
      console.warn(`[fsProvider] fetchMetadata: LSP not ready for ${key}`);
      this._placeholderUris.add(resource.toString());
      return new Uint8Array(0);
    }

    try {
      // Pass the full URI string so the fetcher can extract the path in the
      // format OmniSharp expects (forward slashes, URL-encoded chars like %60).
      const source = await this._metadataFetcher(resource.toString());
      const bytes = new TextEncoder().encode(source);
      this._metadataCache.set(key, bytes);
      // Pre-create a Monaco model so subsequent hover/codeLens reads hit the
      // model cache instead of making another LSP round-trip.
      if (!monaco.editor.getModel(resource)) {
        monaco.editor.createModel(source, "csharp", resource);
      }
      return bytes;
    } catch (err) {
      console.warn(`[fsProvider] fetchMetadata failed for ${key}:`, err);
      // Don't throw — throwing from readFile() causes an unhandled rejection in
      // Monaco's model resolver (same reason we return empty bytes when LSP is
      // not ready). Return a comment placeholder so the editor opens without crashing.
      const placeholder = new TextEncoder().encode(`// Source unavailable: ${key}\n`);
      this._placeholderUris.add(resource.toString());
      return placeholder;
    }
  }

  /** Set the workspace root so the provider can read disk files by relative path. */
  setWorkspaceRoot(root: string): void {
    this._workspaceRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  private async readFromDisk(resource: monaco.Uri): Promise<Uint8Array> {
    if (!this._workspaceRoot) {
      console.warn(`[fsProvider] readFromDisk: no workspace root set, resource=${resource.toString()}`);
      throw FileSystemProviderError.create(
        "workspace root not set",
        FileSystemProviderErrorCode.FileNotFound,
      );
    }
    const uriPath = resource.fsPath.replace(/\\/g, "/");
    const root = this._workspaceRoot;
    // 大小写不敏感比较 (Windows)
    if (uriPath.length < root.length ||
        uriPath.slice(0, root.length).toLowerCase() !== root.toLowerCase()) {
      console.warn(`[fsProvider] readFromDisk: path mismatch! uriPrefix="${uriPath.slice(0, root.length)}", root="${root}"`);
      throw FileSystemProviderError.create(
        "not found (outside workspace)",
        FileSystemProviderErrorCode.FileNotFound,
      );
    }
    const relPath = uriPath.slice(root.length + 1);
    try {
      const t0 = performance.now();
      const file = await editorReadFile(relPath);
      const elapsed = (performance.now() - t0).toFixed(0);
      console.log(`[fsProvider] readFromDisk: editorReadFile OK in ${elapsed}ms, size=${file.size}`);
      return new TextEncoder().encode(file.content);
    } catch (err) {
      console.warn(`[fsProvider] readFromDisk: editorReadFile FAILED:`, err);
      throw FileSystemProviderError.create(
        "failed to read from disk",
        FileSystemProviderErrorCode.FileNotFound,
      );
    }
  }

  watch(): Disposable {
    return { dispose() {} };
  }

  async stat(resource: monaco.Uri): Promise<IStat> {
    const model = monaco.editor.getModel(resource);
    if (model) {
      console.log(`[fsProvider] stat from model: ${resource.fsPath}`);
      return {
        type: FileType.File,
        ctime: 0,
        mtime: model.getVersionId(),
        size: model.getValueLength(),
      };
    }
    if (this.isMetadataPath(resource)) {
      console.log(`[fsProvider] stat metadata: ${resource.fsPath}`);
      const raw = await this.fetchMetadata(resource);
      return { type: FileType.File, ctime: 0, mtime: 0, size: raw.length };
    }
    console.log(`[fsProvider] stat from disk: ${resource.fsPath}`);
    const raw = await this.readFromDisk(resource);
    console.log(`[fsProvider] stat from disk OK: ${resource.fsPath}, size=${raw.length}`);
    return {
      type: FileType.File,
      ctime: 0,
      mtime: 0,
      size: raw.length,
    };
  }

  async readFile(resource: monaco.Uri): Promise<Uint8Array> {
    const model = monaco.editor.getModel(resource);
    if (model) {
      console.log(`[fsProvider] readFile from model: ${resource.fsPath}`);
      return new TextEncoder().encode(model.getValue());
    }
    if (this.isMetadataPath(resource)) {
      console.log(`[fsProvider] readFile metadata: ${resource.fsPath}`);
      return this.fetchMetadata(resource);
    }
    console.log(`[fsProvider] readFile from disk: ${resource.fsPath}`);
    return this.readFromDisk(resource);
  }

  async writeFile(): Promise<void> {
    // Saves are handled via Tauri's editor_write_file in the editor store.
    // No-op here so monaco's "save" path doesn't error.
  }

  async mkdir(): Promise<void> {}
  async readdir(): Promise<[string, FileType][]> {
    return [];
  }
  async delete(): Promise<void> {}
  async rename(): Promise<void> {}
}

// ── VS Code 风格的 openTextDocument ──────────────────────────────────────
// 对应 vscode.workspace.openTextDocument(uri):
//   1. 已有 model → 直接返回
//   2. 未打开 → 从磁盘读取内容 → createModel → 返回
let _openRoot = "";
export function setOpenRoot(root: string): void {
  _openRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
}

export async function openTextDocument(uri: monaco.Uri): Promise<monaco.editor.ITextModel> {
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;

  if (!_openRoot) {
    throw new Error("openTextDocument: workspace root not set");
  }
  const uriPath = uri.fsPath.replace(/\\/g, "/");
  if (uriPath.length < _openRoot.length ||
      uriPath.slice(0, _openRoot.length).toLowerCase() !== _openRoot.toLowerCase()) {
    throw new Error(`openTextDocument: file outside workspace: ${uri.fsPath}`);
  }
  const relPath = uriPath.slice(_openRoot.length + 1);
  const file = await editorReadFile(relPath);
  const { languageFromPath } = await import("./editorLanguage");
  const model = monaco.editor.createModel(file.content, languageFromPath(relPath), uri);
  return model;
}
