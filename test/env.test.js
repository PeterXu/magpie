import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvFile } from "../src/env.js";

function tmpEnvFile(content) {
  const dir = mkdtempSync(path.join(tmpdir(), "magpie-env-"));
  const file = path.join(dir, ".env");
  writeFileSync(file, content);
  return { file, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

// Run fn with the given keys cleared from process.env, then restore prior values.
function withKeys(keys, fn) {
  const snapshot = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try { return fn(); } finally {
    for (const k of keys) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  }
}

test("loadEnvFile: parses KEY=VALUE", () => {
  const { file, cleanup } = tmpEnvFile("A=1\nB=hello");
  try {
    withKeys(["A", "B"], () => {
      loadEnvFile(file);
      assert.equal(process.env.A, "1");
      assert.equal(process.env.B, "hello");
    });
  } finally { cleanup(); }
});

test("loadEnvFile: skips blank lines and full-line # comments", () => {
  const { file, cleanup } = tmpEnvFile("# a comment\n\n   \nA=2");
  try {
    withKeys(["A"], () => {
      loadEnvFile(file);
      assert.equal(process.env.A, "2");
    });
  } finally { cleanup(); }
});

test("loadEnvFile: strips surrounding matching quotes", () => {
  const { file, cleanup } = tmpEnvFile('A="quoted value"\nB=\'sq\'');
  try {
    withKeys(["A", "B"], () => {
      loadEnvFile(file);
      assert.equal(process.env.A, "quoted value");
      assert.equal(process.env.B, "sq");
    });
  } finally { cleanup(); }
});

test("loadEnvFile: real/shell env wins over the file", () => {
  const { file, cleanup } = tmpEnvFile("MAGPIE_FPS=15");
  try {
    withKeys(["MAGPIE_FPS"], () => {
      process.env.MAGPIE_FPS = "99";   // pretend already set by the shell
      loadEnvFile(file);
      assert.equal(process.env.MAGPIE_FPS, "99");  // file value did not overwrite
    });
  } finally { cleanup(); }
});

test("loadEnvFile: strips `export ` prefix; splits only on first '='", () => {
  const { file, cleanup } = tmpEnvFile("export A=b=c");
  try {
    withKeys(["A"], () => {
      loadEnvFile(file);
      assert.equal(process.env.A, "b=c");
    });
  } finally { cleanup(); }
});

test("loadEnvFile: invalid keys skipped, valid keys still load", () => {
  const { file, cleanup } = tmpEnvFile("1BAD=x\nA=ok\n=nokey");
  try {
    withKeys(["A", "1BAD"], () => {
      loadEnvFile(file);
      assert.equal(process.env.A, "ok");
      assert.equal(process.env["1BAD"], undefined);
    });
  } finally { cleanup(); }
});

test("loadEnvFile: missing file is a no-op, never throws", () => {
  assert.doesNotThrow(() => loadEnvFile(path.join(tmpdir(), "magpie-no-such-dir", ".env")));
});
