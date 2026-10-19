# Agent Note: Cache-aware pressure pruning

Status: implemented

English | [中文](2026-10-19-cache-aware-pressure-pruning.zh.md)

## Problem

Replacing a tool result rewrites the model request from that result onward, so a provider's prefix cache must prefill the whole suffix again. `dsh-compaction-basic` pruned every over-budget tool result as soon as pressure qualified and before it decided whether to summarize. An early replacement therefore re-prefilled nearly the whole window, and a prune followed by a summary also moved the summary request off the cached conversation prefix.

A recorded coding Session served by a local vLLM backend measured the cost. Ordinary steps hit the prefix cache about 99% of the time, and prefill ran at 770–860 tokens/s. Three pressure prunes re-prefilled 201,372, 9,590, and 196,946 tokens, which took 246.6 s, 14.4 s, and 256.3 s to the first token. They freed about 76K, 5K, and 3.5K tokens, and a full compaction followed each of them 51, 3, and 5.5 minutes later.

## Decision

Under pressure, `compaction-basic` asks `ToolResultPruner.estimateSession()` for the pending replacements. It prunes before summarizing only when one of these holds:

- The heuristic tokens the replacements free are at least `pressurePruneMinGainRatio` times the request suffix that starts at the earliest replacement, priced after the prune.
- No range is summarizable, so the prune is the only available relief.

Otherwise the summary reads the unchanged, cached prefix. After each pressure summary, the engine prunes the replacement surface. Every compacted range starts at the first non-system node, so every remaining tool result follows the new summary, and pruning it changes only tokens the next request prefills anyway.

`pressurePruneMinGainRatio` is a policy field with per-model overrides and defaults to `1`. In the recorded Session, a compaction bought about 200K tokens of headroom for about 96K re-prefilled tokens plus 80–135 s of summary decoding, roughly one token of headroom per re-prefilled-token equivalent. A prune below that ratio spends more cache per freed token than the compaction it defers. A value of `0` restores unconditional pre-summary pruning. Overflow recovery always prunes first, because it must free space before its retry.

## Replay

A local replay fed the recorded events into a fresh Session and called `compactIfNeeded('pressure')` before each recorded step. It modeled the provider cache as the longest common prefix of surface nodes between consecutive requests. The heuristic meter priced requests at 0.885 of the router's real prompt tokens over 138 steps, so the replay scaled the context window by that factor. With the earlier behavior (`0`), the replay reproduced the first two recorded prunes within 2 minutes and 1% of their re-prefill; the third landed 9 minutes later than recorded, in the same pass as its compaction. Totals are in real-token equivalents:

| Policy | Pre-summary prunes | Compactions | Re-prefilled tokens |
|---|---|---|---|
| `pressurePruneMinGainRatio: 0` | 3 | 2 | 477,018 |
| `0.25` | 2 | 2 | 328,838 |
| `0.5`, `1`, `2` | 0 | 2 | 118,134 |

At `1`, the summary requests reused the cached prefix entirely, and the remaining re-prefill is the post-compaction tail that every policy pays. The 358,884-token difference is about seven minutes of prefill at the measured rate.

## Alternatives considered

- **Prune each tool result when it arrives.** This keeps the cache intact, but in the recorded Session it would have hidden 303,213 of 1,135,405 tool-result characters (27%) in the step that requested them, including nine file reads.
- **A gain floor as a fraction of the window**, for example 10%. It ignores where the replacements sit. The largest recorded prune freed about 92K estimated tokens, so it passes the floor, yet it re-prefilled 201K tokens, about as much as a compaction, for less headroom.
- **Hysteresis below the threshold.** At the trigger point this equals a gain floor and has the same weakness.

## Consequences

- Pressure compacts at the first qualifying step instead of first trimming early results. In the replay the compaction count stayed at two, but each summary arrives earlier and covers a shorter span of history.
- Summaries read untrimmed tool results from the cached prefix. The retained tail is trimmed as before.
- The ratio compares heuristic token estimates, not provider tokens. Image pricing and tokenizer density can move a borderline decision.
- Tests in `packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` cover the ratio boundary, the fallback when nothing is summarizable, and summary-request prefix reuse modeled with `prefixCacheMiss`.
