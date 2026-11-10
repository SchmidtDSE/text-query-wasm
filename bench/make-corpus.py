"""Synthetic corpora shaped like the High Seas literature corpus, for benchmarks.

The High Seas corpus (bosl-high-seas k8s/text-query.yaml) is 14,513 passages of about one
paragraph from 186 papers, in two tables: `passages` (passage_id, doc_id, title, page, text,
folder, file, folders) and `coded` (the same rows with codebook probabilities). The text is
private, so these corpora are built from real English sentences taken from local markdown
files (SENTENCES_FROM, default the current directory), shuffled into paragraphs of about 900 characters, which compresses like real prose.
Marine terms are sprinkled in at known rates so keyword filters select realistic fractions.

    python make-corpus.py OUT_DIR SCALE [SCALE ...]   # e.g. 1 10 100
"""
import glob
import os
import random
import re
import sys

import duckdb
import pyarrow as pa

out, scales = sys.argv[1], [int(s) for s in sys.argv[2:]] or [1]
random.seed(1)
sentences = []
src = os.environ.get("SENTENCES_FROM", ".")
for f in glob.glob(f"{src}/**/*.md", recursive=True)[:4000]:
    if "node_modules" in f:
        continue
    try:
        text = open(f, errors="ignore").read()
    except OSError:
        continue
    text = re.sub(r"```.*?```|`[^`]*`|\[[^\]]*\]\([^)]*\)|[#*|>_]", " ", text, flags=re.S)
    for s in re.split(r"(?<=[.!?])\s+", text):
        s = " ".join(s.split())
        if 40 <= len(s) <= 300 and s[0].isupper() and s.count(" ") > 5:
            sentences.append(s)
sentences = sorted(set(sentences))
print(f"{len(sentences)} distinct sentences", file=sys.stderr)

TERMS = [("seamount", 0.08), ("hydrothermal vent", 0.02), ("cold-water coral", 0.04),
         ("bottom trawling", 0.03), ("Emperor Seamount Chain", 0.015), ("sponge", 0.05)]
FOLDERS = ["8.2.4.Corals, 8.2.5.Sponges", "8.1.Geology", "8.3.Fish", "8.4.Fisheries",
           "8.5.Benthos", "8.6.Oceanography", "8.7.Governance", "8.8.Seabirds"]
SITES = ["emperor_feature", "emperor_chain", "north_pacific", "other_ocean", "global", "none"]


def paragraph():
    out, n = [], 0
    while n < random.gauss(900, 300):
        s = random.choice(sentences)
        for term, rate in TERMS:
            if random.random() < rate / 4:
                w = s.split(" ")
                w.insert(random.randrange(len(w)), term)
                s = " ".join(w)
        out.append(s)
        n += len(s) + 1
    return " ".join(out)


os.makedirs(out, exist_ok=True)
base = [paragraph() for _ in range(14_513)]
con = duckdb.connect()
for scale in scales:
    n = 14_513 * scale
    docs = 186 * scale
    ids = range(n)
    doc = [i * docs // n for i in ids]
    # The first 14,513 paragraphs are the 1x corpus; larger scales add fresh ones.
    text = base + [paragraph() for _ in range(n - len(base))]
    p = pa.table({
        "passage_id": pa.array(ids, pa.int64()), "doc_id": pa.array(doc, pa.int32()),
        "title": [f"Paper {d}: {sentences[d % len(sentences)][:80]}" for d in doc],
        "page": pa.array([1 + i % 25 for i in ids], pa.int32()), "text": text,
        "folder": [FOLDERS[d % len(FOLDERS)] for d in doc], "file": [f"paper-{d}.pdf" for d in doc],
    })
    con.register("p", p)
    d = f"{out}/x{scale}"
    os.makedirs(d, exist_ok=True)
    con.execute(f"COPY (SELECT * FROM p ORDER BY passage_id) TO '{d}/passages.parquet' "
                "(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 20000)")
    crit = ", ".join(f"CASE WHEN content > 0.5 THEN round(random()^3, 3) END AS crit_{c}" for c in "abcdefghijklmnopqrstuv")
    con.execute(f"""COPY (SELECT passage_id, doc_id, title, page, text, folder, content,
            {SITES!r}[1 + (hash(passage_id) % 6)::INT] AS site, round(random(), 3) AS site_p, {crit}
        FROM (SELECT *, round(random(), 3) AS content FROM p) ORDER BY passage_id)
        TO '{d}/coded.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 20000)""")
    print(scale, n, {f: round(os.path.getsize(f"{d}/{f}") / 1e6, 1) for f in ("passages.parquet", "coded.parquet")})
