// Verifies the WebRTC-over-Docker path by acting as a real browser client.
// Run inside a container that shares the magpie server container's network
// namespace (--network container:magpie-net), so localhost:8080 is the server
// and WebRTC ICE host candidates are mutually reachable.
import { chromium } from "playwright";

// 1. Wait for the magpie server to finish booting (it listens only after
//    Chromium + goto(gitee.com) + streamer page + screencast all come up).
const deadline = Date.now() + 45000;
let up = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch("http://localhost:8080/healthz");
    if (r.ok) { up = true; console.log("HEALTHZ_OK"); break; }
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
if (!up) { console.error("HEALTHZ_TIMEOUT"); process.exit(1); }

// 2. Launch a headless client browser and open the client page.
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto("http://localhost:8080/?relay=1", { waitUntil: "domcontentloaded", timeout: 30000 });

  // 3. client.html with ?relay=1 forces iceTransportPolicy: relay, so
  //    RTCPeerConnection uses only TURN candidates (no host candidates).
  //    videoWidth>0 means the streamer's frames decoded via TURN relay.
  await page.waitForFunction(
    () => { const v = document.getElementById("v"); return v && v.videoWidth > 0; },
    { timeout: 30000 }
  );
  const vw = await page.evaluate(() => document.getElementById("v").videoWidth);
  const vh = await page.evaluate(() => document.getElementById("v").videoHeight);
  console.log(`VIDEO_OK videoWidth=${vw} videoHeight=${vh}`);
} finally {
  await browser.close();
}
