import { readFileSync } from "node:fs";
import path from "node:path";

// Minimal .env loader — dependency-free (the project keeps exactly two runtime
// deps: playwright + ws). Reads KEY=VALUE lines from a .env file and sets
// process.env for keys NOT already defined, so the real / shell environment
// always wins over the file (same precedence as dotenv).
//
// Rules: blank lines and lines starting with `#` are skipped; an optional
// leading `export ` is stripped; the value is split on the FIRST `=`; the key
// must match ^[A-Za-z_][A-Za-z0-9_]*$; surrounding matching quotes are removed.
// Inline `# comment` is NOT stripped (put comments on their own line) — a stray
// inline comment would otherwise turn MAGPIE_FPS=15 # x into a non-integer,
// which loadConfig already warns about and falls back from. Missing file is a
// no-op; this never throws — bad lines are skipped.
export function loadEnvFile(file = ".env") {
  let text;
  try {
    text = readFileSync(path.resolve(file), "utf8");
  } catch {
    return; // no .env present — nothing to do
  }
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // real / shell env wins
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2) {
      const first = val[0], last = val[val.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
