import { test } from "node:test";
import assert from "node:assert/strict";
import { chromiumLaunchOptions } from "../../src/browser/launch-options.js";

test("chromiumLaunchOptions: no flags by default", () => {
  delete process.env.MAGPIE_NO_SANDBOX;
  const opts = chromiumLaunchOptions();
  assert.equal(opts.headless, true);
  assert.deepEqual(opts.args, []);
});

test("chromiumLaunchOptions: adds sandbox flags when MAGPIE_NO_SANDBOX=1", () => {
  process.env.MAGPIE_NO_SANDBOX = "1";
  try {
    const opts = chromiumLaunchOptions();
    assert.equal(opts.headless, true);
    assert.ok(opts.args.includes("--no-sandbox"));
    assert.ok(opts.args.includes("--disable-setuid-sandbox"));
    assert.ok(opts.args.includes("--disable-dev-shm-usage"));
  } finally {
    delete process.env.MAGPIE_NO_SANDBOX;
  }
});
