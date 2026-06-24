import type * as monaco from "monaco-editor";

import { csharpLspBridgeRequest } from "./csharpLsp";

let registered = false;

/**
 * Register Unity-specific languages on the global Monaco namespace.
 * Currently provides ShaderLab (for `.shader` files, including embedded
 * HLSL/Cg blocks) and HLSL (for `.hlsl` / `.cginc` / `.compute`).
 *
 * Idempotent — safe to call multiple times.
 */
export function registerUnityLanguages(monacoNs: typeof monaco): void {
  if (registered) return;
  registered = true;

  // Each registration is wrapped in try-catch as a defensive measure against
  // monaco-vscode-api 33.0.9 edge cases (Monarch `_theme.match` race, service
  // not yet ready, etc.). If something throws we log and continue — the editor
  // still works, it just falls back to plain text rendering for that language.
  try { registerHlsl(monacoNs); } catch (e) {
    console.warn("[unityLanguages] HLSL registration failed (continuing):", e);
  }
  try { registerShaderLab(monacoNs); } catch (e) {
    console.warn("[unityLanguages] ShaderLab registration failed (continuing):", e);
  }
  // ── C# Roslyn semantic tokens provider ────────────────────────────────────
  // The csharp Monarch grammar (below) is a 500ms-window fallback. Once Roslyn
  // responds, the DocumentSemanticTokensProvider registered here takes over
  // for `class vs method vs field vs property` distinction (which Monarch
  // regex fundamentally cannot do). See `registerCsharpSemanticTokensProvider`
  // for the implementation and the diagnostic dump that lets us verify
  // which tokenType/modifier Roslyn actually emits for fields.
  try { registerCsharpSemanticTokensProvider(monacoNs); } catch (e) {
    console.warn("[unityLanguages] csharp Roslyn semantic-tokens provider registration failed (continuing):", e);
  }
}

// ── HLSL ─────────────────────────────────────────────────────────────────────

