import { EventEmitter } from './EventEmitter.js';
import { MagpieCanvasMedia } from './MagpieCanvasMedia.js';
import { MagpieConnection } from './MagpieConnection.js';

export class MagpieStreamPeer extends EventEmitter {
  constructor(options = {}) {
    super();

    this.canvasMedia = null;
    this.connection = null;
  }

  setCanvasStream(options) {
    this.canvasMedia = new MagpieCanvasMedia(options);
    this.canvasMedia.connectSource();
    this.canvasMedia.startDrawLoop();
  }

  async relayOffer(offer, iceServers, params) {
    // 清理旧连接
    this.connection?.close();

    // 准备流
    let stream = this.canvasMedia.createLocalStream();

    // 创建新连接
    this.connection = new MagpieConnection(null, this, {});
    let answer = await this.connection.startHandshake(stream, {offer, iceServers, ...params});
    return answer;
  }

  _removeConnection() {
    this.connection = null;
  }
}