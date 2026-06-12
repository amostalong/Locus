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

export function editorWriteFile(input: EditorWriteInput): Promise<void> {
  return ipcInvoke<void>("editor_write_file", {
    subPath: input.subPath,
    content: input.content,
    lineEnding: input.lineEnding,
    hadBom: input.hadBom,
  });
}