function registerHlsl(monacoNs: typeof monaco): void {
  monacoNs.languages.register({
    id: "hlsl",
    extensions: [".hlsl", ".cginc", ".compute"],
    aliases: ["HLSL", "hlsl", "Cg"],
  });

  monacoNs.languages.setLanguageConfiguration("hlsl", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
    ],
  });

  const HLSL_KEYWORDS = [
    "if", "else", "for", "while", "do", "switch", "case", "default",
    "break", "continue", "return", "discard", "true", "false",
    "in", "out", "inout", "uniform", "static", "const", "register",
    "packoffset", "shared", "groupshared", "precise",
    "linear", "centroid", "nointerpolation", "noperspective", "sample",
    "snorm", "unorm", "point", "line", "triangle", "lineadj", "triangleadj",
    "struct", "typedef", "namespace", "using", "class", "interface",
    "cbuffer", "tbuffer", "ConstantBuffer", "technique", "technique10",
    "technique11", "pass", "pixelshader", "vertexshader",
  ];

  const HLSL_TYPES = [
    "void", "bool", "int", "uint", "dword", "half", "float", "double",
    "fixed", "min10float", "min16float", "min12int", "min16int", "min16uint",
    "vector", "matrix",
    // Vector + matrix shorthands (1..4 in each dimension).
    ...buildVectorMatrixTypes(),
    // Texture/sampler.
    "sampler", "sampler1D", "sampler2D", "sampler3D", "samplerCUBE",
    "sampler1DARRAY", "sampler2DARRAY", "samplerCUBEARRAY",
    "sampler_state", "SamplerState", "SamplerComparisonState",
    "Texture1D", "Texture1DArray", "Texture2D", "Texture2DArray",
    "Texture2DMS", "Texture2DMSArray", "Texture3D",
    "TextureCube", "TextureCubeArray",
    "RWTexture1D", "RWTexture1DArray",
    "RWTexture2D", "RWTexture2DArray", "RWTexture3D",
    "Buffer", "RWBuffer",
    "StructuredBuffer", "RWStructuredBuffer",
    "ByteAddressBuffer", "RWByteAddressBuffer",
    "AppendStructuredBuffer", "ConsumeStructuredBuffer",
    // Geometry / tessellation streams.
    "PointStream", "LineStream", "TriangleStream",
    "InputPatch", "OutputPatch",
  ];

  const HLSL_BUILTIN_FUNCTIONS = [
    "abs", "acos", "all", "any", "asin", "atan", "atan2", "ceil", "clamp",
    "clip", "cos", "cosh", "cross", "ddx", "ddx_coarse", "ddx_fine",
    "ddy", "ddy_coarse", "ddy_fine", "degrees", "determinant", "distance",
    "dot", "exp", "exp2", "faceforward", "firstbithigh", "firstbitlow",
    "floor", "fmod", "frac", "frexp", "fwidth", "isfinite", "isinf",
    "isnan", "ldexp", "length", "lerp", "lit", "log", "log10", "log2",
    "mad", "max", "min", "modf", "mul", "noise", "normalize", "pow",
    "radians", "reflect", "refract", "reversebits", "round", "rsqrt",
    "saturate", "sign", "sin", "sincos", "sinh", "smoothstep", "sqrt",
    "step", "tan", "tanh", "transpose", "trunc",
    "tex2D", "tex2Dlod", "tex2Dgrad", "tex2Dbias", "tex2Dproj",
    "texCUBE", "texCUBElod", "tex3D", "tex3Dlod",
    "asuint", "asint", "asfloat", "f16tof32", "f32tof16",
    "GroupMemoryBarrier", "GroupMemoryBarrierWithGroupSync",
    "DeviceMemoryBarrier", "DeviceMemoryBarrierWithGroupSync",
    "AllMemoryBarrier", "AllMemoryBarrierWithGroupSync",
    "InterlockedAdd", "InterlockedAnd", "InterlockedCompareExchange",
    "InterlockedExchange", "InterlockedMax", "InterlockedMin",
    "InterlockedOr", "InterlockedXor",
  ];

  const HLSL_SEMANTICS = [
    "POSITION", "POSITIONT", "NORMAL", "TANGENT", "BINORMAL",
    "TEXCOORD", "TEXCOORD0", "TEXCOORD1", "TEXCOORD2", "TEXCOORD3",
    "TEXCOORD4", "TEXCOORD5", "TEXCOORD6", "TEXCOORD7",
    "TEXCOORD8", "TEXCOORD9", "TEXCOORD10", "TEXCOORD11",
    "TEXCOORD12", "TEXCOORD13", "TEXCOORD14", "TEXCOORD15",
    "COLOR", "COLOR0", "COLOR1", "COLOR2", "COLOR3",
    "BLENDINDICES", "BLENDWEIGHT",
    "FOG", "PSIZE", "VFACE", "VPOS", "DEPTH",
    "SV_POSITION", "SV_Target", "SV_Target0", "SV_Target1",
    "SV_Target2", "SV_Target3", "SV_Target4", "SV_Target5",
    "SV_Target6", "SV_Target7",
    "SV_Depth", "SV_DepthGreaterEqual", "SV_DepthLessEqual",
    "SV_DispatchThreadID", "SV_GroupID", "SV_GroupIndex",
    "SV_GroupThreadID", "SV_VertexID", "SV_InstanceID",
    "SV_PrimitiveID", "SV_GSInstanceID", "SV_OutputControlPointID",
    "SV_DomainLocation", "SV_TessFactor", "SV_InsideTessFactor",
    "SV_RenderTargetArrayIndex", "SV_ViewportArrayIndex",
    "SV_IsFrontFace", "SV_SampleIndex", "SV_Coverage", "SV_StencilRef",
    "SV_ClipDistance", "SV_CullDistance",
  ];

  monacoNs.languages.setMonarchTokensProvider("hlsl", {
    defaultToken: "",
    tokenPostfix: ".hlsl",
    keywords: HLSL_KEYWORDS,
    types: HLSL_TYPES,
    builtins: HLSL_BUILTIN_FUNCTIONS,
    semantics: HLSL_SEMANTICS,
    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    integersuffix: /([uU](ll|LL|l|L)|(ll|LL|l|L)?[uU]?)/,
    floatsuffix: /[fFlLhH]?/,

    tokenizer: {
      root: [
        // Preprocessor (Unity #pragma multi_compile, #pragma vertex, #include, etc.).
        [/^\s*#\s*include/, { token: "keyword.directive.include", next: "@include" }],
        [/^\s*#\s*\w+/, "keyword.directive"],

        // Identifiers / keywords / types / builtins / semantics.
        [
          /[A-Za-z_]\w*/,
          {
            cases: {
              "@keywords": "keyword",
              "@types": "type",
              "@builtins": "predefined",
              "@semantics": "annotation",
              "@default": "identifier",
            },
          },
        ],

        // Whitespace.
        { include: "@whitespace" },

        // Brackets / delimiters.
        [/[{}()\[\]]/, "@brackets"],
        [/[<>](?!@symbols)/, "@brackets"],
        [/@symbols/, { cases: { "@default": "operator" } }],

        // Numbers.
        [/\d+\.\d*([eE][\-+]?\d+)?@floatsuffix/, "number.float"],
        [/\.\d+([eE][\-+]?\d+)?@floatsuffix/, "number.float"],
        [/\d+[eE][\-+]?\d+@floatsuffix/, "number.float"],
        [/0[xX][0-9A-Fa-f]+@integersuffix/, "number.hex"],
        [/\d+@integersuffix/, "number"],

        // Punctuation.
        [/[;,.]/, "delimiter"],

        // Strings.
        [/"/, { token: "string.quote", next: "@string" }],
      ],

      whitespace: [
        [/[ \t\r\n]+/, ""],
        [/\/\*/, "comment", "@blockComment"],
        [/\/\/.*$/, "comment"],
      ],

      blockComment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],

      string: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],

      include: [
        [/(\s*)("[^"]*")/, ["", "string.include"]],
        [/(\s*)(<[^>]*>)/, ["", "string.include"]],
        [/$/, "", "@pop"],
      ],
    },
  } satisfies monaco.languages.IMonarchLanguage);
}

function buildVectorMatrixTypes(): string[] {
  const scalars = ["bool", "int", "uint", "half", "float", "double", "fixed"];
  const out: string[] = [];
  for (const s of scalars) {
    for (let i = 1; i <= 4; i++) out.push(`${s}${i}`);
    for (let r = 1; r <= 4; r++) {
      for (let c = 1; c <= 4; c++) out.push(`${s}${r}x${c}`);
    }
  }
  return out;
}

// ── ShaderLab ────────────────────────────────────────────────────────────────

function registerShaderLab(monacoNs: typeof monaco): void {
  monacoNs.languages.register({
    id: "shaderlab",
    extensions: [".shader"],
    aliases: ["ShaderLab", "shaderlab"],
  });

  monacoNs.languages.setLanguageConfiguration("shaderlab", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
    ],
  });

  const SHADERLAB_TOPLEVEL = [
    "Shader", "SubShader", "Properties", "Pass", "Category", "Tags",
    "FallBack", "Fallback", "CustomEditor", "Dependency", "GrabPass", "UsePass",
  ];

  const SHADERLAB_STATEMENTS = [
    "Cull", "ZTest", "ZWrite", "ZClip", "Blend", "BlendOp", "ColorMask",
    "Offset", "AlphaToMask", "Stencil", "ColorMaterial", "Lighting",
    "Material", "SeparateSpecular", "SetTexture", "Combine", "Constant",
    "Matrix", "Bind", "LOD", "Name", "BindChannels", "Fog", "AlphaTest",
    "Conservative", "ShaderType",
    "Ref", "ReadMask", "WriteMask", "Comp", "Pass", "Fail", "ZFail",
    "CompFront", "CompBack", "PassFront", "PassBack",
    "FailFront", "FailBack", "ZFailFront", "ZFailBack",
  ];

  const SHADERLAB_VALUES = [
    "On", "Off", "True", "False",
    "Back", "Front", "Off",
    "Less", "Greater", "LEqual", "GEqual", "Equal", "NotEqual", "Always", "Never",
    "Zero", "One", "DstColor", "SrcColor", "OneMinusDstColor", "SrcAlpha",
    "OneMinusSrcColor", "DstAlpha", "OneMinusDstAlpha", "SrcAlphaSaturate",
    "OneMinusSrcAlpha",
    "Add", "Sub", "RevSub", "Min", "Max", "LogicalClear", "LogicalSet",
    "LogicalCopy", "LogicalCopyInverted", "LogicalNoop", "LogicalInvert",
    "LogicalAnd", "LogicalNand", "LogicalOr", "LogicalNor", "LogicalXor",
    "LogicalEquiv", "LogicalAndReverse", "LogicalAndInverted",
    "LogicalOrReverse", "LogicalOrInverted",
    "Keep", "Replace", "IncrSat", "DecrSat", "Invert", "IncrWrap", "DecrWrap",
  ];

  const SHADERLAB_PROPERTY_TYPES = [
    "2D", "3D", "Cube", "Float", "Range", "Color", "Vector", "Int",
    "2DArray", "CubeArray",
  ];

  monacoNs.languages.setMonarchTokensProvider("shaderlab", {
    defaultToken: "",
    tokenPostfix: ".shaderlab",
    ignoreCase: false,
    keywords: SHADERLAB_TOPLEVEL,
    statements: SHADERLAB_STATEMENTS,
    values: SHADERLAB_VALUES,
    propertyTypes: SHADERLAB_PROPERTY_TYPES,
    symbols: /[=><!~?:&|+\-*/^%]+/,

    tokenizer: {
      root: [
        // Embedded HLSL/Cg programs — activate embedded language at entry keyword.
        [/\b(CGPROGRAM|HLSLPROGRAM|GLSLPROGRAM)\b/, { token: "keyword.program", next: "@embeddedProgram", nextEmbedded: "hlsl" }],
        [/\b(CGINCLUDE|HLSLINCLUDE|GLSLINCLUDE)\b/, { token: "keyword.program", next: "@embeddedInclude", nextEmbedded: "hlsl" }],

        // Preprocessor passthrough (rare at the ShaderLab level but valid).
        [/^\s*#\s*\w+/, "keyword.directive"],

        // Identifiers.
        [
          /[A-Za-z_]\w*/,
          {
            cases: {
              "@keywords": "keyword.shaderlab",
              "@statements": "keyword",
              "@values": "constant",
              "@propertyTypes": "type",
              "@default": "identifier",
            },
          },
        ],

        { include: "@whitespace" },

        // Brackets / delimiters.
        [/[{}()\[\]]/, "@brackets"],
        [/@symbols/, "operator"],
        [/[;,.]/, "delimiter"],

        // Numbers.
        [/\d+\.\d*/, "number.float"],
        [/\.\d+/, "number.float"],
        [/\d+/, "number"],

        // Strings (shader paths in `Shader "Name"`, tag values, default tex).
        [/"/, { token: "string.quote", next: "@string" }],
      ],

      // Embedded HLSL until ENDCG / ENDHLSL / ENDGLSL.
      // nextEmbedded: "@pop" is required to deactivate the embedded language; without it
      // the hlsl tokenizer stays active after the block ends, which causes Monaco's
      // background tokenizer to emit undefined token types and crash.
      embeddedProgram: [
        [/\b(ENDCG|ENDHLSL|ENDGLSL)\b/, { token: "keyword.program", next: "@pop", nextEmbedded: "@pop" }],
      ],

      embeddedInclude: [
        [/\b(ENDCG|ENDHLSL|ENDGLSL)\b/, { token: "keyword.program", next: "@pop", nextEmbedded: "@pop" }],
      ],

      whitespace: [
        [/[ \t\r\n]+/, ""],
        [/\/\*/, "comment", "@blockComment"],
        [/\/\/.*$/, "comment"],
      ],

      blockComment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],

      string: [
        [/[^\\"]+/, "string"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],
    },
  } satisfies monaco.languages.IMonarchLanguage);

  // ── C# (standalone grammar, not from monaco-vscode-csharp-default-extension) ──
  //
  // The csharp-default-extension's tokenization contribution registers
  // through `vscode.languages.registerTokensProvider` in the local
  // extension host. In monaco-vscode-api 33.0.9 that worker regularly
  // throws "Default api is not ready yet" before the contribution lands,
  // which is why the editor renders as white-on-black for .cs files.
  // Registering a Monarch grammar here bypasses the vscode API entirely
  // — Monaco tokenizes the file itself.
  //
  // The csharp language id also needs to be registered with Monaco
  // core; the vscode-side extension would normally do this through
  // its languages contribution, but when that path is broken the
  // `setLanguageConfiguration` call below throws "Cannot set
  // configuration for unknown language csharp". Registering the
  // id here (a no-op if the extension already did) makes the
  // language known to Monaco core so the configuration + token
  // provider can attach.
  monacoNs.languages.register({
    id: "csharp",
    extensions: [".cs", ".csx", ".cake"],
    aliases: ["C#", "csharp"],
  });
  //
  // This is intentionally a simplified grammar (keywords, comments,
  // strings, numbers, attributes, identifiers). The full Roslyn
  // semantic tokens (class vs method vs field vs property) is a
  // separate concern handled via `textDocument/semanticTokens/full`
  // once diagnostics work is in place.
  //
  // The whole csharp block is wrapped in try/catch as a defensive
  // measure for monaco-vscode-api 33.0.9 edge cases. The global
  // error handler in `monacoVscodeServices.installMonacoErrorHandler`
  // silences the actual Monarch `_theme.match` race, but anything else
  // that might throw here — tokenizer setup, language configuration
  // attach, etc. — should not brick the whole editor mount. If
  // something does throw we log and continue — the editor still works,
  // it just falls back to plain text rendering for csharp.
  //
  try {
  monacoNs.languages.setMonarchTokensProvider("csharp", {
    defaultToken: "",
    tokenPostfix: ".cs",
    keywords: [
      "abstract", "as", "base", "bool", "break", "byte", "case", "catch",
      "char", "checked", "class", "const", "continue", "decimal", "default",
      "delegate", "do", "double", "else", "enum", "event", "explicit",
      "extern", "false", "finally", "fixed", "float", "for", "foreach",
      "goto", "if", "implicit", "in", "int", "interface", "internal", "is",
      "lock", "long", "namespace", "new", "null", "object", "operator",
      "out", "override", "params", "private", "protected", "public",
      "readonly", "ref", "return", "sbyte", "sealed", "short", "sizeof",
      "stackalloc", "static", "string", "struct", "switch", "this", "throw",
      "true", "try", "typeof", "uint", "ulong", "unchecked", "unsafe",
      "ushort", "using", "var", "virtual", "void", "volatile", "while",
    ],
    typeKeywords: [
      // Aligned with Roslyn's LSP semantic token classification. The Monarch
      // grammar is the fallback tokenization for csharp (used in the ~500ms
      // window between file open and Roslyn's first semantic tokens/full
      // response). Whatever this list emits MUST match Roslyn's eventual
      // verdict, or the file will visibly flicker between these two states
      // on every open.
      //
      // Roslyn classifies these C# built-in type names as `type` (pink), so
      // we do too:
      "bool", "byte", "char", "decimal", "double", "float", "int", "long",
      "object", "sbyte", "short", "string", "uint", "ulong", "ushort",
      // Roslyn classifies these as `type` as well — they were missing from
      // the original list and would otherwise flicker from `identifier` →
      // `type` once Roslyn arrives:
      "dynamic", // C# 4 contextual keyword; always a type at use sites
      "nint",    // C# 11 native int alias
      "nuint",   // C# 11 native uint alias
      //
      // Intentionally absent: `void`. Roslyn classifies `void` as `keyword`
      // (not `type`) — `void` in `void Foo()` means "no return value", not
      // "a void-typed instance". Including it here would paint every method
      // signature's `void` pink during the fallback window. It lives in
      // the `keywords` list above and falls through to the `keyword` token
      // via the case-rule order in the tokenizer.
    ],
    // Tokenizer rules run in order. Comments / strings / numbers / identifiers
    // match before the generic "word" rule would. The `preprocessor` rule
    // catches #if / #region / #pragma directives.
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/@"(?:[^"\\]|\\.)*"/, "string"],
        [/\$"(?:[^"\\]|\\.|{\([^}]*\))*"/, "string"],
        [/(?:\$@|@\$)"(?:[^"\\]|\\.)*"/, "string"],
        [/"(?:\\.|[^"\\])*"/, "string"],
        [/'[^\\']'/, "string"],
        [/'\\.'/, "string"],
        [/0[xX][0-9a-fA-F]+[Ll]?/, "number.hex"],
        [/0[bB][01]+[Ll]?/, "number.bin"],
        [/[0-9]+\.[0-9]+(?:[eE][+-]?[0-9]+)?[fFdDmM]?/, "number.float"],
        [/[0-9]+[LlFfDdMm]?/, "number"],
        [/\#\s*(if|else|elif|endif|define|undef|warning|error|line|region|endregion|pragma|nullable)\b/, "keyword.preprocessor"],
        [/\b(?:this|base|null|true|false|var)\b/, "keyword"],
        [/[a-zA-Z_][\w]*(?=\s*\()/, { cases: { "@typeKeywords": "type", "@keywords": "keyword", "@default": "identifier.function" } }],
        [/[A-Z][\w]*/, "type"],
        [/[a-z_][\w]*/, { cases: { "@typeKeywords": "type", "@keywords": "keyword", "@default": "identifier" } }],
        [/[{}()[\];,.]/, "delimiter"],
        [/[+\-*/%&|^!~?:=<>]+/, "operator"],
        [/\s+/, ""],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  } satisfies monaco.languages.IMonarchLanguage);
  // Configure bracket auto-closing/pairing for csharp so typing `<` in
  // a generic doesn't fight the editor. Wrapped in try/catch because
  // monaco-vscode-api 33.0.9's `setLanguageConfiguration` throws
  // "Cannot set configuration for unknown language csharp" if the
  // csharp-default-extension failed to register the language id
  // (the `monacoNs.languages.register({id: "csharp", ...})` call
  // above is the local fallback; the try/catch here is the last
  // line of defense in case register also raced).
  try {
    monacoNs.languages.setLanguageConfiguration("csharp", {
      comments: { lineComment: "//", blockComment: ["/*", "*/"] },
      brackets: [
        ["{", "}"], ["[", "]"], ["(", ")"],
        ["<", ">"],
      ],
      autoClosingPairs: [
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
        { open: "<", close: ">", notIn: ["strings"] },
        { open: "'", close: "'", notIn: ["strings", "comments"] },
        { open: '"', close: '"', notIn: ["strings", "comments"] },
      ],
      surroundingPairs: [
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
        { open: "<", close: ">" },
        { open: "'", close: "'" },
        { open: '"', close: '"' },
      ],
    });
  } catch (err) {
    console.warn("[unityLanguages] setLanguageConfiguration for csharp failed (continuing without bracket config):", err);
  }
  } catch (err) {
    // Outer catch — see the long comment above (line ~400). The actual
    // Monarch collector race fires from a background tokenize callback,
    // not synchronously, so this catch is a defensive placeholder for any
    // synchronous failure during grammar registration itself. The proper
    // fix for "class vs method vs field vs property" distinction is
    // Roslyn semantic tokens via `registerCsharpSemanticTokensProvider`
    // (registered in registerUnityLanguages above), which takes over once
    // the LSP responds (~500ms after file open). The Monarch grammar
    // remains the fallback for that window.
    console.warn("[unityLanguages] csharp Monarch grammar setup failed (continuing with no csharp syntax highlighting):", err);
  }
}

