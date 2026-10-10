# Duiying · Memory Bank for Human–AI Teams (Open Edition)

> Give everyday human–AI collaboration the feeling of *"it actually remembers me."*
>
> Fully local · zero dependencies · one Node script is the whole engine.

Most people relate to AI not as a lover but as a **teammate**: shipping projects,
recording decisions, carrying context forward. Nearly every AI frontend shares the
same amnesia — decisions made last week get re-argued this week.

Duiying treats memory as a **retrieval problem**, not a storage problem: it scans
your Markdown memory notes and surfaces *cues* — one line each — for any AI
frontend (zcode / codex / deepseek harness / your own UI) to inject into context.

## Highlights

- **BM25 + exact-phrase fusion** — CJK handled via character bigrams, no tokenizer needed
- **Time prior** — recent memories surface naturally; queries like "recently" switch to time-first mode
- **Associative surfacing** — notes auto-link; one hit pulls in its neighbors ("deployment" recalls March's architecture decision)
- **Supersede, don't delete** — outdated notes keep a `superseded_by` marker, down-weighted with a pointer to the successor
- **Silence list** — `suppress` / `suppress_when`: some memories shouldn't come up, but *not surfacing ≠ deleting*
- **Landmark injection** — one line per cue; 3× the memories in the same token budget
- **doctor checkup** — `--doctor` audits broken links / near-duplicates / title quality / silenced list

**No vector DB, no graph DB, no local models, no API keys.**
Node ≥ 18 and two scripts.

## Quick start

```bash
git clone https://github.com/lingze818-maker/duiying-open.git
cd duiying-open
node engine/surface.mjs "deployment,rollback" --root examples/partner-xiaolin --json
```

Feed `results` into your AI's system prompt as contextual cues. Done — memory.

See the [Chinese README](README.md) for the full design story, the philosophy
(*surface cues, never rewrite memory*), and the competitor study.

## License

MIT
