type Position = { line: number; column: number } | null | undefined;
type ParseMessage = { message?: string; position?: Position };

const at = (first: ParseMessage | undefined, fallback: unknown) =>
  `${first?.position ? `line ${first.position.line}, column ${first.position.column}: ` : ""}${first?.message ?? String(fallback)}`;

// The jsx loader also takes plain scripts, sloppy mode included (`with`, legacy octals). `.gs` is Google Apps Script
// and Google Ads Scripts. `.ts` keeps its own loader: `<T>(x) => x` is a generic there and JSX in `.tsx`.
const SCRIPTS: [RegExp, string, Bun.Transpiler][] = [
  [/\.(?:[cm]?jsx?|gs)$/i, "JavaScript", new Bun.Transpiler({ loader: "jsx" })],
  [/\.[cm]?ts$/i, "TypeScript", new Bun.Transpiler({ loader: "ts" })],
  [/\.tsx$/i, "TypeScript", new Bun.Transpiler({ loader: "tsx" })],
];

// Bun's bundler parses these from memory and, unlike `Bun.YAML.parse` and `JSON.parse`, says where it stopped.
// It picks the parser by extension and reads some names (package.json) leniently, so the copy gets a neutral name:
// `.jsonc` for the files whose tools take comments and trailing commas, the file's own extension otherwise.
const DATA: [RegExp, string][] = [
  [/\.jsonc?$/i, "JSON"],
  [/\.ya?ml$/i, "YAML"],
  [/\.toml$/i, "TOML"],
];
const JSONC = /(?:^|[\\/])(?:\.vscode[\\/].*\.json|[^\\/]*(?:devcontainer|[jt]sconfig)[^\\/]*\.json|[^\\/]*\.jsonc)$/i;
// Helm charts and Jinja files hold `{{ }}` or `{% %}` that only parses once filled in; GitHub's `${{ }}` is plain YAML.
const TEMPLATE = /(?<!\$)\{\{|\{%/;

/**
 * The first syntax error of a file in a format this server can parse (JavaScript, TypeScript, JSON, YAML, TOML) as
 * the format's name and "line L, column C: message", or null when it parses or the format isn't one of those (Python,
 * SQL, shell, templated data and the rest are left alone). Syntax only: a method the platform doesn't have still passes.
 */
export async function syntaxError(path: string, text: string): Promise<{ format: string; error: string } | null> {
  for (const [ext, format, parser] of SCRIPTS) {
    if (!ext.test(path)) continue;
    try {
      parser.scan(text);
      return null;
    } catch (error) {
      return { format, error: at((error instanceof AggregateError ? error.errors[0] : error) as ParseMessage, error) };
    }
  }
  const data = DATA.find(([ext]) => ext.test(path));
  if (!data) return null;
  const file = `/check/file.${JSONC.test(path) ? "jsonc" : path.slice(path.lastIndexOf(".") + 1).toLowerCase()}`;
  const built = await Bun.build({ entrypoints: [file], files: { [file]: text }, target: "bun", throw: false }).catch(
    () => null,
  );
  if (!built || built.success || TEMPLATE.test(text)) return null;
  const first = built.logs.find((log) => log.level === "error") ?? built.logs[0];
  return { format: data[1], error: at(first as ParseMessage | undefined, "it doesn't parse") };
}