// ── C# Roslyn semantic tokens provider ─────────────────────────────────────
//
// The csharp Monarch grammar (above) gives correct type/keyword/identifier
// classification but fundamentally cannot distinguish class fields from local
// variables — both fall through to `identifier`. That distinction is a
// semantic question (is this identifier's declaring syntax a class member
// or a method-local statement?) that regex-based Monarch grammars cannot
// answer.
//
// Roslyn's LSP `textDocument/semanticTokens/full` response CAN — it gives us
// each token's LSP-standard `tokenType` (namespace/type/class/variable/
// property/...) plus a bit-set of `tokenModifiers` (declaration/static/
// readonly/...). Once registered here, Monaco's SemanticTokensStylingService
// takes these over the Monarch output (the two are documented to coexist;
// see the `setMonarchTokensProvider` API doc in @codingame/monaco-vscode-api
// for "work together with").
//
// What this provider does today:
//   1. Forward the LSP request to the running Roslyn server via the generic
//      `csharpLspBridgeRequest` IPC (which already exists for hover/
//      definition/completion — no Rust changes needed).
//   2. Decode the LSP delta-encoded `data: number[]` into absolute
//      (line, startChar) + look up token text from the model.
//   3. **Dump the first response to the console** so we can verify which
//      tokenType/modifier Roslyn actually emits for `private int
//      _lastScreenHeight;` — the answer determines which key to use in
//      `editor.semanticTokenColorCustomizations.rules` for the indigo
//      field-color hook. (See monacoVscodeServices.ts for the customize
//      rules; the `variable.class` / `variable.declaration.class` entries
//      there are currently dead code pending this dump.)
//
// What this provider does NOT do today (follow-up commit):
//   - Hook a token-rule or customize-rule that paints fields indigo. We
//     keep this commit minimal: wire the data path first, observe Roslyn's
//     actual response shape, then add the rule in a follow-up that targets
//     the verified tokenType/modifier.
//
// Edge cases handled:
//   - LSP request fails (server cold start / network blip): return empty
//     data array. Monaco falls back to the Monarch grammar (current
//     behaviour — no regression).
//   - Cancellation token: if the user keeps typing and Monaco cancels the
//     previous request, return empty without logging noise.
//   - Provider registration itself fails (monaco-vscode-api 33.0.9 "Default
//     api is not ready yet" race): the caller's try/catch in
//     registerUnityLanguages swallows and logs.
function registerCsharpSemanticTokensProvider(monacoNs: typeof monaco): void {
  // LSP RFC 14 standard token type legend. Order matters — the integer
  // indices in Roslyn's response match this list positionally.
  const tokenTypes = [
    "namespace", "type", "class", "enum", "interface", "struct",
    "typeParameter", "parameter", "variable", "property", "enumMember",
    "event", "function", "method", "macro", "keyword", "modifier",
    "comment", "string", "number", "regexp", "operator", "decorator",
  ];
  const tokenModifiers = [
    "declaration", "static", "async", "readonly", "defaultLibrary", "abstract",
  ];

  // Track whether the first dump has fired — we don't want to spam the
  // console on every model change. The dump is keyed on the function
  // (not per-file) so the very first file to open Roslyn-responds for
  // gets logged, regardless of which file.
  const dumpState: { fired: boolean } = { fired: false };

  monacoNs.languages.registerDocumentSemanticTokensProvider(
    { language: "csharp" },
    {
      getLegend: () => ({ tokenTypes, tokenModifiers }),
      provideDocumentSemanticTokens: async (model, _lastResultId, cancelToken) => {
        if (cancelToken?.isCancellationRequested) {
          return { data: new Uint32Array(0) };
        }
        let data: number[] = [];
        try {
          const resp = (await csharpLspBridgeRequest(
            "textDocument/semanticTokens/full",
            { textDocument: { uri: model.uri.toString() } },
          )) as { data?: number[]; resultId?: string } | null;
          if (resp && Array.isArray(resp.data)) {
            data = resp.data;
          }
        } catch (err) {
          // Cold-start / server-warming / network blip — Monaco falls back
          // to the Monarch grammar output. Don't warn: this is the common
          // case for ~500ms after file open.
          if (!dumpState.fired) {
            console.log(
              `[csharpSemanticTokens] LSP semanticTokens/full returned no data for ${model.uri.toString()} (err=${(err as Error)?.message ?? err}); Monaco falls back to Monarch grammar`,
            );
          }
          return { data: new Uint32Array(0) };
        }

        if (!dumpState.fired && data.length > 0) {
          dumpState.fired = true;
          const lines = model.getLinesContent();
          const decoded: Array<{
            line: number;
            start: number;
            len: number;
            type: string;
            modifiers: string[];
            text: string;
          }> = [];
          let curLine = 0;
          let curStart = 0;
          for (let i = 0; i + 4 < data.length; i += 5) {
            const dLine = data[i];
            const dStart = data[i + 1];
            const len = data[i + 2];
            const tType = data[i + 3];
            const tMods = data[i + 4];
            curLine += dLine;
            curStart = dLine === 0 ? curStart + dStart : dStart;
            const lineText = lines[curLine] ?? "";
            const text = lineText.substring(curStart, curStart + len);
            const modList: string[] = [];
            for (let m = 0; m < tokenModifiers.length; m++) {
              if ((tMods & (1 << m)) !== 0) modList.push(tokenModifiers[m]);
            }
            decoded.push({
              line: curLine,
              start: curStart,
              len,
              type: tokenTypes[tType] ?? `unknown[${tType}]`,
              modifiers: modList,
              text,
            });
          }
          // Count tokenType distribution so the next commit can target the
          // right customize-rules key without scanning the full list.
          const typeCounts = new Map<string, number>();
          for (const t of decoded) {
            const k = t.modifiers.length
              ? `${t.type}.${t.modifiers.join(".")}`
              : t.type;
            typeCounts.set(k, (typeCounts.get(k) ?? 0) + 1);
          }
          const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
          console.log(
            `[csharpSemanticTokens] Roslyn semanticTokens/full returned ${data.length / 5 | 0} tokens for ${model.uri.toString()} — first 200 samples (capped):`,
            decoded.slice(0, 200),
            `\n  tokenType+modifier distribution:`,
            sorted,
          );
        }

        return { data: new Uint32Array(data) };
      },
      releaseDocumentSemanticTokens: () => {
        // LSP monotonic resultId: Roslyn doesn't emit one, so we always
        // recompute on next provideDocumentSemanticTokens call.
      },
    } satisfies monaco.languages.DocumentSemanticTokensProvider,
  );
  console.log("[csharpSemanticTokens] DocumentSemanticTokensProvider registered for csharp (Roslyn LSP semanticTokens/full path active)");
}
