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
ollama pull nomic-embed-text                    # 768-dim, ~270 MB
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
| `EMBED_MODEL`| `nomic-embed-text`       | If you change this, also set `EMBED_DIM` and re-run backfill. |
| `EMBED_DIM`  | `768`                    | Must match the model's real output length.                    |

Changing the model **invalidates existing vectors**: they are compared by cosine similarity, and
vectors from two different models are not comparable. Vectors of the wrong length are rejected on
write and re-attempted by the backfill, so a model change is recoverable — just re-run backfill.

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
