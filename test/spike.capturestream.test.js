import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const STREAMER_HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="64" height="64"></canvas>
<script>
const c = document.getElementById("c"), x = c.getContext("2d");
const stream = c.captureStream(10);
window.pc = null;
window.setupAndAnswer = async (offer) => {
  window.pc = new RTCPeerConnection();
  window.pc.addTrack(stream.getVideoTracks()[0]);
  await window.pc.setRemoteDescription({ type: "offer", sdp: offer });
  const a = await window.pc.createAnswer();
  await window.pc.setLocalDescription(a);
  await new Promise((r) => {
    const t = setTimeout(r, 3000);
    window.pc.onicegatheringstatechange = () => { if (window.pc.iceGatheringState === "complete") { clearTimeout(t); r(); } };
  });
  return window.pc.localDescription.sdp;
};
let i = 0;
setInterval(() => { x.fillStyle = "hsl(" + ((i++ * 10) % 360) + ",100%,50%)"; x.fillRect(0, 0, 64, 64); }, 100);
</script></body></html>`;

const CLIENT_HTML = `<!DOCTYPE html><html><body>
<video id="v" autoplay playsinline muted></video>
<script>
window.pc = new RTCPeerConnection();
window.pc.addTransceiver("video", { direction: "recvonly" });
window.pc.ontrack = (e) => { document.getElementById("v").srcObject = e.streams[0]; };
window.makeOffer = async () => {
  const o = await window.pc.createOffer();
  await window.pc.setLocalDescription(o);
  await new Promise((r) => {
    const t = setTimeout(r, 3000);
    window.pc.onicegatheringstatechange = () => { if (window.pc.iceGatheringState === "complete") { clearTimeout(t); r(); } };
  });
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

test("spike: headless captureStream -> WebRTC reaches a receiver page", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const a = await browser.newPage();
    const b = await browser.newPage();
    await a.setContent(STREAMER_HTML);
    await b.setContent(CLIENT_HTML);

    const offer = await b.evaluate(() => window.makeOffer());
    const answer = await a.evaluate((o) => window.setupAndAnswer(o), offer);
    await b.evaluate((ans) => window.setAnswer(ans), answer);

    await b.waitForFunction(() => { const v = document.getElementById("v"); return v && v.videoWidth > 0; }, { timeout: 8000 });
    const vw = await b.evaluate(() => document.getElementById("v").videoWidth);
    assert.ok(vw > 0, "receiver should have decoded video frames");
  } finally {
    await browser.close();
  }
});
