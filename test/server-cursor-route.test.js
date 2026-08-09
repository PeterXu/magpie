import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";

test("server: serves /cursor.svg as image/svg+xml", async () => {
  const server = createServer({ browserSession: {}, inputChannel: {}, streamerPeer: { getSenderCodecs: () => [] }, clientIceServers: [] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/cursor.svg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/svg+xml");
    const body = await res.text();
    assert.match(body, /<svg/);
    assert.match(body, /#0d9488/);  // teal — the distinct-from-OS accent
  } finally {
    server.close();
  }
});
