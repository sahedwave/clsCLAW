
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const MIME = {
  '.html':'text/html','.css':'text/css','.js':'application/javascript',
  '.json':'application/json','.png':'image/png','.ico':'image/x-icon',
  '.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf',
};

class Router {
  constructor() {
    this._routes = [];  
    this._staticDir = null;
  }

  static(dir) { this._staticDir = dir; }

  _add(method, pattern, handler) {
    
    const rx = new RegExp('^' + pattern.replace(/:(\w+)/g,'(?<$1>[^/]+)') + '$');
    this._routes.push({ method, rx, handler, pattern });
  }

  get(p, h)    { this._add('GET', p, h); }
  post(p, h)   { this._add('POST', p, h); }
  delete(p, h) { this._add('DELETE', p, h); }
  patch(p, h)  { this._add('PATCH', p, h); }

  handler() {
    return async (req, res) => {
      
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,PATCH,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      const urlObj = new URL(req.url, `http://localhost`);
      const pathname = decodeURIComponent(urlObj.pathname);

      
      req.query = Object.fromEntries(urlObj.searchParams);
      req.body = {};
      if (['POST','PATCH','PUT'].includes(req.method)) {
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString();
          if (raw) req.body = JSON.parse(raw);
        } catch {}
      }

      
      res.json = (data, code=200) => {
        const body = JSON.stringify(data);
        res.writeHead(code, {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)});
        res.end(body);
      };
      res.status = (code) => { res._statusCode = code; return res; };

      
      if (pathname === '/api/events') {
        const match = this._routes.find(r => r.method==='GET' && r.rx.test('/api/events'));
        if (match) { match.handler(req, res); return; }
      }

      
      for (const route of this._routes) {
        if (route.method !== req.method) continue;
        const m = pathname.match(route.rx);
        if (m) {
          req.params = m.groups || {};
          try { await route.handler(req, res); } catch(e) {
            if (!res.headersSent) res.json({ error: e.message }, 500);
          }
          return;
        }
      }

      
      if (this._staticDir && req.method === 'GET') {
        let filePath = path.join(this._staticDir, pathname === '/' ? 'index.html' : pathname);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath);
          const content = fs.readFileSync(filePath);
          res.writeHead(200, {'Content-Type': MIME[ext]||'application/octet-stream'});
          res.end(content);
          return;
        }
        
        const idx = path.join(this._staticDir, 'index.html');
        if (fs.existsSync(idx)) {
          res.writeHead(200, {'Content-Type':'text/html'});
          res.end(fs.readFileSync(idx));
          return;
        }
      }

      res.json({ error: 'Not found: ' + pathname }, 404);
    };
  }

  createServer() {
    return http.createServer(this.handler());
  }
}

module.exports = Router;
