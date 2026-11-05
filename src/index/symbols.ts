/**
 * Lightweight, dependency-free symbol extraction.
 *
 * Regex-based per-language patterns pick out top-level definitions
 * (functions, classes, types, interfaces, ...) and common member definitions
 * (methods). Compared with a real parser (tree-sitter) this misses some edge
 * cases, such as multi-line signatures, macros and unusual formatting, but it
 * needs no native or WASM grammars, works on every platform Sutra runs on,
 * and is fast enough to index a few thousand files at startup.
 */
export type SymbolKind = "function" | "class" | "interface" | "type" | "enum" | "method" | "const" | "module" | "struct" | "trait";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based line of the definition. */
  line: number;
  /** The definition line, trimmed (used in the repo map). */
  signature: string;
  exported: boolean;
  /** Name of the enclosing class/impl, for methods. */
  parent?: string;
}

export type Language = "typescript" | "javascript" | "python" | "go" | "rust" | "java" | "kotlin" | "csharp" | "ruby" | "php" | "c" | "cpp" | "swift" | "scala";

const EXT: Record<string, Language> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  swift: "swift",
  scala: "scala",
};

export function languageOf(path: string): Language | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT[ext] ?? null;
}

interface Rule {
  re: RegExp;
  kind: SymbolKind;
  /** Capture group holding the name (default 1). */
  group?: number;
  /** Only when indented (members) / only at column 0 (top level). */
  member?: boolean;
  top?: boolean;
}

const CONTROL = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try", "new", "typeof", "await", "yield", "with", "super", "this", "constructor_", "elif", "except", "match", "when", "foreach", "using", "lock", "sizeof", "defined"]);

const JS_TS: Rule[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, kind: "type" },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\((?:[^()]|\([^()]*\))*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, kind: "function", top: true },
  { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function\b/, kind: "function", top: true },
  { re: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "const", top: true },
  {
    re: /^\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set|declare)\s+)*\*?([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{=;]+)?\s*\{\s*$/,
    kind: "method",
    member: true,
  },
];

