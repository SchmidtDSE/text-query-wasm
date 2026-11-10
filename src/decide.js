/**
 * text-query's `decide` and `read_rows`, with no knowledge of where SQL runs or how the
 * decision model is reached. A port of text-query prototype/server.py: the same arguments,
 * validation, flattening, summary and output, so a client or model can use either.
 *
 *   rows(sql, limit)     → { columns, rows: [{col: value}] }, at most limit + 1 rows
 *   ask(state, questions) → { answers, cost }
 */

export const MAX_ROWS = 400;
export const READ_ROWS_CAP = 50;

export function checkQuestions(questions) {
    if (!questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length) {
        throw new Error('questions must be an object of named questions');
    }
    for (const [name, q] of Object.entries(questions)) {
        if (!['noul', 'choice', 'score'].includes(q?.type)) throw new Error(`${name}: type must be noul, choice or score`);
        if (!q.instructions) throw new Error(`${name}: instructions are required`);
        if (q.type === 'choice' && (typeof q.criteria !== 'object' || Array.isArray(q.criteria) || !q.criteria)) {
            throw new Error(`${name}: a choice question needs criteria as an object of label: description`);
        }
        if (q.type === 'score' && !Array.isArray(q.criteria)) {
            throw new Error(`${name}: a score question needs criteria as a list of levels, lowest first`);
        }
    }
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

export function flatten(answers, questions) {
    const row = {};
    for (const [name, q] of Object.entries(questions)) {
        const a = answers[name];
        if (q.type === 'noul') row[name] = round(a.noul, 3);
        else if (q.type === 'score') row[name] = round(a.score, 2);
        else { row[name] = a.choice; row[`${name}_p`] = round(a.probabilities[a.choice], 3); }
    }
    return row;
}

export function summarise(coded, questions) {
    const out = {};
    for (const [name, q] of Object.entries(questions)) {
        const vals = coded.map(r => r[name]);
        if (q.type === 'noul') {
            out[name] = { 'yes_at_0.5': vals.filter(v => v > 0.5).length, 'yes_at_0.7': vals.filter(v => v > 0.7).length,
                mean_p: round(vals.reduce((a, b) => a + b, 0) / vals.length, 3) };
        } else if (q.type === 'score') {
            out[name] = { mean: round(vals.reduce((a, b) => a + b, 0) / vals.length, 2) };
        } else {
            const counts = {};
            for (const v of vals) counts[v] = (counts[v] ?? 0) + 1;
            out[name] = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
        }
    }
    return out;
}

/** Run fn over items with at most n in flight, keeping order. */
export async function mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
    }));
    return out;
}

const plain = (v) => (v == null || ['number', 'string', 'boolean'].includes(typeof v) ? v : String(v));

export async function decide({ rows, ask, maxRows = MAX_ROWS, concurrency = 12, model = '' },
    { sql, questions, text_column = 'text', context_column = null, return_rows = 'positive', max_return = 40, include_text = false }) {
    checkQuestions(questions);
    const { columns, rows: recs } = await rows(sql, maxRows);
    if (recs.length > maxRows) {
        return { error: `the query returns more than ${maxRows} rows; narrow it, for example with a WHERE clause on folder, title or a keyword` };
    }
    if (!columns.includes(text_column)) return { error: `no column '${text_column}'; columns are ${JSON.stringify(columns)}` };
    if (!recs.length) return { n: 0, summary: {}, rows: [] };
    const states = recs.map(r => (context_column ? `${r[context_column]}\n\n` : '') + String(r[text_column]));
    const t0 = performance.now();
    const results = await mapLimit(states, concurrency, s => ask(s, questions));
    const coded = recs.map((rec, i) => {
        const out = {};
        for (const [k, v] of Object.entries(rec)) if (k !== text_column) out[k] = plain(v);
        if (include_text) { const t = String(rec[text_column]); out[text_column] = t.length <= 600 ? t : `${t.slice(0, 600)}…`; }
        return Object.assign(out, flatten(results[i].answers, questions));
    });
    const nouls = Object.entries(questions).filter(([, q]) => q.type === 'noul').map(([n]) => n);
    const top = (r) => Math.max(...nouls.map(n => r[n]));
    if (nouls.length) coded.sort((a, b) => top(b) - top(a));
    const shown = return_rows === 'positive' ? coded.filter(r => nouls.length && top(r) > 0.5)
        : return_rows === 'all' ? coded : [];
    return {
        n: coded.length, model, cost_usd: round(results.reduce((s, r) => s + (r.cost || 0), 0), 4),
        cached: results.filter(r => r.cached).length, seconds: round((performance.now() - t0) / 1000, 1),
        summary: summarise(coded, questions),
        rows_returned: Math.min(shown.length, max_return), rows_matching: shown.length, rows: shown.slice(0, max_return),
    };
}

export async function readRows({ rows }, { sql, max_rows = 20 }) {
    const cap = Math.min(max_rows, READ_ROWS_CAP);
    const { columns, rows: recs } = await rows(sql, cap);
    const out = recs.slice(0, cap).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) =>
        [k, typeof v === 'string' && v.length > 500 ? `${v.slice(0, 500)}…` : plain(v)])));
    return { columns, rows: out, truncated: recs.length > cap };
}

/**
 * A decision-model client: POSTs { state, questions, model? } with the bearer token, retries
 * with backoff, and caches answers by model, questions and text for the life of the page.
 */
export function decisionClient({ url, model, token = () => '', fetch: f = fetch, cacheSize = 200_000 }) {
    const cache = new Map();
    const key = async (state, questions) => {
        const buf = new TextEncoder().encode(JSON.stringify([model ?? null, questions, state]));
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), b => b.toString(16).padStart(2, '0')).join('');
    };
    return async (state, questions) => {
        const k = await key(state, questions);
        if (cache.has(k)) { const a = cache.get(k); cache.delete(k); cache.set(k, a); return { answers: a, cost: 0, cached: true }; }
        const body = JSON.stringify({ state, questions, ...(model ? { model } : {}) });
        for (let attempt = 0; ; attempt++) {
            try {
                const r = await f(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` } });
                if (!r.ok) throw new Error(`decision model: HTTP ${r.status}`);
                const out = await r.json();
                cache.set(k, out.answers);
                if (cache.size > cacheSize) cache.delete(cache.keys().next().value);
                return { answers: out.answers, cost: out.usage?.cost ?? 0, cached: false };
            } catch (err) {
                if (attempt === 3) throw err;
                await new Promise(res => setTimeout(res, 1000 * 2 ** attempt));
            }
        }
    };
}
