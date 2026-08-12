import { EventEmitter } from './EventEmitter.js';

export class MagpieCanvasMedia extends EventEmitter {
  constructor(options = {}) {
    super();

    this.canvas = options.canvas;
    this.ctx = this.canvas.getContext("2d");

    this.wsUrl = options.wsUrl;
    this.ws = null;
    this.wsConnected = false;

    this.drawIntervalId = -1;
    this.lastFrame = false;

    this.params = {};
    this.setParams(options);
  }

  getParams() {return this.params;}

  setParams(options) {
    const W = Number(options.W || 1280);
    const H = Number(options.H || 800);
    const FPS = Number(options.FPS || 10);             // captureStream rate; default 10
    const BITRATE = Number(options.BITRATE || 0);      // sender maxBitrate (bps); 0 = unset
    const MAXFPS = Number(options.MAXFPS || 0);        // sender maxFramerate; 0 = unset
    const DEGRADATION = options.DEGRADATION || "";     // sender degradationPreference; "" = unset

    this.canvas.width = W;
    this.canvas.height = H;
    this.params = {W, H, FPS, BITRATE, MAXFPS, DEGRADATION};
    console.log(`[MagpieCanvasMedia] set ws=${this.wsUrl}, params=`, JSON.stringify(this.params));
  }

  createLocalStream() {
    console.log(`[MagpieCanvasMedia] capture stream fps=`, this.params.FPS);
    return this.canvas.captureStream(this.params.FPS);
  }

  // Receive JPEG frames from Node and draw them.
  connectSource() {
    console.log('[MagpieCanvasMedia] create ws connection to receive frames');
  
    if (!!this.ws) {
      this.ws.close();
      this.ws = null;
    }

    const ws = new WebSocket(this.wsUrl);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.wsConnected = true;
      console.log('[MagpieCanvasMedia] ws connected url=', this.wsUrl);
    };

    ws.onmessage = async (e) => {
      try {
        const bmp = await createImageBitmap(new Blob([e.data]));
        this.ctx.drawImage(bmp, 0, 0, this.params.W, this.params.H);
        if (this.lastFrame) this.lastFrame.close();
        this.lastFrame = bmp;
      } catch {}
    };

    ws.onclose = () => {
      console.log('[MagpieCanvasMedia] ws closed');
      this.wsConnected = false;
    };

    this.ws = ws;
  }

  // Force the canvas to continuously update so captureStream generates frames
  // even when no new JPEG frames arrive. This is needed because captureStream
  // only generates frames when the canvas changes.
  startDrawLoop() {
    this.drawIntervalId = setInterval(() => {
      if (this.lastFrame) {
        this.ctx.drawImage(this.lastFrame, 0, 0);
      }
    }, 50);
  }

  destroy() {
    clearInterval(this.drawIntervalId);
    this.drawIntervalId = -1;

    if (this.ws) {
        this.ws.close();
        this.ws = null;
    }

    if (this.lastFrame) {
        this.lastFrame.close();
        this.lastFrame = null;
    }

    this.ctx = null;
  }
}