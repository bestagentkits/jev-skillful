  FAIL  recall@K            0.804  (required ≥ 0.9)
  FAIL  top1Accuracy        0.687  (required ≥ 0.8)
  FAIL  noneRecall          0.688  (required ≥ 0.9)
  FAIL  noneF1              0.623  (required ≥ 0.8)
  pass  agreementRate       0.955  (required ≥ 0.9)
  pass  p95 latency         450ms  (required ≤ 1500)

GATE FAILED

Note: the corpus is sanitised; 50 private entries were withheld, so this is a slightly easier retrieval problem than the full local catalog.

# Router evaluation

- Gate: **FAILED**
- Fixtures: 67, repeats: 3, total runs: 201
- Mode: live
- Fixture set: `bench/fixtures/routing.jsonl`
- Corpus fingerprint: `sha256:8fd0cfbab880a37f88f2d8c7d282d2f8b00315c0444bd63ddaa7cbba57694d09`
- Corpus captured: 2026-09-17T10:57:25.097Z
- Ran at: 2026-09-17T11:00:58.730Z

## Gate criteria

| Metric | Required | Actual | Result |
| --- | --- | --- | --- |
| recall@K | ≥ 0.9 | 0.804 | **FAIL** |
| top1Accuracy | ≥ 0.8 | 0.687 | **FAIL** |
| noneRecall | ≥ 0.9 | 0.688 | **FAIL** |
| noneF1 | ≥ 0.8 | 0.623 | **FAIL** |
| agreementRate | ≥ 0.9 | 0.955 | pass |
| p95 latency | ≤ 1500 | 450ms | pass |

## Fixture coverage

| Group | Fixtures |
| --- | --- |
| coding | 20 |
| marketing | 8 |
| mcp | 6 |
| agent | 4 |
| trivial | 15 |
| ambiguous | 6 |
| vietnamese | 8 |

## Retrieval (layer 1)

Scored over 153 non-abstain runs; abstain fixtures have no gold to retrieve.

| Metric | Value |
| --- | --- |
| recall@K | 0.804 |
| MRR | 0.521 |
| gold in shortlist (per item) | 0.197 |

By gold kind:

| Kind | Runs | Recall | MRR |
| --- | --- | --- | --- |
| skill | 129 | 0.791 | 0.599 |
| mcp | 18 | 0.833 | 0.073 |
| agent | 33 | 0.727 | 0.339 |
| rule | 3 | 0.000 | 0.000 |

## Decision (layer 2)

| Metric | Value |
| --- | --- |
| top1Accuracy | 0.687 |
| abstentionCorrectness | 0.876 |
| nonePrecision | 0.569 |
| noneRecall | 0.688 |
| noneF1 | 0.623 |
| degraded rate | 0.000 |

Counts: expected abstain 48, actually abstained 58, true abstain 33, correct pick 105, wrong pick 38, missed abstain 25.

## Per group

| Group | Runs | Recall@K | top1 | noneRecall | noneF1 | p95 |
| --- | --- | --- | --- | --- | --- | --- |
| coding | 60 | 0.850 | 0.850 | 0.000 | 0.000 | 522ms |
| marketing | 24 | 1.000 | 1.000 | 0.000 | 0.000 | 409ms |
| mcp | 18 | 0.833 | 0.167 | 0.000 | 0.000 | 440ms |
| agent | 12 | 1.000 | 0.500 | 0.000 | 0.000 | 439ms |
| trivial | 45 | 0.000 | 0.667 | 0.667 | 0.800 | 450ms |
| ambiguous | 18 | 0.667 | 0.667 | 0.000 | 0.000 | 1049ms |
| vietnamese | 24 | 0.429 | 0.500 | 1.000 | 0.500 | 383ms |

## Stability

64 of 67 fixtures gave the same decision on all 3 repeats.

Fixtures that changed their answer:

| Fixture | Decisions across repeats |
| --- | --- |
| mcp-memory | injected:pi:skill:global:ak-handoff · skipped:below-threshold · injected:pi:skill:global:ak-handoff |
| amb-refactor-clean | skipped:below-threshold · skipped:none-won · skipped:below-threshold |
| vi-plan | skipped:below-threshold · skipped:none-won · skipped:below-threshold |

## Latency

| Metric | Value |
| --- | --- |
| p50 | 333ms |
| p95 | 450ms |
| p99 | 800ms |
| mean | 320ms |
| max | 1049ms |
| over budget | 0 of 201 (budget 2000ms) |
| mean tokens in | 2873 |
| mean tokens out | 579 |

## Configuration

```json
{
  "thresholds": {
    "noneThreshold": 0.5,
    "runnerUpThreshold": 0.6,
    "maxRunnersUp": 2,
    "minPromptChars": 12,
    "budgetMs": 2000,
    "maxPromptChars": 1000,
    "requestTimeoutMs": 1800
  },
  "quotaGroups": [
    {
      "kinds": [
        "skill"
      ],
      "limit": 6
    },
    {
      "kinds": [
        "mcp"
      ],
      "limit": 4
    },
    {
      "kinds": [
        "agent"
      ],
      "limit": 3
    },
    {
      "kinds": [
        "command",
        "rule"
      ],
      "limit": 2
    }
  ],
  "model": "jev-latest",
  "uploadPrompt": true
}
```

