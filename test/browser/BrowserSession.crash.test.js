import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { BrowserSession } from "../../src/browser/BrowserSession.js";

const FIXTURE = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "click-target.html")).href;

test("BrowserSession: onCrash fires and restart() recovers", async () => {
  const session = new BrowserSession({ url: FIXTURE, width: 400, height: 300 });
  await session.start();
  try {
    let crashed = 0;
    session.onCrash = () => { crashed++; };
    session._handleCrash();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(crashed, 1);

    await session.restart();
    assert.ok(session.getUrl().includes("click-target.html"));
  } finally {
    await session.stop();
  }
});

test("BrowserSession: onCrash re-entrancy guard", async () => {
  const session = new BrowserSession({ url: FIXTURE, width: 400, height: 300 });
  await session.start();
  try {
    let crashed = 0;
    session.onCrash = () => { crashed++; };
    session._handleCrash();
    session._handleCrash();
    session._handleCrash();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(crashed, 1, "onCrash should fire exactly once despite multiple _handleCrash calls");
  } finally {
    await session.stop();
  }
});

test("BrowserSession: onCrash guard resets after restart", async () => {
  const session = new BrowserSession({ url: FIXTURE, width: 400, height: 300 });
  await session.start();
  try {
    let crashed = 0;
    session.onCrash = () => { crashed++; };
    session._handleCrash();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(crashed, 1, "first crash should fire");

    await session.restart();
    crashed = 0;
    session._handleCrash();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(crashed, 1, "crash after restart should fire again (guard reset)");
  } finally {
    await session.stop();
  }
});
