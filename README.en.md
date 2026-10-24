# Duiying · Memory Bank for Human–AI Teams (Open Edition)

**English** · [简体中文](README.md)

<p align="center">
  <img src="docs/assets/cover-light.png" alt="duiying — Your memory. Your files. Any AI can read them." width="100%">


![CI](https://github.com/lingze818-maker/duiying-open/actions/workflows/ci.yml/badge.svg)

> **Every window you open, the same companion wakes up.**
>
> Fully local — almost nothing leaves your machine. A universal component that works with most AI frontends.

Most people work with AI as a **teammate**: shipping projects,
recording decisions, carrying context forward. And nearly every AI frontend has
the same amnesia — the decision you made last week gets re-argued this week.

Duiying treats memory as a **retrieval problem**, not a storage problem. It scans
your Markdown memory notes and surfaces *cues* — one line each — for any AI
frontend to inject into context.

**Surfacing can be fully passive.** Once MCP is connected, the lightest setup is
one line in your AI's system prompt — "search first, then answer" — and it flips
through your memory before speaking. Frontends with message hooks (like Claude
Code) can inject cues automatically every turn with one pipeline, zero explicit
calls. A self-built UI can embed retrieval server-side and weave memory into
every response. Three depths, each with a wiring diagram in the
[integration contract](docs/接入契约.md).

**Why not just use another memory system? Because memory shouldn't be locked in.**
Many memory solutions keep your memory in their cloud, or lock it inside their
own framework — and built-in frontend memory dies when you switch. Duiying's
memory is **your Markdown files**: open format, on your disk, readable by any
frontend — zcode, codex, deepseek harness, or a UI you build yourself.
Frontends can be replaced. They can die. Your memory stays.

## What makes it different

| Capability | What it does |
|---|---|
| **BM25 + exact-phrase fusion** | CJK handled via character bigrams — no tokenizer needed; whole-phrase hits score separately |
| **Time prior** | Recent memories surface naturally; queries like "recently" switch to time-first mode. A query that is only a time word lists the newest notes by the day they happened. Optional frontmatter `date: YYYY-MM-DD` is that day; otherwise the file's mtime is used |
| **Associative surfacing** | Notes auto-link; one hit pulls its neighbors in — "deployment" recalls March's architecture decision |
| **Supersede, don't delete** | Outdated notes keep a `superseded_by` marker — down-weighted, with a pointer to the successor. In a note split into several decisions, only a decision the successor actually restates is marked |
| **Silence list** | `suppress` / `suppress_when` — some memories shouldn't come up, but *not surfacing ≠ deleting* |
| **Landmark injection** | One line per cue — the same token budget carries more memories |
| **Never a recital machine** | Results ship with an injection hint: *surface memories only when asked or relevant* |
| **doctor checkup** | `--doctor` reports broken links, near-duplicates, title quality, the silence list, and notes whose body has a `YYYY-MM-DD` but no `date` field. Search keeps the newer near-duplicate (that date, else mtime) and hides notes for missing targets. Files are never edited |
| **Multi-frontend write** | Any MCP-connected frontend can contribute: summaries authored by the writer, content inlined or path-referenced, event/channel tags — switching frontends is just a breath |
| **Surface gate** | Automatic injection (the hook, or MCP used as prefetch) can return nothing for greetings, bare emotion, or a topic-less short turn. A direct CLI search still runs |
| **Lexical rerank** | When several notes hit, token overlap plus a substring bonus moves the closer wording forward. No embedding model |

**No vector database. No graph database. No local models. No API keys.**
Node 18 or newer. Nothing to install.

> **Honest scope**: the engine is designed for **personal memory banks — dozens
> to a few thousand Markdown notes**. Every query does a full scan plus the
> association graph. Thousands of notes run in milliseconds to seconds; going
> beyond that needs incremental indexing, which is outside the "personal memory"
> scope on purpose.

## Quick start

> **Already have Markdown notes?** No conversion needed —
> point the engine at your folder ([guide](docs/连接现有记忆库.md)) and search.

```bash
git clone https://github.com/lingze818-maker/duiying-open.git
cd duiying-open

# A fully fictional sample bank: three months with an AI teammate named Xiaolin
node engine/surface.mjs "deployment,rollback" --root examples/partner-xiaolin --detail
```

<p align="center">
  <img src="docs/assets/demo-surface.gif" alt="Live demo: matching memories surface one by one, with associative links and superseded notes visible" width="85%">
</p>

For programmatic use (the integration point for any frontend):

```bash
node engine/surface.mjs "deployment" --root ./my-memory --json
```

```json
{
  "engine": "duiying-open/0.2",
  "query": ["deployment"],
  "hint": "Unless the user asks or it is naturally relevant, do not recite these memories.",
  "results": [
    { "path": "decisions.md", "title": "Project decisions", "date": "2026-04-01",
      "score": 12.3, "links": ["meetings.md"], "note": "Superseded — see new-plan.md" }
  ]
}
```

Feed `results` into your AI's system prompt as contextual cues. That's it — memory.

## Frontend integration

Four routes — see [docs/接入契约.md](docs/接入契约.md) (Chinese; schemas are universal):

- **CLI direct call** (agent environments like zcode / codex / deepseek harness):
  wrap `node engine/surface.mjs "$query" --root <bank> --json` in a tool definition
- **MCP server** (zcode / claude-family / any MCP host): run `node mcp/server.mjs`
  (stdio), add one entry to your host config, and get `memory_surface` +
  `memory_doctor` + `memory_ingest` tools — read the whole bank *and* contribute
  to it
- **Embed in Node**: `import { tokenize, buildStats, bm25, buildLinks, spread }
  from "./engine/lib.mjs"` — pure functions, no IO, compose freely
- **How surfacing triggers**: MCP tools are passive — the engine answers whenever
  asked. Three automation levels, from a one-line prompt convention to
  message-injection pipelines, are documented in the
  [integration contract](docs/接入契约.md) (Chinese; schemas are universal)
- **Entry states** in note frontmatter:

```markdown
---
date: 2026-04-10             # optional day the memory happened
superseded_by: new-plan.md   # down-weighted, kept, annotated
suppress: true               # never surfaces (file stays untouched)
suppress_when: [layoffs]     # silent only when the query matches
---
```

## How a memory bank grows

No migration needed — **it's just Markdown files**. Loose conventions:

- File names carry meaning (`decisions.md`, `meetings-2026-04.md`)
- The first `# heading` becomes the landmark
- Add frontmatter only when you need state control

Run a checkup occasionally:

```bash
node engine/surface.mjs --doctor --root ./my-memory
```

## What lines up with the private engine

Two retrieval ideas from the private Duiying stack are public here: a **surface gate** (on for automatic injection — greetings, bare emotion, and a short repeat can yield zero hits; `node engine/surface.mjs "…"` stays ungated unless you pass `--gate`) and a **lexical rerank** (token overlap + substring bonus, no new dependencies). Intents are rule-only: `memory_recall`, `open_chat`, `companion`.

Companion distress handling, relationship intercepts, and private archives are **not** in this open tree. See the integration contract (Chinese) for flags.

## Philosophy

**Surface cues. Never rewrite memory.**

Retrieval results never rewrite, delete, or adjudicate a memory. In recent
years the leading memory systems have converged on the same principle:
*the memory corpus is sacred; the intelligence lives in the retrieval
layer.* Duiying was built on that ground from day one.

Why take the retrieval layer seriously at all? Because "it actually remembers
me" is never a storage problem — it is a **recollection** problem: association,
recency, and the tact of what to surface when. All of it is plain algorithms;
none of it requires a model.

## Docs

- [Frontend integration contract](docs/接入契约.md) (Chinese)
- [Sample corpus guide](examples/partner-xiaolin/README.md) (Chinese; the corpus itself is language-agnostic)

## Roadmap

- [x] v0.2 batch 1: BM25 fusion / time prior / associative diffusion / landmark injection / injection hint
- [x] v0.2 batch 2: supersede markers / silence list / doctor checkup
- [ ] Batch 3 (under evaluation): idle-time LLM candidate extraction (human-confirmed) / stable profile layer
- [ ] Auto-generated MCP contract docs / agent-skill distribution
- [x] Live demo GIF

## License

MIT
