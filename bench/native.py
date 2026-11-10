"""Native DuckDB (what text-query's server runs) on the benchmark queries.

Each call opens a fresh connection, as the server does, and reads the parquet from local disk,
the closest stand-in for an in-cluster object store. Prints JSON: {scale: {query: seconds}}.

    python native.py DATA_ROOT 1 10 100
"""
import json
import statistics
import sys
import time

import duckdb

root, scales = sys.argv[1], sys.argv[2:]
queries = json.load(open(__file__.replace("native.py", "queries.json")))
out = {}
for s in scales:
    tables = {t: f"read_parquet('{root}/x{s}/{t}.parquet')" for t in ("passages", "coded")}
    out[s] = {}
    for q in queries:
        sql = q["sql"].format(**tables)
        times, n = [], None
        for _ in range(3):
            t0 = time.perf_counter()
            con = duckdb.connect()
            n = len(con.sql(sql).fetchall())
            con.close()
            times.append(time.perf_counter() - t0)
        out[s][q["id"]] = {"s": round(statistics.median(times), 4), "rows": n}
    print(s, out[s], file=sys.stderr)
print(json.dumps(out))
