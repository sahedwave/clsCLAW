/**
 * sse.js — Server-Sent Events broadcast (replaces WebSocket)
 * No external deps. Works in all browsers natively.
 */
'use strict';

class SSEBroadcaster {
  constructor() { this._clients = new Set(); }

  middleware() {
    return (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('data: {"type":"connected","version":"4.0.0"}\n\n');
      this._clients.add(res);
      req.on('close', () => this._clients.delete(res));
    };
  }

  broadcast(type, payload) {
    const data = JSON.stringify({ type, ...payload, ts: Date.now() });
    const msg = `data: ${data}\n\n`;
    for (const client of this._clients) {
      try { client.write(msg); } catch { this._clients.delete(client); }
    }
  }
}

module.exports = new SSEBroadcaster();
