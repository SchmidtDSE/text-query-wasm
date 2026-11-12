# text-query-wasm

text-query-wasm is [text-query](https://github.com/SchmidtDSE/text-query)'s MCP server running in the browser, as [geo-query-wasm](https://github.com/SchmidtDSE/geo-query-wasm) is for geo-query. A Web Worker serves text-query's two tools, `decide` and `read_rows`, over `postMessage`. SQL runs on geo-query-wasm's DuckDB-wasm engine, locked as it is there, and decision calls go from the worker straight to the decision endpoint with `fetch()`.

**Status:** prototype. It runs the full `decide` path in headless Chrome against a stub decision endpoint; it has not been run against Jev or a real corpus.

## Architecture

```
page: any MCP client
   │  postMessage (MCP JSON-RPC)          sendToken(): decision key, outside MCP
   ▼
Web Worker (src/worker.js)
   MCP server (src/server.js): decide, read_rows
   ├── engine: geo-query-wasm src/engine.js (DuckDB-wasm, locked, SELECT only)
   │     tables read once into memory at start ◀── parquet over https or s3://
   └── decision client (src/decide.js) ── fetch, 12 in flight ──▶ Jev-compatible endpoint
```

- `src/decide.js` is a port of the prototype server's logic: the same question validation, flattening, summary, sorting, row limits and output. `test/decide.test.mjs` checks it (`node --test test/*.test.mjs`).
- Each configured table is loaded into the engine's memory when the worker starts, so later queries never touch the network.
- The decision token comes from the page with `sendToken()`, a message the worker handles before MCP, so the model never sees it and it is not in the worker's URL.
- The engine is imported from geo-query-wasm at a pinned release, so the lockdown is shared, not copied.

## Parity with text-query

| text-query | text-query-wasm |
|---|---|
| `decide` and `read_rows` | Same arguments, validation and output |
| `TABLES` as DuckDB views over S3 | `tables` loaded into memory at start-up |
| Answer cache shared by every caller of a replica | A cache per page, lost on reload |
| Decision token held by the deployment | The user's own key, or a proxy on the app's origin that adds the app's key |
| Private corpus read with the deployment's S3 keys | The user's own keys from the page (geo-query-wasm's `sendSecrets()`), and a bucket that allows the page's origin with CORS |
| Locked DuckDB, one SELECT, credentials redacted | The same, from geo-query-wasm's engine |
| Planned `submit_decide` batch jobs | Not applicable: a corpus-wide job does not belong in a browser tab |

## Benchmarks

Measured on 2026-11-10 in headless Chrome 156 on one CPU (the same as the text-query pod's limit), with `bench/browser.mjs`, `bench/native.py` and `bench/native_decide.py`. Results are in `bench/results.json`.

**Corpora.** The High Seas corpus is private, so `bench/make-corpus.py` builds corpora of its shape from real English sentences: 14,513 paragraphs of about 900 characters (1×, 3.7 MB of passages parquet), and 10× and 100× that (37 MB and 368 MB). Each has a `passages` and a `coded` table. A local HTTPS server serves the files with byte ranges, holding each response 0 or 40 ms to stand in for the round trip from a browser to S3. Native DuckDB reads the same files from local disk, which stands in for the in-cluster object store, and opens a fresh connection per call as the server does.

**SQL.** Seconds per query. "Remote" reads the parquet by URL at 40 ms per request, on the first (cold) run; "memory" queries tables loaded at start-up.

| Query | 1× native | 1× remote | 1× memory | 10× native | 10× remote | 10× memory | 100× native | 100× remote | 100× memory |
|---|---|---|---|---|---|---|---|---|---|
| Passages per folder | 0.02 | 0.14 | 0.02 | 0.03 | 0.45 | 0.14 | 0.04 | 3.2 | 0.06 |
| Count with a keyword (`ILIKE`) | 0.10 | 0.28 | 0.09 | 0.15 | 1.8 | 0.85 | 0.30 | 17.5 | 8.5 |
| Rows for one `decide` call | 0.05 | 0.13 | 0.02 | 0.08 | 0.31 | 0.04 | 0.17 | 0.32 | 0.04 |
| Regex match, 50 rows | 0.08 | 0.12 | 0.05 | 0.11 | 0.14 | 0.32 | 0.20 | 0.15 | 0.32 |
| Codebook summary from `coded` | 0.03 | 0.27 | 0.01 | 0.03 | 1.4 | 0.01 | 0.04 | 12.3 | 0.07 |
| All passages of one paper | 0.05 | 0.09 | 0.01 | 0.05 | 0.09 | 0.00 | 0.06 | 0.08 | 0.00 |
| One passage by id | 0.05 | 0.08 | 0.00 | 0.05 | 0.08 | 0.00 | 0.06 | 0.08 | 0.00 |

| Start-up | 1× | 10× | 100× |
|---|---|---|---|
| DuckDB-wasm and extensions | 3.6 s | 3.8 s | 3.5 s |
| Loading both tables into memory (40 ms per request) | 0.5 s, 7.8 MB | 2.5 s, 77 MB | 23 s, 770 MB |
| Peak memory of the tab, tables in memory | 0.5 GB | 1.1 GB | 4.3 GB |

- At the High Seas corpus's size, every query takes under 0.3 s in the browser, and loading the whole corpus takes half a second. Once loaded, most queries are faster than the server's, which opens a connection and reads the parquet on each call.
- A full-text scan is 5–30 times slower in DuckDB-wasm than native DuckDB, because the browser build runs one thread without native string kernels: 0.85 s against 0.15 s at 10×, and 8.5 s against 0.30 s at 100×.
- Remote reads run one request at a time (geo-query-wasm measured the same), so a query that touches every row group pays a round trip for each: 287 requests, 12 s, for the codebook summary at 100×.
- 100× does not fit. Loading it took the tab to 4.3 GB, at the WebAssembly limit, and remote scans of it take 10–17 s.

**`decide`.** 400 passages, three questions (yes/no, choice, score), against a stub endpoint that answers after about 1 or 3 seconds. Jev's pilot runs imply about one second per call (text-workflows `PLAN.md`: 6,900 paragraphs in 3.6 minutes).

| Decision latency | In flight | Browser | Server | Cached rerun, browser / server |
|---|---|---|---|---|
| 1 s | 6 | 72.7 s | 72.4 s | 0.03 / 0.09 s |
| 1 s | 12 | 35.4 s | 36.1 s | 0.03 / 0.07 s |
| 1 s | 24 | 18.3 s | 18.3 s | 0.03 / 0.08 s |
| 3 s | 12 | 107 s | 110 s | 0.03 / 0.09 s |

- The time of a `decide` call is the decision model's latency times 400 over the requests in flight, in the browser as on the server. The SQL adds well under a second.
- The browser is not limited to six requests per host: over HTTP/2, which OpenRouter serves, the stub saw all 24 at once.
- OpenRouter's `systemone` endpoint allows requests from any origin (CORS preflight checked on 2026-11-10), so a page can call Jev directly.

## Whether to build it

**Performance is adequate for corpora up to a few hundred megabytes of parquet.** For the High Seas corpus (about 15,000 passages), everything an agent does runs in under a second in the browser, and `decide` takes exactly as long as on the server, because the decision model sets its pace. Past about a million passages, full-text scans take many seconds and the corpus no longer fits in a tab.

**Performance is not what stops it for High Seas.** Moving High Seas to the browser runs into four problems that a server does not have.

- **The corpus is private and copyrighted.** It sits in a private rustfs bucket. In the browser, each user would need keys to it, and the bucket would need CORS rules. Loading the corpus into memory also puts every paper's full text in every visitor's tab, where the server gives the agent 500-character excerpts.
- **The decision key.** The app's OpenRouter key cannot go to the page. Either each user brings their own key, or the app's nginx proxies the decision endpoint and adds the key, which is a server again, though a stateless one.
- **No shared cache or spending cap.** Each tab pays for its own answers and forgets them on reload. The server answers repeated questions from all users for nothing.
- **Batch coding needs a server.** `submit_decide` over a whole corpus is a long job that writes parquet to S3.

**It fits public corpora with users' own keys.** For an open corpus on a CORS-enabled bucket (NRP, source.coop), with users supplying their own OpenRouter key as geo-query-wasm's demo does for its language model, text-query-wasm needs no server at all. That is a reasonable second front end. It should not replace the server for private corpora.

## Running the benchmarks

```bash
SENTENCES_FROM=~/some/markdown python bench/make-corpus.py DATA 1 10 100
python bench/native.py DATA 1 10 100 > native.json
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 7 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1
DATA_ROOT=DATA KEY=key.pem CERT=cert.pem node bench/browser.mjs sql
DATA_ROOT=DATA KEY=key.pem CERT=cert.pem node bench/browser.mjs decide
```

The browser runs expect geo-query-wasm checked out next to this repository, and a Chrome or Chromium (`$CHROME`, on the PATH, or Playwright's).

## License

Apache-2.0, as geo-query-wasm. See [LICENSE](LICENSE) and [DISCLOSURE.md](DISCLOSURE.md).
