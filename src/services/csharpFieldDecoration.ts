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
 *     - a stack of currently-open class bodies, each with the set of
 *       field names declared inside it (so method-body references to
 *       those fields can be colored too)
 *     - whether the current depth is *inside a method body* (a `{` that
 *       follows a method signature `)` within a class body)
 *
 *   Two kinds of range are emitted:
 *
 *     - **Declaration** — class body, not method body, identifier
 *       followed by `;` / `=` / `,` (multi-variable declaration) and
 *       preceded by a non-`(`, non-`,`, non-`=`, non-`.` character
 *       (heuristic: looks like a declaration target rather than a
 *       parameter / member-access target). The name is also recorded
 *       in the enclosing class scope's field set.
 *
 *     - **Reference** — inside any method body, any identifier whose
 *       text matches a name in the current or any enclosing class
 *       scope's field set.
 *
 *   **Accuracy on declarations: ~80%** (unchanged). Failure modes:
 *     - `const string S = "...";` — fields like this get marked
 *       (the parser doesn't know `const` is special).
 *     - Property expressions (`public int X => 42;`) — get marked
 *       as fields (a property, technically not a field).
 *     - Field-like initializers that span multiple lines via lambda
 *       (`public Action X = () => { ... };`) — the inner `{ }` looks
 *       like a method body and the parser gets confused. Acceptable.
 *
 *   **Accuracy on references: high** for code following the C# naming
 *     convention (fields prefixed with `_` or `m_` or `s_`, locals
 *     camelCase or PascalCase). If a method declares a local whose
 *     name happens to match a field, the local references are still
 *     marked as fields — the parser does not track local symbols.
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
 * declarations AND field references inside method bodies. Public for
 * testability.
 *
 * Two-phase logic in a single pass:
 *
 *   - **Declaration** (class body, not method body, ident followed by
 *     `;` / `=` / `,`): mark the ident's range as a field and record
 *     the name in the enclosing class scope's field set.
 *
 *   - **Reference** (inside any method body, ident matches a name in
 *     the current or any enclosing class scope's field set): mark the
 *     ident's range.
 *
 *   - **Cross-scope lookup**: a method inside an inner class can see
 *     outer-class fields; we walk the class-scope stack from inner to
 *     outer and stop at the first match.
 *
 *   - **Local-variable shadowing**: if a method body declares a local
 *     whose name happens to match a field, the local references are
 *     still marked as fields (the parser does not track local symbols).
 *     In practice this is rare — C# convention uses leading `_` on
 *     fields — and the visual cost of a false positive is small (a few
 *     extra identifiers painted indigo that may be locals). The Monaco
 *     semantic-token bridge, when unblocked, will resolve this.
 */
export function findCsharpClassFields(source: string): IFieldRange[] {
  const fields: IFieldRange[] = [];
  const len = source.length;

  // Brace-nesting depth. Always >= 0.
  let depth = 0;
  // Parenthesis nesting depth. Used to suppress field-declaration
  // detection inside `(` ... `)` — method signatures (`void M(int x)`)
  // and function-call argument lists (`Foo(a, b)`) both contain
  // comma-separated identifiers that look like multi-variable
  // declarations to a naive parser, but neither is a field declaration
  // site. Anything that happens with parenDepth > 0 is therefore
  // excluded from declaration marking AND from being added to a
  // class's field name set.
  let parenDepth = 0;
  // Stack of currently-open class bodies, innermost last. Each entry
  // remembers the brace depth at which the class body opened (so we
  // know when its closing `}` arrives) and the set of field names
  // declared inside it (so we can highlight references to those fields
  // in method bodies of this class and any nested class).
  const classScopeStack: { classDepth: number; fields: Set<string> }[] = [];
  // The brace depth at which the *current method body* opened (-1 if
  // not in a method body within a class body).
  let methodDepth = -1;
  // Convenience: are we currently inside a method body that's nested
  // inside at least one class body?
  const inMethodBody = () => methodDepth >= 0 && classScopeStack.length > 0;
  // Convenience: are we currently in a class body but not in any
  // method body (i.e. the field-declaration zone)?
  const inClassBodyNotMethod = () =>
    classScopeStack.length > 0 &&
    (methodDepth < 0 ||
      methodDepth <= classScopeStack[classScopeStack.length - 1].classDepth);

  // The most recent non-whitespace, non-comment token we saw. Used for
  // context decisions ("is this `{` opening a class body or a method
  // body?").
  let prevSig = "";
  // The most recent identifier (text + range). Used so we know which
  // identifier to mark when the next non-WS token confirms a field decl.
  let lastIdent: { text: string; range: IFieldRange } | null = null;
  // True if we have seen a class-keyword (class/struct/interface/enum/
  // record) since the last statement boundary. Set when we see such an
  // identifier, reset by `;` / `{` / `}`. We need this — not
  // `lastIdent.text === "class"` — because the *immediate* identifier
  // before the opening `{` of a class body is the class name (or the
  // base-type identifier in a `class X : Y {` declaration), not the
  // `class` keyword itself.
  let classKeywordPending = false;

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
      //   - We saw a class/struct/interface/enum/record keyword since the
      //     last statement boundary → class body
      //   - otherwise, if we're in a class body and the previous non-WS
      //     sig was `)` (method/ctor signature) and we're not already in a
      //     method body → method body
      //   - otherwise (block in a method body, object initializer, etc.)
      //     → ignored
      //
      // Note: the immediate ident before `{` is the class *name* (or the
      // base-type ident in `class X : Y {`), not the `class` keyword. We
      // therefore track the class keyword via a separate flag set when
      // the keyword identifier is scanned and reset by `;` / `{` / `}`.
      const isClassDecl = classKeywordPending;
      const isMethodDecl =
        classScopeStack.length > 0 && methodDepth < 0 && prevSig === ")";
      if (isClassDecl) {
        classScopeStack.push({ classDepth: depth, fields: new Set() });
      } else if (isMethodDecl) {
        methodDepth = depth;
      }
      classKeywordPending = false;
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
      // Pop class scopes whose closing `}` we just walked past.
      while (
        classScopeStack.length > 0 &&
        depth <= classScopeStack[classScopeStack.length - 1].classDepth
      ) {
        classScopeStack.pop();
      }
      classKeywordPending = false;
      prevSig = "}";
      lastIdent = null;
      advance(1);
      continue;
    }

    // ── Other sig tokens that reset / shape context ─────────────────────
    if (ch === ";" || ch === "," || ch === "(" || ch === "=" || ch === "<" || ch === ">" || ch === "?" || ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%" || ch === "&" || ch === "|" || ch === "^" || ch === "!" || ch === "~" || ch === ":" || ch === "[") {
      // Track parenthesis depth so the declaration check below can
      // exclude method signatures / call argument lists.
      if (ch === "(") {
        parenDepth++;
      }
      // Field declaration: identifier followed by `;` or `=` or `,` in
      // class body but NOT in method body, NOT inside any `(...)` group,
      // AND the previous sig is `ident` (not `(`, `,`, `.`, `=`, `?`,
      // `<`, `>` etc which would mean the identifier is in a different
      // syntactic slot).
      const looksLikeFieldTarget =
        lastIdent !== null &&
        prevSig === "ident" &&
        // Reject identifiers whose preceding context was a parameter list
        // (`,` or `<` after a type), member access (`.`), or attribute —
        // these are not declaration targets.
        !lastIdent.text.startsWith("@");
      if (
        inClassBodyNotMethod() &&
        parenDepth === 0 &&
        looksLikeFieldTarget &&
        lastIdent !== null &&
        (ch === ";" || ch === "=" || ch === ",")
      ) {
        fields.push(lastIdent.range);
        // Record this name in the innermost class scope so method-body
        // references to the same name get colored too.
        classScopeStack[classScopeStack.length - 1].fields.add(lastIdent.text);
      }
      prevSig = ch;
      lastIdent = null;
      advance(1);
      continue;
    }

    // ── `)` ends a method signature (used by `{` decision above) ─────────
    if (ch === ")") {
      // Decrement paren depth — keeps the in-paren exclusion for the
      // declaration check in sync with the matching `(`.
      parenDepth = Math.max(0, parenDepth - 1);
      // `var x)` doesn't happen in normal C#; conservatively not marking
      // here — the `;` / `=` / `,` paths handle the common cases.
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
      // Track class-keyword occurrences so the `{` rule below can detect
      // `class X {`, `class X : Y {`, `class X<T> {`, `record X(int Y) {`
      // and friends. Reset on `;` / `{` / `}` via the `classKeywordPending`
      // assignments in those branches.
      if (
        ident === "class" ||
        ident === "struct" ||
        ident === "interface" ||
        ident === "enum" ||
        ident === "record"
      ) {
        classKeywordPending = true;
      }
      // Field *reference* inside a method body: if the ident's text
      // matches any field name registered in the current or any
      // enclosing class scope, mark this range as a field. We walk the
      // scope stack from innermost to outermost so an inner class's
      // shadowing of the same name wins (since both sets contain the
      // name, the first match — innermost — fires; this matches C#
      // name-resolution semantics closely enough for coloring).
      //
      // Also: single-character identifiers preceded by `.` are marked.
      // This covers Unity struct public-field access patterns
      // (`Vector2.y`, `Rect.x`, `Color.r`, `Vector3.z`) where the
      // field belongs to an external type we don't have a symbol
      // table for. Restricting to length 1 keeps the noise floor low:
      // method names like `Equals` / `GetComponent`, properties like
      // `position` / `size` / `sizeDelta`, and 2-letter framework
      // identifiers like `WX` (WeChat SDK) are all filtered out.
      if (
        inMethodBody() &&
        ident.length > 0 &&
        !ident.startsWith("@")
      ) {
        let marked = false;
        for (let s = classScopeStack.length - 1; s >= 0; s--) {
          if (classScopeStack[s].fields.has(ident)) {
            fields.push({
              startLineNumber: startLine,
              startColumn: startCol,
              endLineNumber: line,
              endColumn: endCol,
              name: ident,
            });
            marked = true;
            break;
          }
        }
        if (!marked && prevSig === "." && ident.length === 1) {
          fields.push({
            startLineNumber: startLine,
            startColumn: startCol,
            endLineNumber: line,
            endColumn: endCol,
            name: ident,
          });
        }
      }
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
  // Diagnostic — confirm the parser runs and what it returns. Cheap to
  // compute (we just made the array), and invaluable for "why isn't my
  // field colored" debugging. Drop this once the wiring is confirmed.
  console.log(
    `[csharpFieldDecoration] applyCsharpFieldDecorations source.length=${source.length} → fields.length=${fields.length}`,
    fields.slice(0, 20),
  );
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