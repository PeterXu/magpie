import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_HTML = path.join(__dirname, "public", "client.html");
const CURSOR_SVG = path.join(__dirname, "public", "cursor.svg");
const STREAMER_HTML = path.join(__dirname, "streamer", "streamer.html");
const CODEC_PICK_JS = path.join(__dirname, "webrtc", "codec-pick.js");

async function serveFile(res, file, type) {
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

export function createServer({ browserSession, inputChannel, streamerPeer, clientIceServers = [] }) {
  const server = http.createServer();

  server.on("request", (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
    if (url.pathname === "/" || url.pathname === "/client.html") return serveFile(res, CLIENT_HTML, "text/html; charset=utf-8");
    if (url.pathname === "/streamer.html") return serveFile(res, STREAMER_HTML, "text/html; charset=utf-8");
    if (url.pathname === "/cursor.svg") return serveFile(res, CURSOR_SVG, "image/svg+xml");
    if (url.pathname === "/codec-pick.js") return serveFile(res, CODEC_PICK_JS, "text/javascript");
    res.writeHead(404); res.end("not found");
  });

  const signaling = new WebSocketServer({ noServer: true });
  const internal = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);

    if (pathname === "/signaling") {
      signaling.handleUpgrade(request, socket, head, (ws) => {
        signaling.emit("connection", ws, request);
      });
    } else if (pathname === "/internal") {
      internal.handleUpgrade(request, socket, head, (ws) => {
        internal.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  signaling.on("connection", (ws) => {
    const send = (obj) => {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore send errors */ }
      }
    };

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try {
        if (msg.t === "offer") {
          const sdp = await streamerPeer.relayOffer(msg.sdp);
          send({ t: "answer", sdp });
        } else if (msg.t === "navigate") {
          await browserSession.navigate(msg.url);
          // No direct response: the resulting navigation fires framenavigated,
          // which broadcasts {t:"nav",url,canBack,canForward} to every client
          // (wired in index.js). The same path covers back/forward/reload and
          // passive link-clicks inside the remote page.
        } else if (msg.t === "back") {
          await browserSession.goBack();
        } else if (msg.t === "forward") {
          await browserSession.goForward();
        } else if (msg.t === "refresh") {
          // "refresh" (not "reload"): the crash-recovery broadcast {t:"reload"}
          // means "reload the CLIENT page" — this is "reload the REMOTE page".
          await browserSession.reload();
        } else if (msg.t === "status") {
          send({ t: "status", viewport: browserSession.getViewport(), url: browserSession.getUrl() });
        } else if (msg.t === "mouse" || msg.t === "wheel" || msg.t === "key") {
          await inputChannel.handle(raw.toString());
        }
      } catch (err) {
        send({ t: "error", error: String((err && err.message) || err) });
      }
    });

    // hello carries the initial nav state (url + canBack/canForward) so the
    // toolbar buttons start correct. getNavState is async (CDP history); the
    // message handler above is already registered, so no early send is lost.
    void (async () => {
      const nav = await browserSession.getNavState();
      send({ t: "hello", viewport: browserSession.getViewport(), url: nav.url, canBack: nav.canBack, canForward: nav.canForward, iceServers: clientIceServers, magpieCodecs: streamerPeer.getSenderCodecs() });
    })();
  });

  server.broadcast = (obj) => {
    const m = JSON.stringify(obj);
    for (const c of signaling.clients) if (c.readyState === c.OPEN) c.send(m);
  };

  internal.on("connection", (ws) => {
    streamerPeer.setFrameSocket(ws);
  });

  return server;
}
