#!/usr/bin/env node
// text-query-wasm benchmarks in headless Chrome against the native results (native.py).
//
//   node browser.mjs sql      SQL on DuckDB-wasm (geo-query-wasm's engine, locked), per scale:
//                             remote range reads at 0 and 40 ms per request, cold and warm, and
//                             tables loaded into memory first
//   node browser.mjs decide   decide through the MCP worker, against the stub decision endpoint
//
// Env: DATA_ROOT, KEY, CERT (for serve.mjs), SCALES (default 1,10,100), OUT (results JSON)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, summarize } from './chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8443, BASE = `https://127.0.0.1:${PORT}`;
const PAGE = `${BASE}/code/text-query-wasm/bench/bench.html`;
const ENGINE = `${BASE}/code/geo-query-wasm/src/engine.js`;
const SCALES = (process.env.SCALES ?? '1,10,100').split(',');
const QUERIES = JSON.parse(fs.readFileSync(path.join(HERE, 'queries.json'), 'utf8'));
const mode = process.argv[2] ?? 'sql';
const OUT = process.env.OUT ?? path.join(HERE, `results-${mode}.json`);

const server = spawn('node', [path.join(HERE, 'serve.mjs')], {
    env: { ...process.env, CODE_ROOT: path.resolve(HERE, '../..'), PORT }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => server.stdout.on('data', d => String(d).includes('ready') && r()));
const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const save = () => fs.writeFileSync(OUT, JSON.stringify(results, null, 2));

async function page() {
    const chrome = await launchChrome();
    await chrome.open(PAGE);
    return chrome;
}

// Run one query in the page; returns { s, rows } or { error }.
const runIn = (chrome, sql, opts = {}) => chrome.evaluate(`(async () => {
    const t0 = performance.now();
    try { const rows = await window.engine.query(${JSON.stringify(sql)}, ${JSON.stringify(opts)});
          return { s: (performance.now() - t0) / 1000, rows: rows.length }; }
    catch (e) { return { error: String(e.message ?? e).slice(0, 300), s: (performance.now() - t0) / 1000 }; } })()`);

async function sqlBench(scale, variant) {
    const chrome = await page();
    const out = { chrome: chrome.version, queries: {} };
    try {
        const t0 = Date.now();
        await chrome.evaluate(`(async () => {
            const { createEngine } = await import('${ENGINE}');
            window.engine = createEngine({ allowedDirectories: ['${BASE}/'], timeout: 600 });
            await window.engine.ready(); })()`);
        out.startup_s = (Date.now() - t0) / 1000;
        const delay = variant === 'remote-d0' ? 0 : 40;
        const url = (t) => `${BASE}/data/d${delay}/x${scale}/${t}.parquet`;
        let tables = { passages: `read_parquet('${url('passages')}')`, coded: `read_parquet('${url('coded')}')` };
        const opts = {};
        if (variant === 'memory') {
            chrome.setPhase('load');
            const r = await chrome.evaluate(`(async () => { const t0 = performance.now();
                try { for (const t of ['passages', 'coded']) await window.engine.createTable(t, "SELECT * FROM read_parquet('${BASE}/data/d${delay}/x${scale}/" + t + ".parquet')", { instance: 0 });
                      return { s: (performance.now() - t0) / 1000 }; }
                catch (e) { return { error: String(e.message ?? e).slice(0, 300), s: (performance.now() - t0) / 1000 }; } })()`);
            const net = summarize(chrome.requests, 'load');
            out.load = { ...r, requests: net.requests, mb: net.mb, inFlight: net.inFlight };
            console.log(`  x${scale} ${variant} load`, out.load);
            if (r.error) { out.peak_mb = Math.round((await chrome.memory()) / 1e6); return out; }
            tables = { passages: 'passages', coded: 'coded' };
            opts.instance = 0;
        }
        for (const q of QUERIES) {
            const sql = q.sql.replace('{passages}', tables.passages).replace('{coded}', tables.coded);
            const r = {};
            for (const run of ['cold', 'warm']) {
                chrome.setPhase(`${q.id}-${run}`);
                const x = await runIn(chrome, sql, opts);
                const net = summarize(chrome.requests, `${q.id}-${run}`);
                r[run] = { ...x, requests: net.requests, mb: net.mb, inFlight: net.inFlight };
            }
            out.queries[q.id] = r;
            console.log(`  x${scale} ${variant} ${q.id}`, JSON.stringify(r));
        }
        out.peak_mb = Math.round((await chrome.memory()) / 1e6);
    } finally {
        await chrome.close();
    }
    return out;
}

// decide through the MCP worker: raw JSON-RPC over postMessage.
async function decideBench({ latency, concurrency, n, questions }) {
    const chrome = await page();
    try {
        const cfg = { engineUrl: ENGINE, engine: { allowedDirectories: [`${BASE}/`] },
            tables: { passages: `${BASE}/data/d40/x1/passages.parquet` },
            decision: { url: `${BASE}/decide/${latency}`, model: 'stub' }, concurrency, maxRows: 400 };
        const t0 = Date.now();
        await chrome.evaluate(`(async () => {
            const w = new Worker('${BASE}/code/text-query-wasm/src/worker.js?config=' + encodeURIComponent(${JSON.stringify(JSON.stringify(cfg))}), { type: 'module' });
            let id = 0; const pending = new Map();
            w.onmessage = (e) => { const m = e.data; if (m?.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
            window.rpc = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); w.postMessage({ jsonrpc: '2.0', id: i, method, params }); });
            const { sendToken } = await import('${BASE}/code/text-query-wasm/src/token.js');
            await sendToken(w, 'not-a-real-key');
            const init = await window.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '0' } });
            w.postMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
            return init; })()`);
        const startup = (Date.now() - t0) / 1000;
        await fetch(`${BASE}/decide/stats`).catch(() => {});
        const call = (args) => chrome.evaluate(`(async () => { const t0 = performance.now();
            const r = await window.rpc('tools/call', { name: 'decide', arguments: ${JSON.stringify(args)} });
            return { s: (performance.now() - t0) / 1000, text: r.result?.content?.[0]?.text?.slice(0, 400), error: r.error?.message }; })()`);
        const sql = `SELECT passage_id, title, page, text FROM passages ORDER BY passage_id LIMIT ${n}`;
        const first = await call({ sql, questions, context_column: 'title', return_rows: 'none' });
        const stats = await (await fetch(`${BASE}/decide/stats`, { dispatcher: undefined })).json().catch(() => null);
        const again = await call({ sql, questions, context_column: 'title', return_rows: 'none' });
        return { startup_s: startup, first_s: first.s, cached_s: again.s, server: stats, sample: first.text ?? first.error };
    } finally {
        await chrome.close();
    }
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
try {
    if (mode === 'sql') {
        for (const scale of SCALES) for (const variant of ['remote-d0', 'remote-d40', 'memory']) {
            const key = `x${scale}/${variant}`;
            if (results[key] && !process.env.FORCE) continue;
            console.log(key);
            results[key] = await sqlBench(scale, variant).catch(e => ({ error: String(e.message ?? e) }));
            save();
        }
    } else {
        const Q = {
            relevant: { type: 'noul', instructions: 'Does this paragraph report results on seamount fauna?' },
            zone: { type: 'choice', instructions: 'Which depth zone?', criteria: { shallow: 'above 200 m', deep: 'below 200 m', none: 'not stated' } },
            strength: { type: 'score', instructions: 'How strong is the evidence?', criteria: ['anecdote', 'single survey', 'several surveys', 'time series'] },
        };
        for (const latency of [1000, 3000]) for (const concurrency of [6, 12, 24]) {
            const key = `browser/lat${latency}/c${concurrency}`;
            if (results[key] && !process.env.FORCE) continue;
            results[key] = await decideBench({ latency, concurrency, n: 400, questions: Q });
            console.log(key, JSON.stringify(results[key]).slice(0, 300));
            save();
        }
    }
} finally {
    server.kill();
}
