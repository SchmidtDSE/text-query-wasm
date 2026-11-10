import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkQuestions, decide, readRows, decisionClient, mapLimit } from '../src/decide.js';

const Q = { v: { type: 'noul', instructions: 'vents?' }, z: { type: 'choice', instructions: 'zone?', criteria: { a: 'A', b: 'B' } } };
const rows = (recs) => async (sql, limit) => ({ columns: Object.keys(recs[0] ?? { text: 1 }), rows: recs.slice(0, limit + 1) });
const ask = async (state) => ({ answers: { v: { noul: state.includes('vent') ? 0.9 : 0.1 }, z: { choice: 'a', probabilities: { a: 0.8 } } }, cost: 0.01 });

test('validates questions as the server does', () => {
    assert.throws(() => checkQuestions({}), /object of named/);
    assert.throws(() => checkQuestions({ x: { type: 'yes' } }), /noul, choice or score/);
    assert.throws(() => checkQuestions({ x: { type: 'choice', instructions: 'i', criteria: [] } }), /criteria as an object/);
    checkQuestions(Q);
});

test('decide sorts, filters and summarises like text-query', async () => {
    const recs = [{ id: 1, text: 'fisheries' }, { id: 2, text: 'vent fauna' }];
    const out = await decide({ rows: rows(recs), ask, model: 'm' }, { sql: 'x', questions: Q, include_text: true });
    assert.equal(out.n, 2);
    assert.equal(out.cost_usd, 0.02);
    assert.deepEqual(out.summary.v, { 'yes_at_0.5': 1, 'yes_at_0.7': 1, mean_p: 0.5 });
    assert.deepEqual(out.rows, [{ id: 2, text: 'vent fauna', v: 0.9, z: 'a', z_p: 0.8 }]);
});

test('decide refuses too many rows and a missing column', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ text: `t${i}` }));
    assert.match((await decide({ rows: rows(many), ask, maxRows: 3 }, { sql: 'x', questions: Q })).error, /more than 3/);
    assert.match((await decide({ rows: rows([{ body: 'x' }]), ask }, { sql: 'x', questions: Q })).error, /no column 'text'/);
});

test('read_rows caps rows and truncates text', async () => {
    const recs = Array.from({ length: 60 }, (_, i) => ({ text: 'x'.repeat(600), i }));
    const out = await readRows({ rows: rows(recs) }, { sql: 'x', max_rows: 100 });
    assert.equal(out.rows.length, 50);
    assert.equal(out.truncated, true);
    assert.equal(out.rows[0].text.length, 501);
});

test('mapLimit keeps order and bounds concurrency', async () => {
    let now = 0, most = 0;
    const out = await mapLimit([5, 1, 3, 2], 2, async (x) => { most = Math.max(most, ++now); await new Promise(r => setTimeout(r, x)); now--; return x * 2; });
    assert.deepEqual(out, [10, 2, 6, 4]);
    assert.equal(most, 2);
});

test('the decision client sends the token, retries and caches', async () => {
    const calls = [];
    const f = async (url, init) => {
        calls.push(init.headers.Authorization);
        if (calls.length === 1) return { ok: false, status: 502 };
        return { ok: true, json: async () => ({ answers: { v: { noul: 0.5 } }, usage: { cost: 0.001 } }) };
    };
    const askReal = decisionClient({ url: 'u', model: 'm', token: () => 'tok', fetch: f });
    const a = await askReal('text', Q);
    assert.equal(a.cached, false);
    assert.deepEqual(calls, ['Bearer tok', 'Bearer tok']);
    const b = await askReal('text', Q);
    assert.equal(b.cached, true);
    assert.equal(calls.length, 2);
});