const RULES: Record<Language, Rule[]> = {
  typescript: JS_TS,
  javascript: JS_TS,
  python: [
    { re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function", group: 2 },
    { re: /^(\s*)class\s+([A-Za-z_]\w*)/, kind: "class", group: 2 },
  ],
  go: [
    { re: /^func\s+\(\s*\w+\s+\*?([A-Za-z_]\w*)[^)]*\)\s*([A-Za-z_]\w*)/, kind: "method", group: 2 },
    { re: /^func\s+([A-Za-z_]\w*)/, kind: "function" },
    { re: /^type\s+([A-Za-z_]\w*)\s+struct\b/, kind: "struct" },
    { re: /^type\s+([A-Za-z_]\w*)\s+interface\b/, kind: "interface" },
    { re: /^type\s+([A-Za-z_]\w*)\s+/, kind: "type" },
  ],
  rust: [
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: "trait" },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, kind: "type" },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, kind: "module" },
  ],
  java: [
    { re: /^\s*(?:(?:public|private|protected|static|final|abstract|sealed)\s+)*(?:class|record)\s+([A-Za-z_]\w*)/, kind: "class" },
    { re: /^\s*(?:(?:public|private|protected|static)\s+)*interface\s+([A-Za-z_]\w*)/, kind: "interface" },
    { re: /^\s*(?:(?:public|private|protected|static)\s+)*enum\s+([A-Za-z_]\w*)/, kind: "enum" },
    { re: /^\s+(?:(?:public|private|protected|static|final|abstract|synchronized|default)\s+)+[\w<>\[\],.? ]+\s+([A-Za-z_]\w*)\s*\(/, kind: "method", member: true },
  ],
  kotlin: [
    { re: /^\s*(?:(?:public|private|internal|protected|open|abstract|sealed|data|inline|value|enum)\s+)*class\s+([A-Za-z_]\w*)/, kind: "class" },
    { re: /^\s*(?:(?:public|private|internal|protected|fun)\s+)*interface\s+([A-Za-z_]\w*)/, kind: "interface" },
    { re: /^\s*object\s+([A-Za-z_]\w*)/, kind: "class" },
    { re: /^\s*(?:(?:public|private|internal|protected|override|open|suspend|inline|operator)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/, kind: "function" },
  ],
  csharp: [
    { re: /^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*(?:class|record|struct)\s+([A-Za-z_]\w*)/, kind: "class" },
    { re: /^\s*(?:(?:public|private|protected|internal)\s+)*interface\s+([A-Za-z_]\w*)/, kind: "interface" },
    { re: /^\s*(?:(?:public|private|protected|internal)\s+)*enum\s+([A-Za-z_]\w*)/, kind: "enum" },
    { re: /^\s+(?:(?:public|private|protected|internal|static|virtual|override|async|abstract|sealed)\s+)+[\w<>\[\],.? ]+\s+([A-Za-z_]\w*)\s*\(/, kind: "method", member: true },
  ],
  ruby: [
    { re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, kind: "function" },
    { re: /^\s*class\s+([A-Z]\w*)/, kind: "class" },
    { re: /^\s*module\s+([A-Z]\w*)/, kind: "module" },
  ],
  php: [
    { re: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+([A-Za-z_]\w*)/, kind: "function" },
    { re: /^\s*(?:(?:abstract|final)\s+)?class\s+([A-Za-z_]\w*)/, kind: "class" },
    { re: /^\s*interface\s+([A-Za-z_]\w*)/, kind: "interface" },
    { re: /^\s*trait\s+([A-Za-z_]\w*)/, kind: "trait" },
  ],
  c: [
    { re: /^(?:static\s+|inline\s+|extern\s+)*[A-Za-z_][\w\s\*]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, kind: "function", top: true },
    { re: /^(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
    { re: /^(?:typedef\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
  ],
  cpp: [
    { re: /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+([A-Za-z_]\w*)\s*(?:final\s*)?(?::|\{|$)/, kind: "class" },
    { re: /^(?:static\s+|inline\s+|virtual\s+|constexpr\s+)*[A-Za-z_][\w\s\*&:<>,]*?\b((?:[A-Za-z_]\w*::)*[A-Za-z_~]\w*)\s*\([^;]*\)\s*(?:const\s*)?(?:override\s*)?\{?\s*$/, kind: "function", top: true },
    { re: /^\s*namespace\s+([A-Za-z_]\w*)/, kind: "module" },
    { re: /^\s*enum\s+(?:class\s+)?([A-Za-z_]\w*)/, kind: "enum" },
  ],
  swift: [
    { re: /^\s*(?:(?:public|private|internal|open|fileprivate|final)\s+)*(?:class|struct|actor)\s+([A-Za-z_]\w*)/, kind: "class" },
    { re: /^\s*(?:(?:public|private|internal|open)\s+)*protocol\s+([A-Za-z_]\w*)/, kind: "interface" },
    { re: /^\s*(?:(?:public|private|internal|open)\s+)*enum\s+([A-Za-z_]\w*)/, kind: "enum" },
    { re: /^\s*(?:(?:public|private|internal|open|fileprivate|static|override|mutating|class)\s+)*func\s+([A-Za-z_]\w*)/, kind: "function" },
  ],
  scala: [
    { re: /^\s*(?:(?:case|abstract|sealed|final|private|protected)\s+)*class\s+([A-Za-z_]\w*)/, kind: "class" },
    { re: /^\s*(?:case\s+)?object\s+([A-Za-z_]\w*)/, kind: "class" },
    { re: /^\s*(?:sealed\s+)?trait\s+([A-Za-z_]\w*)/, kind: "trait" },
    { re: /^\s*(?:(?:override|private|protected|final)\s+)*def\s+([A-Za-z_]\w*)/, kind: "function" },
  ],
};

function isExported(lang: Language, line: string, name: string, indented: boolean): boolean {
  switch (lang) {
    case "typescript":
    case "javascript":
      return /^\s*export\b/.test(line);
    case "go":
      return /^[A-Z]/.test(name);
    case "rust":
      return /^\s*pub\b/.test(line);
    case "python":
      return !name.startsWith("_") && !indented;
    case "java":
    case "csharp":
    case "kotlin":
    case "swift":
      return !/\bprivate\b/.test(line);
    default:
      return !indented;
  }
}

function stripComments(line: string): string {
  return line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
}

/** Extract symbols from one file's source. */
export function extractSymbols(source: string, lang: Language): CodeSymbol[] {
  const rules = RULES[lang];
  const out: CodeSymbol[] = [];
  const lines = source.split("\n");
  // Track the most recent class-like definition for method parents (by indentation).
  let container: { name: string; indent: number } | null = null;
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.length > 400) continue; // minified / generated
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const trimmed = line.trim();
    // Comments, preprocessor lines, decorators/attributes and doc-comment bodies.
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
      inBlockComment = true;
      continue;
    }
    const code = stripComments(line);
    const indent = code.length - code.trimStart().length;
    // Leaving the class body: a line at (or left of) the class's own indentation.
    if (container && indent <= container.indent && !/^[}\])]/.test(trimmed)) container = null;
    for (const rule of rules) {
      if (rule.top && indent > 0) continue;
      if (rule.member && indent === 0) continue;
      const m = code.match(rule.re);
      if (!m) continue;
      const name = m[rule.group ?? 1];
      if (!name || CONTROL.has(name) || /^[0-9]/.test(name)) continue;
      let kind = rule.kind;
      // Python: indented defs inside a class are methods.
      if (lang === "python" && kind === "function" && indent > 0 && container && indent > container.indent) kind = "method";
      const sym: CodeSymbol = {
        name,
        kind,
        line: i + 1,
        signature: trimmed.replace(/\s*\{\s*$/, "").replace(/\s+/g, " ").slice(0, 160),
        exported: isExported(lang, code, name, indent > 0),
      };
      if ((kind === "method" || (indent > 0 && kind === "function")) && container && indent > container.indent) sym.parent = container.name;
      if (lang === "go" && kind === "method") sym.parent = m[1]!;
      out.push(sym);
      if (kind === "class" || kind === "interface" || kind === "struct" || kind === "trait" || kind === "module") container = { name, indent };
      break;
    }
  }
  return out;
}

/** Split an identifier into lower-case word parts: "refreshAuthToken" → refresh, auth, token. */
export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length >= 2);
}

const IDENT_RE = /[A-Za-z_$][\w$]{2,}/g;

/** Identifiers used in a file (with counts), for the reference graph. */
export function identifierCounts(source: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of source.matchAll(IDENT_RE)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  return counts;
}
