/**
 * text-query's MCP surface (decide, read_rows) over any SQL engine and decision client.
 * worker.js gives it DuckDB-wasm and fetch(); tests give it stubs.
 */
import { Server, ListToolsRequestSchema, CallToolRequestSchema } from '../vendor/mcp-server-sdk.js';
import { decide, readRows, MAX_ROWS } from './decide.js';

export const NAME = 'text-query-wasm';
export const VERSION = '0.1.0';

const DECIDE = `Answer typed questions about each row's text with a decision model.

sql: DuckDB SQL returning one row per text, with at most MAX_ROWS rows (default ${MAX_ROWS}). Keep
    id columns such as passage_id, title and page so answers can be cited.
questions: named questions in the Jev format, for example
    {"vents": {"type": "noul", "instructions": "Does this paragraph describe hydrothermal vent fauna?"},
     "depth": {"type": "choice", "instructions": "Which depth zone?",
               "criteria": {"shallow": "above 200 m", "deep": "below 200 m", "none": "not stated"}},
     "strength": {"type": "score", "instructions": "How strong is the evidence?",
                  "criteria": ["anecdote", "single survey", "several surveys", "time series"]}}
    noul returns P(yes); choice returns a label and its probability; score returns the
    expected level, counting from 0. Phrase questions about one paragraph.
text_column: the column the questions are asked about.
context_column: optional column prefixed to each text, such as a paper title.
return_rows: "positive" (rows where any yes/no question is above 0.5), "all" or "none".
max_return: the most rows to return.
include_text: return each row's text, truncated to 600 characters, to quote evidence.`;

const READ_ROWS = `Run DuckDB SQL and return up to max_rows rows (at most 50), with strings over 500
characters truncated. Use it to inspect tables, count passages or read evidence.`;

export function createServer({ rows, ask, model, maxRows, concurrency, instructions }) {
    const server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: {} }, instructions });
    const withCorpus = (d) => (instructions ? `${d}\n\n${instructions}` : d);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            { name: 'decide', description: withCorpus(DECIDE), inputSchema: { type: 'object', required: ['sql', 'questions'], properties: {
                sql: { type: 'string' }, questions: { type: 'object' }, text_column: { type: 'string', default: 'text' },
                context_column: { type: 'string' }, return_rows: { type: 'string', default: 'positive' },
                max_return: { type: 'integer', default: 40 }, include_text: { type: 'boolean', default: false } } } },
            { name: 'read_rows', description: withCorpus(READ_ROWS), inputSchema: { type: 'object', required: ['sql'], properties: {
                sql: { type: 'string' }, max_rows: { type: 'integer', default: 20 } } } },
        ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: args = {} } = req.params;
        try {
            const out = name === 'decide' ? await decide({ rows, ask, model, maxRows, concurrency }, args)
                : name === 'read_rows' ? await readRows({ rows }, args)
                : null;
            if (!out) throw new Error(`Unknown tool: ${name}`);
            return { content: [{ type: 'text', text: JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? Number(v) : v)) }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
    });
    return server;
}
