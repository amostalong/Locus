import { ipcInvoke } from "./ipc";

export type EditorLineEnding = "lf" | "crlf";

export interface EditorFile {
  content: string;
  lineEnding: EditorLineEnding;
  hadBom: boolean;
  size: number;
}

export interface EditorWriteInput {
  subPath: string;
  content: string;
  lineEnding: EditorLineEnding;
  hadBom: boolean;
}

export function editorReadFile(subPath: string): Promise<EditorFile> {
  return ipcInvoke<EditorFile>("editor_read_file", { subPath });
}

/**
 * Read an absolute file path with no workspace-relative constraint.
 * Used for decompiled sources Roslyn materializes under
 * `%TEMP%\MetadataAsSource\…\Type.cs` — those are not part of the
 * workspace but the editor still wants to render them as read-only
 * peek tabs.
 */
export function editorReadFileAbs(absolutePath: string): Promise<EditorFile> {
  return ipcInvoke<EditorFile>("editor_read_file_abs", { absolutePath });
}

export function editorWriteFile(input: EditorWriteInput): Promise<void> {
  return ipcInvoke<void>("editor_write_file", {
    subPath: input.subPath,
    content: input.content,
    lineEnding: input.lineEnding,
    hadBom: input.hadBom,
  });
}
