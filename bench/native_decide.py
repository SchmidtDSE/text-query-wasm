"""text-query's server-side decide against the stub decision endpoint (serve.mjs), for
comparison with the browser. Rows come from local parquet; the SQL takes milliseconds.

    DECISION_URL=… REQUESTS_CA_BUNDLE=cert.pem python native_decide.py TEXT_QUERY_DIR DATA_ROOT BASE
"""
import json
import sys
import time

sys.path.insert(0, sys.argv[1])
import duckdb  # noqa: E402
import requests  # noqa: E402

import server  # noqa: E402

data, base = sys.argv[2], sys.argv[3]
Q = {
    "relevant": {"type": "noul", "instructions": "Does this paragraph report results on seamount fauna?"},
    "zone": {"type": "choice", "instructions": "Which depth zone?",
             "criteria": {"shallow": "above 200 m", "deep": "below 200 m", "none": "not stated"}},
    "strength": {"type": "score", "instructions": "How strong is the evidence?",
                 "criteria": ["anecdote", "single survey", "several surveys", "time series"]},
}


def run_sql(sql, limit):
    con = duckdb.connect()
    rel = con.sql(sql.replace("FROM passages", f"FROM read_parquet('{data}/x1/passages.parquet')"))
    return rel.columns, rel.limit(limit + 1).fetchall()


server.run_sql = run_sql
sql = "SELECT passage_id, title, page, text FROM passages ORDER BY passage_id LIMIT 400"
out = {}
for latency in (1000, 3000):
    for workers in (6, 12, 24):
        server.DECISION_URL = f"{base}/decide/{latency}"
        server.WORKERS = workers
        server.CACHE.clear()
        requests.get(f"{base}/decide/stats")
        t0 = time.perf_counter()
        server._decide(sql, Q, "text", "title", "none", 40, False)
        first = time.perf_counter() - t0
        stats = requests.get(f"{base}/decide/stats").json()
        t0 = time.perf_counter()
        server._decide(sql, Q, "text", "title", "none", 40, False)
        out[f"server/lat{latency}/c{workers}"] = {"first_s": round(first, 2),
                                                   "cached_s": round(time.perf_counter() - t0, 3), "server": stats}
        print(latency, workers, out[f"server/lat{latency}/c{workers}"], file=sys.stderr)
print(json.dumps(out))
