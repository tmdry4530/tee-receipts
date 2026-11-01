// Tiny static server for the verify page (web/). Serves the repo root read-only on 127.0.0.1 so that
// web/index.html can fetch ../fixtures/testnet/receipt-bundle.json, exactly like GitHub Pages would.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const ALLOWED = ['web', 'fixtures'];

export function startServer(port = Number(process.env.PORT ?? 8787)) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') { res.writeHead(302, { location: '/web/' }); return res.end(); }
    const rel = normalize(path).replace(/^[/\\]+/, '');
    const file = join(ROOT, rel.endsWith(sep) || rel.endsWith('/') || rel === 'web' ? join(rel, 'index.html') : rel);
    if (!ALLOWED.includes(rel.split(/[/\\]/)[0]) || !file.startsWith(ROOT)) { res.writeHead(404); return res.end('not found'); }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startServer();
  console.log(`verify page: http://127.0.0.1:${s.address().port}/web/`);
}
