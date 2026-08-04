# Semantic recall (memory search by meaning)

Agents recall memories two ways at once:

- **keyword** — SQLite FTS5. Always available, zero setup, no dependencies.
- **meaning** — vector similarity over local embeddings. Needs Ollama. **Optional.**

Without the vector half, nothing breaks: every memory is still stored and still findable by
keyword. What you lose is the ability to find a memory phrased differently from the question —
asking "how many bedrooms in the rental?" when the memory says "3-room flat, Baker Street".
That is the whole point of the feature, so it is worth the ten minutes of setup.

## Setup

```bash
curl -fsSL https://ollama.com/install.sh | sh   # or your platform's package
ollama pull bge-m3                              # 1024-dim, ~1.2 GB, multilingual
npm run memory:status                           # should now report OK
```

If you already have memories saved from before, embed them once:

```bash
npm run memory:backfill      # bounded batches, resumable, safe to re-run
```

Both commands exit non-zero on incomplete coverage, so you can put `memory:status` in a cron job
or a CI step and hear about it without watching.

## Configuration

| Env var      | Default                  | Notes                                                        |
| ------------ | ------------------------ | ------------------------------------------------------------ |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Point at a remote or shared Ollama if you have one.           |
| `EMBED_MODEL`| `bge-m3`                 | If you change this, also set `EMBED_DIM` and re-run backfill. |
| `EMBED_DIM`  | `1024`                   | Must match the model's real output length.                    |

Changing the model **invalidates existing vectors**: they are compared by cosine similarity, and
vectors from two different models are not comparable. Vectors of the wrong length are rejected on
write and re-attempted by the backfill, so a model change is recoverable — just re-run backfill.

## Choosing a model

The default is multilingual because the store it was measured on is. If your memories and questions
are all in English, `nomic-embed-text` (with `EMBED_DIM=768`) is smaller, ~4x faster, and scored the
same on English questions — set both env vars and re-run the backfill.

> **The backfill is not optional, and skipping it fails SILENTLY.** Changing `EMBED_DIM` without
> re-running the backfill leaves every existing row at the old width. `cosineSimilarity` returns 0 on a
> length mismatch, so those rows do not error — they rank last and become invisible. Recall collapses
> and *nothing alarms*: `countEmbeddings()` has no scheduled caller, so `wrongDim` can climb from 0 to
> every row in the store with no owner-facing signal. Until a scheduled recall-health check exists
> (kanban 62bd646d), the only way to know is to run `npm run memory:status` yourself and check
> `wrongDim == 0` AFTER the backfill finishes. Verify, do not assume it completed.

Measured on 12 real questions against 250 real memories, half the questions in a second language:

| model              | recall@1 | recall@5 | non-English recall@1 |
| ------------------ | -------- | -------- | -------------------- |
| `nomic-embed-text` | 3/12     | 8/12     | **0/6**              |
| `bge-m3`           | 6/12     | 11/12    | 3/6                  |

The 0/6 is why the default changed. Correct memories were ranking 53rd, 81st, 192nd and 249th when
the question was asked in the other language — retrievable in principle, invisible in practice. Note
that *coverage was 100% the whole time*: every row had a vector. Coverage counts rows with a vector,
not vectors that find anything, so measure retrieval separately and on your own data.

## Design decisions worth knowing before you change anything

**Saving a memory never waits on the embedder.** `saveMemory` writes the row and returns; the
vector is attached in the background. Ollama being down, slow, or mid-restart can cost you a
vector, never a memory. The memory is the asset; the vector is an enhancement.

**A wrong-length vector is rejected, not stored.** Storing one would be the worst case: it reads
cosine 0 against every query (semantically dead) while making the row look covered, so a backfill
that selects `WHERE embedding IS NULL` would never retry it. A NULL is honest and self-healing.

**Recall gives every tier a guaranteed reserve rather than strict priority.** Vector hits, keyword
hits, and the different memory tiers each get a floor of the character budget. Strict priority was
tried and failed four separate ways: one verbose tier would eat the whole budget and silently
starve the others. If you touch `recall.ts`, keep the reserves — the tests pin each starvation
case, and each one shipped as a real bug first.

**Coverage is reported, loudly.** The reason this document and `memory:status` exist is that the
vector column shipped and then went eight weeks with zero vectors written. Saves succeeded,
keyword recall worked, and nothing anywhere said otherwise. A silent degradation that nothing
reports on is indistinguishable from working software.
