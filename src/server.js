import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_HTML = path.join(__dirname, "public", "client.html");
const STREAMER_HTML = path.join(__dirname, "streamer", "streamer.html");

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

    send({ t: "hello", viewport: browserSession.getViewport(), url: browserSession.getUrl(), iceServers: clientIceServers });

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try {
        if (msg.t === "offer") {
          const sdp = await streamerPeer.relayOffer(msg.sdp);
          send({ t: "answer", sdp });
        } else if (msg.t === "navigate") {
          await browserSession.navigate(msg.url);
          send({ t: "navigate-result", ok: true, url: browserSession.getUrl() });
        } else if (msg.t === "status") {
          send({ t: "status", viewport: browserSession.getViewport(), url: browserSession.getUrl() });
        } else if (msg.t === "mouse" || msg.t === "wheel" || msg.t === "key") {
          await inputChannel.handle(raw.toString());
        }
      } catch (err) {
        send({ t: "error", error: String((err && err.message) || err) });
      }
    });
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
