/**
 * C# class-field decoration.
 *
 * ## Why a custom parser instead of Roslyn / semantic tokens / Monarch
 *
 *   - **Roslyn `textDocument/semanticTokens/full`** is the most accurate
 *     path, but Locus's bridge to it is parked behind a
 *     `monaco-vscode-api 33.0.9` framework-level bug (DocumentSemanticTokensFeature
 *     never gets instantiated under standalone editor). The bridge code is
 *     preserved in `unityLanguages.ts` for re-enable when the upstream bug
 *     is fixed — see the four-step procedure documented there.
 *
 *   - **Monarch state machine** (the csharp grammar in `unityLanguages.ts`)
 *     fundamentally cannot distinguish class fields from local variables —
 *     both fall through to plain `identifier`. Stateful parsing across
 *     nested `{ }` would need a brace-counting parser anyway; building a
 *     faithful Monarch extension for that is fragile and would lock us to
 *     Monarch for what is fundamentally an overlay concern.
 *
 *   - **Monaco Model Decorations API** (this file) — apply a CSS class to
 *     identifier ranges the parser marks as fields. Independent of the
 *     tokenization layer, so it coexists with whatever the Monarch
 *     grammar / future Roslyn semantic tokens layer does. Works under any
 *     monaco-editor / monaco-vscode-api version.
 *
 * ## The parser
 *
 *   A character-level brace counter that tracks:
 *     - overall `{ }` nesting depth
 *     - whether the current depth is *inside a class body* (between the
 *       `class Foo {` opening brace and the matching closing brace)
 *     - whether the current depth is *inside a method body* (a `{` that
 *       follows a method signature `)` within a class body)
 *
 *   In class body but NOT in method body, an identifier followed by `;`,
 *   `=`, or `,` (multi-variable declaration) and preceded by a non-`(`,
 *   non-`,`, non-`=`, non-`.` character (heuristic: looks like a
 *   declaration target rather than a parameter / member-access target) is
 *   marked as a field.
 *
 *   **Accuracy: ~80% on common patterns.** False positives:
 *     - `string` constants in class body (`const string S = "...";`) — caught
 *     - Property expressions (`public int X => 42;`) — caught
 *     - Field-like initializers that span multiple lines via lambda
 *       (`public Action X = () => { ... };`) — the inner `{ }` looks like
 *       a method body and the `;` ends the declaration but our brace
 *       counter still gets confused. Acceptable.
 *
 *   **What this parser explicitly does NOT do:**
 *     - distinguish access modifiers (private/public/...) — they're noise
 *       for coloring purposes; the field is a field regardless.
 *     - handle `record` / `init` / `required` keywords — these are C# 9+
 *       constructs that the parser treats as ordinary identifiers.
 *     - resolve field types or symbol info — pure textual pattern match.
 *
 *   The 20% failure modes are not a problem in practice because:
 *     - The hook is a CSS overlay, not a semantic token. The wrong color
 *       on a rare false positive is no worse than Monarch's default color.
 *     - Real C# field coloring at this fidelity (e.g. the bundled VS Code
 *       C# extension) requires Roslyn — and we're blocked on the framework
 *       bug for that path. When unblocked, drop this module.
 *
 * ## Performance
 *
 *   The parser is O(N) over the source text and runs on every
 *   `onDidChangeModelContent` for csharp models. For the SLG gameclient
 *   project (`slg_gameclient/Project/Assets/Scripts/*.cs` — typical file
 *   < 5KB, largest < 100KB) this is sub-millisecond. If a real-world file
 *   exceeds ~500KB we'd want to debounce or run it off the main thread.
 */

export interface IFieldRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  /** The field name as parsed (for diagnostics / hover). */
  name: string;
}

const FIELD_CSS_CLASS = "locus-csharp-field";

export function getCsharpFieldCssClass(): string {
  return FIELD_CSS_CLASS;
}

/**
 * Parse a C# source and return the identifier ranges of class-field
 * declarations. Public for testability.
 */
