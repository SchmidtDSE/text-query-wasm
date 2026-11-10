// Benchmark server over HTTPS (HTTP/2 with HTTP/1.1 fallback), on 127.0.0.1:
//   /code/…                      files under CODE_ROOT (both repos), for the page and worker
//   /data/d<ms>/<path>           files under DATA_ROOT, with byte ranges and CORS, each
//                                response held <ms> to stand in for the round trip to S3
//   POST /decide/<ms>            a stub Jev endpoint: answers after ~<ms> (lognormal, sd 0.3),
//                                P(yes) from a hash of the text; GET /decide/stats gives the
//                                most requests in flight at once, then resets it
//
//   CODE_ROOT=… DATA_ROOT=… KEY=… CERT=… PORT=… node serve.mjs
import http2 from 'node:http2';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { CODE_ROOT, DATA_ROOT, KEY, CERT, PORT = 8443 } = process.env;
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.parquet': 'application/octet-stream' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges, ETag', 'access-control-max-age': '86400' };
let inFlight = 0, most = 0, total = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sendFile(req, res, file) {
    let st;
    try { st = fs.statSync(file); } catch { res.writeHead(404, CORS); return res.end(); }
    const head = { ...CORS, 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'accept-ranges': 'bytes',
        etag: `"${st.size}-${st.mtimeMs}"`, 'last-modified': st.mtime.toUTCString(), 'cache-control': 'no-store' };
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (m) {
        const start = +m[1], end = m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
        res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
}

const server = http2.createSecureServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT), allowHTTP1: true }, async (req, res) => {
    const url = new URL(req.url, 'https://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (url.pathname === '/decide/stats') {
        res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
        res.end(JSON.stringify({ most, total })); most = 0; total = 0; return;
    }
    let m;
    if ((m = /^\/decide\/(\d+)$/.exec(url.pathname)) && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        inFlight++; total++; most = Math.max(most, inFlight);
        const { state, questions } = JSON.parse(body);
        await sleep(+m[1] * Math.exp(0.3 * (Math.random() + Math.random() + Math.random() - 1.5) * 2));
        inFlight--;
        const h = crypto.createHash('sha256').update(state).digest();
        const answers = {};
        for (const [name, q] of Object.entries(questions)) {
            const p = h[name.length % 32] / 255;
            if (q.type === 'noul') answers[name] = { noul: p };
            else if (q.type === 'score') answers[name] = { score: p * (q.criteria.length - 1) };
            else { const labels = Object.keys(q.criteria); const c = labels[h[0] % labels.length]; answers[name] = { choice: c, probabilities: { [c]: 0.5 + p / 2 } }; }
        }
        res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ answers, usage: { cost: 0.00003 } }));
    }
    if ((m = /^\/data\/d(\d+)\/(.+)$/.exec(url.pathname))) {
        await sleep(+m[1]);
        return sendFile(req, res, path.join(DATA_ROOT, path.normalize(m[2]).replace(/^(\.\.[/\\])+/, '')));
    }
    if (url.pathname.startsWith('/code/')) {
        return sendFile(req, res, path.join(CODE_ROOT, path.normalize(url.pathname.slice(6)).replace(/^(\.\.[/\\])+/, '')));
    }
    res.writeHead(404, CORS); res.end();
});
server.listen(+PORT, '127.0.0.1', () => console.log(`ready https://127.0.0.1:${PORT}/`));
