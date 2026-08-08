import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import { StreamerPeer } from "../../src/streamer/StreamerPeer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STREAMER_HTML = path.join(__dirname, "..", "..", "src", "streamer", "streamer.html");

// A 1x1 PNG (valid, dependency-free) used to push at least one frame.
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const CLIENT_HTML = `<!DOCTYPE html><html><body>
<video id="v" autoplay playsinline muted></video>
<script>
window.pc = new RTCPeerConnection();
window.pc.addTransceiver("video", { direction: "recvonly" });
window.pc.ontrack = (e) => { document.getElementById("v").srcObject = e.streams[0]; };
window.makeOffer = async () => {
  const o = await window.pc.createOffer();
  await window.pc.setLocalDescription(o);
  await new Promise((r) => { const t = setTimeout(r, 3000); window.pc.onicegatheringstatechange = () => { if (window.pc.iceGatheringState === "complete") { clearTimeout(t); r(); } }; });
  return window.pc.localDescription.sdp;
};
window.setAnswer = async (a) => {
    await window.pc.setRemoteDescription({ type: "answer", sdp: a });
    // ontrack is unreliable in headless Chromium; attach the receiver track by polling.
    for (let i = 0; i < 50; i++) {
      const r = window.pc.getReceivers().find((r) => r.track && r.track.kind === "video");
      if (r && r.track) { document.getElementById("v").srcObject = new MediaStream([r.track]); return; }
      await new Promise((res) => setTimeout(res, 100));
    }
  };
</script></body></html>`;

test("StreamerPeer: relays offer and streams pushed frames to a client peer", async () => {
  const browser = await chromium.launch({ headless: true });
  const html = await readFile(STREAMER_HTML, "utf8");

  const httpServer = http.createServer((req, res) => {
    if (req.url.startsWith("/streamer.html")) { res.writeHead(200, { "content-type": "text/html" }); return res.end(html); }
    res.writeHead(404); res.end();
  });
  const internalWss = new WebSocketServer({ server: httpServer, path: "/internal" });

  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = httpServer.address().port;

  try {
    const sp = new StreamerPeer({ browser });
    internalWss.on("connection", (ws) => sp.setFrameSocket(ws));
    await sp.start({ streamerUrl: `http://127.0.0.1:${port}/streamer.html?w=16&h=16` });

    // Client peer (real libwebrtc) in a second page.
    const clientPage = await browser.newPage();
    await clientPage.setContent(CLIENT_HTML);
    const offer = await clientPage.evaluate(() => window.makeOffer());
    const answer = await sp.relayOffer(offer);
    await clientPage.evaluate((a) => window.setAnswer(a), answer);

    // Push frames so the track unmutes.
    const pump = setInterval(() => sp.pushFrame(PNG_1x1), 100);
    try {
      await clientPage.waitForFunction(() => document.getElementById("v").videoWidth > 0, { timeout: 8000 });
      const vw = await clientPage.evaluate(() => document.getElementById("v").videoWidth);
      assert.ok(vw > 0, "client should receive video from the streamer page");
    } finally {
      clearInterval(pump);
    }

    await clientPage.close();
    await sp.stop();
  } finally {
    internalWss.close();
    httpServer.close();
    await browser.close();
  }
});