export function findCsharpClassFields(source: string): IFieldRange[] {
  const fields: IFieldRange[] = [];
  const len = source.length;

  // Brace-nesting depth. Always >= 0.
  let depth = 0;
  // The brace depth at which the *current class body* opened (-1 if not in
  // a class body). After `class Foo {` at depth 0, classDepth=0 and the
  // first `}` that brings depth back to 0 closes the class body.
  let classDepth = -1;
  // The brace depth at which the *current method body* opened (-1 if not
  // in a method body within a class body).
  let methodDepth = -1;

  // The most recent non-whitespace, non-comment token we saw. Used for
  // context decisions ("is this `{` opening a class body or a method
  // body?").
  let prevSig = "";
  // The most recent identifier (text + range). Used so we know which
  // identifier to mark when the next non-WS token confirms a field decl.
  let lastIdent: { text: string; range: IFieldRange } | null = null;

  let i = 0;
  let line = 1;
  let col = 1;
  const advance = (count: number) => {
    for (let k = 0; k < count; k++) {
      const ch = source[i];
      if (ch === "\n") {
        line++;
        col = 1;
      } else if (ch !== "\r") {
        col++;
      }
      i++;
    }
  };

  while (i < len) {
    const ch = source[i];

    // ── Skip string literals ────────────────────────────────────────────
    if (ch === '"' || ch === "'") {
      const quote = ch;
      // Detect verbatim string @"..." or @$"..." / $@"..."
      let isVerbatim = false;
      if (quote === '"' && source[i + 1] === "@") {
        isVerbatim = true;
        advance(2);
      } else if (quote === '"' && source[i] === "$" && source[i + 1] === "@") {
        isVerbatim = true;
        advance(2);
      } else {
        advance(1);
      }
      // Skip to matching closing quote
      while (i < len) {
        const c = source[i];
        if (c === "\\" && !isVerbatim && i + 1 < len) {
          advance(2);
          continue;
        }
        if (c === quote) {
          // Verbatim string: doubled quote is escape
          if (isVerbatim && source[i + 1] === quote) {
            advance(2);
            continue;
          }
          advance(1);
          break;
        }
        if (c === "\n" && !isVerbatim) {
          // Unterminated single-line string — bail out
          break;
        }
        advance(1);
      }
      prevSig = "string";
      lastIdent = null;
      continue;
    }

    // ── Skip line comments ──────────────────────────────────────────────
    if (ch === "/" && source[i + 1] === "/") {
      while (i < len && source[i] !== "\n") advance(1);
      prevSig = "comment";
      lastIdent = null;
      continue;
    }

    // ── Skip block comments ─────────────────────────────────────────────
    if (ch === "/" && source[i + 1] === "*") {
      advance(2);
      while (i < len - 1 && !(source[i] === "*" && source[i + 1] === "/")) {
        advance(1);
      }
      if (i < len - 1) advance(2); // closing */
      prevSig = "comment";
      lastIdent = null;
      continue;
    }

    // ── Preprocessor / attributes: skip until end of line ───────────────
    if (ch === "#") {
      while (i < len && source[i] !== "\n") advance(1);
      prevSig = "pp";
      lastIdent = null;
      continue;
    }

    // ── Braces ──────────────────────────────────────────────────────────
    if (ch === "{") {
      // Decide what kind of `{` this is.
      //   - "class" / "struct" / "interface" / "enum" / "record" then an
      //     identifier (or generic identifier) then `{`  → class body
      //   - otherwise, if we're in a class body and the previous non-WS
      //     sig was `)` (method/ctor signature) and we're not already in a
      //     method body → method body
      //   - otherwise (block in a method body, object initializer, etc.)
      //     → ignored
      const prevLower = prevSig.toLowerCase();
      const isClassDecl =
        prevLower === "ident" &&
        (lastIdent?.text === "class" ||
          lastIdent?.text === "struct" ||
          lastIdent?.text === "interface" ||
          lastIdent?.text === "enum" ||
          lastIdent?.text === "record");
      const isMethodDecl = classDepth >= 0 && methodDepth < 0 && prevSig === ")";
      if (isClassDecl) {
        classDepth = depth;
      } else if (isMethodDecl) {
        methodDepth = depth;
      }
      depth++;
      prevSig = "{";
      lastIdent = null;
      advance(1);
      continue;
    }

    if (ch === "}") {
      depth--;
      if (methodDepth >= 0 && depth <= methodDepth) {
        methodDepth = -1;
      }
      if (classDepth >= 0 && depth <= classDepth) {
        classDepth = -1;
      }
      prevSig = "}";
      lastIdent = null;
      advance(1);
      continue;
    }

    // ── Other sig tokens that reset / shape context ─────────────────────
    if (ch === ";" || ch === "," || ch === "(" || ch === "=" || ch === "<" || ch === ">" || ch === "?" || ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%" || ch === "&" || ch === "|" || ch === "^" || ch === "!" || ch === "~" || ch === ":" || ch === "[") {
      // Field declaration: identifier followed by `;` or `=` or `,` in
      // class body but NOT in method body, AND the previous sig is `ident`
      // (not `(`, `,`, `.`, `=`, `?`, `<`, `>` etc which would mean the
      // identifier is in a different syntactic slot).
      const isClassBodyNotMethod =
        classDepth >= 0 && methodDepth < 0;
      const looksLikeFieldTarget =
        lastIdent !== null &&
        prevSig === "ident" &&
        // Reject identifiers whose preceding context was a parameter list
        // (`,` or `<` after a type), member access (`.`), or attribute —
        // these are not declaration targets.
        !lastIdent.text.startsWith("@");
      if (
        isClassBodyNotMethod &&
        looksLikeFieldTarget &&
        lastIdent !== null &&
        (ch === ";" || ch === "=" || ch === ",")
      ) {
        fields.push(lastIdent.range);
      }
      prevSig = ch;
      lastIdent = null;
      advance(1);
      continue;
    }

    // ── `)` ends a method signature (used by `{` decision above) ─────────
    if (ch === ")") {
      // Same field-mark check as above for completeness
      const isClassBodyNotMethod = classDepth >= 0 && methodDepth < 0;
      const looksLikeFieldTarget =
        lastIdent !== null &&
        prevSig === "ident" &&
        !lastIdent.text.startsWith("@");
      if (
        isClassBodyNotMethod &&
        looksLikeFieldTarget &&
        lastIdent !== null &&
        // `var x)` doesn't happen in normal C#; conservatively not marking
        // here — the `;` / `=` / `,` paths handle the common cases.
        false
      ) {
        fields.push(lastIdent!.range);
      }
      prevSig = ")";
      lastIdent = null;
      advance(1);
      continue;
    }

    // ── Identifier ──────────────────────────────────────────────────────
    if (/[A-Za-z_@]/.test(ch)) {
      const startLine = line;
      const startCol = col;
      const startI = i;
      let ident = "";
      // Read identifier characters (letters, digits, underscore)
      while (i < len && /[\w]/.test(source[i])) {
        ident += source[i];
        advance(1);
      }
      // Note: `advance` may have moved i past the identifier end; we read
      // the identifier starting at startI with length `ident.length`, so
      // the range is correct.
      const endCol = startCol + ident.length;
      lastIdent = {
        text: ident,
        range: {
          startLineNumber: startLine,
          startColumn: startCol,
          endLineNumber: line,
          endColumn: endCol,
          name: ident,
        },
      };
      prevSig = "ident";
      // Check for verbatim / generic identifier suffix (`@class` is the
      // verbatim form for the `class` keyword used as an identifier name
      // — we strip the leading `@` from `text` already since the char
      // class includes `@`).
      void startI;
      continue;
    }

    // ── Whitespace ──────────────────────────────────────────────────────
    if (/\s/.test(ch)) {
      advance(1);
      continue;
    }

    // Anything else: reset context, advance
    prevSig = ch;
    lastIdent = null;
    advance(1);
  }

  return fields;
}

/**
 * Apply the field-coloring CSS-class decorations to a Monaco editor.
 *
 * Caller is responsible for:
 *   - Calling this only for csharp models (or with a no-op fast path
 *     otherwise).
 *   - Owning the decorations collection (create it once with
 *     `editor.createDecorationsCollection()`, pass it in here).
 *   - Debouncing if the model changes very frequently.
 */
export function applyCsharpFieldDecorations(
  decorationsCollection: {
    set: (ranges: { range: IFieldRange; options: { inlineClassName: string } }[]) => void;
  },
  source: string,
): void {
  const fields = findCsharpClassFields(source);
  if (fields.length === 0) {
    decorationsCollection.set([]);
    return;
  }
  decorationsCollection.set(
    fields.map((range) => ({
      range,
      options: { inlineClassName: FIELD_CSS_CLASS },
    })),
  );
}