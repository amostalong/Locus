// Custom file system provider for the `file://` scheme that serves
// content from monaco's already-opened models. Sidesteps the
// RegisteredFileSystemProvider's mkdirSync chain (which throws on
// Windows drive-letter paths) by not maintaining a directory tree at
// all — every URI we know about is whatever monaco currently has a
// model for.
//
// This is enough for the workspace text-file model manager
// (wordHighlighter, hover model resolution, peek definition preview,
// etc.) to find the buffer when it tries to "open" a file URI.

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

  watch(): Disposable {
    return { dispose() {} };
  }

  async stat(resource: monaco.Uri): Promise<IStat> {
    const model = monaco.editor.getModel(resource);
    if (!model) {
      throw FileSystemProviderError.create(
        "not found",
        FileSystemProviderErrorCode.FileNotFound,
      );
    }
    return {
      type: FileType.File,
      ctime: 0,
      mtime: model.getVersionId(),
      size: model.getValueLength(),
    };
  }

  async readFile(resource: monaco.Uri): Promise<Uint8Array> {
    const model = monaco.editor.getModel(resource);
    if (!model) {
      throw FileSystemProviderError.create(
        "not found",
        FileSystemProviderErrorCode.FileNotFound,
      );
    }
    return new TextEncoder().encode(model.getValue());
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
