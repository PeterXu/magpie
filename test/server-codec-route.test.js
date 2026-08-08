import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";

test("server: serves /codec-pick.js as text/javascript with the pickCodec export", async () => {
  const server = createServer({ browserSession: {}, inputChannel: {}, streamerPeer: { getSenderCodecs: () => [] }, clientIceServers: [] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/codec-pick.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/javascript");
    const body = await res.text();
    assert.match(body, /export function pickCodec/);
  } finally {
    server.close();
  }
});
