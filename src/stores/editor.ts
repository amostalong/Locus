import { computed, markRaw, ref } from "vue";
import { defineStore } from "pinia";
import * as monaco from "monaco-editor";

import {
  editorReadFile,
  editorWriteFile,
  type EditorLineEnding,
} from "../services/editorFs";
import { languageFromPath } from "../services/editorLanguage";

export interface OpenFile {
  id: string;
  relPath: string;
  language: string;
  isDirty: boolean;
  lineEnding: EditorLineEnding;
  hadBom: boolean;
  originalContent: string;
  model: monaco.editor.ITextModel;
}

export const useEditorStore = defineStore("editor", () => {
  const openFiles = ref<OpenFile[]>([]);
  const activeFileId = ref<string | null>(null);

  const active = computed<OpenFile | null>(
    () => openFiles.value.find((f) => f.id === activeFileId.value) ?? null,
  );
  const dirtyCount = computed(() => openFiles.value.filter((f) => f.isDirty).length);

  function findIndex(id: string): number {
    return openFiles.value.findIndex((f) => f.id === id);
  }

  async function openFile(relPath: string): Promise<OpenFile> {
    const id = relPath;
    const existing = openFiles.value.find((f) => f.id === id);
    if (existing) {
      activeFileId.value = id;
      return existing;
    }

    const file = await editorReadFile(relPath);
    const language = languageFromPath(relPath);
    const model = markRaw(monaco.editor.createModel(file.content, language));

    const entry: OpenFile = {
      id,
      relPath,
      language,
      isDirty: false,
      lineEnding: file.lineEnding,
      hadBom: file.hadBom,
      originalContent: file.content,
      model,
    };

    model.onDidChangeContent(() => {
      const cur = openFiles.value.find((f) => f.id === id);
      if (!cur) return;
      const dirty = model.getValue() !== cur.originalContent;
      if (dirty !== cur.isDirty) cur.isDirty = dirty;
    });

    openFiles.value.push(entry);
    activeFileId.value = id;
    return entry;
  }

  function setActive(id: string) {
    if (findIndex(id) >= 0) activeFileId.value = id;
  }

  function closeFile(id: string) {
    const idx = findIndex(id);
    if (idx < 0) return;
    const [removed] = openFiles.value.splice(idx, 1);
    removed.model.dispose();
    if (activeFileId.value === id) {
      const next = openFiles.value[Math.min(idx, openFiles.value.length - 1)];
      activeFileId.value = next ? next.id : null;
    }
  }

  async function saveFile(id: string): Promise<void> {
    const file = openFiles.value.find((f) => f.id === id);
    if (!file || !file.isDirty) return;
    const content = file.model.getValue();
    await editorWriteFile({
      subPath: file.relPath,
      content,
      lineEnding: file.lineEnding,
      hadBom: file.hadBom,
    });
    file.originalContent = content;
    file.isDirty = false;
  }

  async function saveAll(): Promise<void> {
    for (const file of openFiles.value) {
      if (file.isDirty) {
        await saveFile(file.id);
      }
    }
  }

  function disposeAll() {
    for (const file of openFiles.value) {
      file.model.dispose();
    }
    openFiles.value = [];
    activeFileId.value = null;
  }

  return {
    openFiles,
    activeFileId,
    active,
    dirtyCount,
    openFile,
    closeFile,
    saveFile,
    saveAll,
    setActive,
    disposeAll,
  };
});
