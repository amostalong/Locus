import type * as monaco from "monaco-editor";

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
    // synchronous failure during grammar registration itself. A proper
    // fix is Roslyn semantic tokens once the LSP pipeline lands.
    console.warn("[unityLanguages] csharp Monarch grammar setup failed (continuing with no csharp syntax highlighting):", err);
  }
}
