import type * as monaco from "monaco-editor";

export type EnclosingKind = "function" | "class";

export interface EnclosingSymbol {
  kind: EnclosingKind;
  name: string;
  /** 1-based, inclusive. Line containing the opening brace. */
  startLine: number;
  /** 1-based, inclusive. Line containing the matching closing brace. */
  endLine: number;
}

export interface FoundEnclosing {
  function?: EnclosingSymbol;
  class?: EnclosingSymbol;
}

const SUPPORTED_LANGUAGES = new Set(["csharp", "typescript", "javascript"]);

const CLASS_PATTERNS: Record<string, RegExp> = {
  csharp: /\b(?:class|struct|interface|record|enum)\s+([A-Za-z_]\w*)/,
  typescript: /\b(?:class|interface|enum)\s+([A-Za-z_]\w*)/,
  javascript: /\bclass\s+([A-Za-z_]\w*)/,
};

const FUNCTION_PATTERNS: Record<string, RegExp[]> = {
  csharp: [
    // [modifier(s)] [return type] Name(...
    /(?:^|[\s;{}])(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|new|partial)\s+(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|new|partial|readonly|unsafe)\s+)*[A-Za-z_][\w<>,\[\]\?\s\.]*?\s+([A-Za-z_]\w*)\s*\(/,
  ],
  typescript: [
    /\bfunction\s*\*?\s+([A-Za-z_]\w*)\s*[<(]/,
    /(?:^|[\s;{},])([A-Za-z_]\w*)\s*[:=]\s*(?:async\s+)?(?:function\s*\*?\s*)?\(/,
    /(?:^|[\s;{}])(?:public|private|protected|static|async)\s+(?:(?:public|private|protected|static|async|readonly)\s+)*([A-Za-z_]\w*)\s*[<(]/,
  ],
  javascript: [
    /\bfunction\s*\*?\s+([A-Za-z_]\w*)\s*\(/,
    /(?:^|[\s;{},])([A-Za-z_]\w*)\s*[:=]\s*(?:async\s+)?(?:function\s*\*?\s*)?\(/,
    /(?:^|[\s;{}])(?:static|async)\s+(?:(?:static|async)\s+)*([A-Za-z_]\w*)\s*\(/,
  ],
};

const RESERVED_NAMES = new Set([
  "if", "for", "while", "switch", "do", "else", "return", "throw",
  "new", "using", "namespace", "lock", "unsafe", "fixed",
  "checked", "unchecked", "case", "catch", "finally", "try",
  "function", "class", "interface", "enum", "struct", "record",
  "extends", "implements", "var", "let", "const", "typeof", "instanceof",
  "in", "of", "yield", "await", "async", "static", "public", "private",
  "protected", "internal", "virtual", "override", "abstract", "sealed",
]);

/**
 * Strip strings and single-line comments from a line so brace matching and
 * declaration detection ignore them. Block comments and verbatim strings
 * spanning multiple lines are not handled — fine for a heuristic.
 */
function stripPerLine(text: string): string {
  let s = text.replace(/\/\/.*$/, "");
  // Double-quoted strings (with C#-style escapes).
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // Char/single-quoted strings.
  s = s.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  // Inline /* ... */ block comments (single line only).
  s = s.replace(/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g, "");
  return s;
}

function matchClass(line: string, language: string) {
  const re = CLASS_PATTERNS[language];
  if (!re) return null;
  const m = re.exec(line);
  if (!m) return null;
  return { kind: "class" as const, name: m[1] };
}

function matchFunction(line: string, language: string) {
  const list = FUNCTION_PATTERNS[language];
  if (!list) return null;
  for (const re of list) {
    const m = re.exec(line);
    if (m && m[1] && !RESERVED_NAMES.has(m[1])) {
      return { kind: "function" as const, name: m[1] };
    }
  }
  return null;
}

/**
 * Find the closest enclosing class and/or function around the given position.
 * Returns an object with optional fields — either or both may be missing.
 */
export function findEnclosing(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
): FoundEnclosing {
  const language = model.getLanguageId();
  if (!SUPPORTED_LANGUAGES.has(language)) return {};

  const found: FoundEnclosing = {};
  let depth = 0;

  outer: for (let line = position.lineNumber; line >= 1; line--) {
    const stripped = stripPerLine(model.getLineContent(line));
    const limit = line === position.lineNumber
      ? Math.min(position.column - 1, stripped.length)
      : stripped.length;
    for (let i = limit - 1; i >= 0; i--) {
      const c = stripped[i];
      if (c === "}") {
        depth++;
      } else if (c === "{") {
        if (depth === 0) {
          // This `{` opens our enclosing scope. Inspect this line + the
          // previous line for a class/function declaration.
          let decl =
            matchClass(stripped, language) ?? matchFunction(stripped, language);
          if (!decl && line > 1) {
            const prev = stripPerLine(model.getLineContent(line - 1));
            decl = matchClass(prev, language) ?? matchFunction(prev, language);
          }
          if (decl) {
            const endLine = findMatchingClose(model, line, i + 1);
            const symbol: EnclosingSymbol = {
              kind: decl.kind,
              name: decl.name,
              startLine: line,
              endLine,
            };
            if (decl.kind === "function" && !found.function) {
              found.function = symbol;
            } else if (decl.kind === "class" && !found.class) {
              found.class = symbol;
            }
            if (found.function && found.class) break outer;
          }
          // We've walked out of this brace pair; depth stays at 0 so the
          // next `{` we encounter will also be treated as enclosing.
        } else {
          depth--;
        }
      }
    }
  }
  return found;
}

function findMatchingClose(
  model: monaco.editor.ITextModel,
  openLine: number,
  openColumn: number,
): number {
  let depth = 0;
  const lineCount = model.getLineCount();
  for (let line = openLine; line <= lineCount; line++) {
    const stripped = stripPerLine(model.getLineContent(line));
    const start = line === openLine ? openColumn - 1 : 0;
    for (let i = start; i < stripped.length; i++) {
      const c = stripped[i];
      if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) return line;
      }
    }
  }
  return openLine;
}
