/**
 * Web Worker entry: text-query's MCP server in the browser.
 *
 * SQL runs on geo-query-wasm's DuckDB-wasm engine, locked as it is there (SELECT only, reads
 * limited to allowed directories, configuration frozen). Each configured table is read once
 * into the engine's memory at start-up, so later queries never touch the network. Decision
 * calls go from this worker to the decision endpoint with fetch().
 *
 *   new Worker(`…/src/worker.js?config=${encodeURIComponent(JSON.stringify(cfg))}`, { type: 'module' })
 *
 * cfg:
 *   tables        { name: url } parquet files loaded as tables
 *   decision      { url, model } a Jev-compatible endpoint (default OpenRouter's systemone)
 *   instructions  corpus description, sent in the handshake and with each tool
 *   maxRows       rows per decide call (400)
 *   concurrency   decision requests in flight (12)
 *   engineUrl     geo-query-wasm's engine.js (default jsDelivr at a pinned commit)
 *   engine        options for createEngine (allowedDirectories, secrets, …)
 *
 * The decision token comes from the page with sendToken() (token.js), never the URL.
 */
import { PostMessageTransport } from './transport.js';
import { createServer } from './server.js';
import { decisionClient } from './decide.js';
import { TOKEN_MESSAGE } from './token.js';

export const ENGINE_URL = 'https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@dad59aa/src/engine.js';

let token = '';
self.addEventListener('message', (e) => {
    if (e.data?.type !== TOKEN_MESSAGE) return;
    e.stopImmediatePropagation();
    token = String(e.data.token ?? '');
    self.postMessage({ type: TOKEN_MESSAGE, id: e.data.id, ok: true });
});
const transport = new PostMessageTransport(self);

const cfg = JSON.parse(new URL(self.location.href).searchParams.get('config') ?? '{}');
const { createEngine } = await import(cfg.engineUrl ?? ENGINE_URL);
const engine = createEngine({ workers: 1, ...(cfg.engine ?? {}), lock: true });
const t0 = performance.now();
for (const [name, url] of Object.entries(cfg.tables ?? {})) {
    await engine.createTable(name, `SELECT * FROM read_parquet('${String(url).replace(/'/g, "''")}')`, { instance: 0 });
}
self.loadSeconds = (performance.now() - t0) / 1000;

const rows = async (sql, limit) => {
    const table = await engine.arrow(`SELECT * FROM (\n${sql.trim().replace(/;\s*$/, '')}\n) __q LIMIT ${limit + 1}`, { instance: 0 });
    return { columns: table.schema.fields.map(f => f.name), rows: table.toArray().map(r => r.toJSON()) };
};
const decision = { url: 'https://openrouter.ai/api/v1/systemone', model: '~typesafe/jev-latest', ...(cfg.decision ?? {}) };
await createServer({
    rows,
    ask: decisionClient({ url: decision.url, model: decision.model, token: () => token }),
    model: decision.model ?? new URL(decision.url).host,
    maxRows: cfg.maxRows ?? 400,
    concurrency: cfg.concurrency ?? 12,
    instructions: cfg.instructions,
}).connect(transport);
