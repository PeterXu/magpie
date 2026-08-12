import { EventEmitter } from './EventEmitter.js';
import console from './logger.js';

export class MagpieCanvasMedia extends EventEmitter {
  TAG = '[MagpieCanvasMedia]';

  constructor(options = {}) {
    super();

    this.canvas = options.canvas;
    this.ctx = this.canvas.getContext("2d");

    this.url = options.url;
    this.ws = null;
    this.wsConnected = false;

    this._pendingData = null;
    this._processing = false;
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
    console.log(this.TAG, `setParams ws=${this.url}, params=`, JSON.stringify(this.params));
  }

  createLocalStream() {
    console.log(this.TAG, `capture stream fps=`, this.params.FPS);
    return this.canvas.captureStream(this.params.FPS);
  }

  // Receive JPEG frames from Node and draw them.
  connectSource() {
    console.log(this.TAG, 'create ws connection to receive frames');
  
    if (!!this.ws) {
      this.ws.close();
      this.ws = null;
    }

    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.wsConnected = true;
      console.log(this.TAG, 'ws connected url=', this.url);
    };
    ws.onmessage = async (e) => {await this.feedImage(e.data);};
    ws.onclose = () => {
      console.log(this.TAG, 'ws closed');
      this.wsConnected = false;
    };

    this.ws = ws;
  }

  async feedImage(data) {
    this._pendingData = data;
    if (this._processing) return;        // 已有处理在进行，最新帧会在循环里被取到

    this._processing = true;
    try {
      while (this._pendingData != null) {
        const d = this._pendingData;
        this._pendingData = null;
        try {
          const bmp = await createImageBitmap(new Blob([d]));
          this.ctx.drawImage(bmp, 0, 0, this.params.W, this.params.H);
          if (this.lastFrame) this.lastFrame.close();
          this.lastFrame = bmp;
        } catch {}
      }
    } finally {
      this._processing = false;
    }
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