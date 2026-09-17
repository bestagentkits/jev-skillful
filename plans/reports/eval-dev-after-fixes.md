  FAIL  recall@K            0.765  (required ≥ 0.9)
  FAIL  top1Accuracy        0.687  (required ≥ 0.8)
  FAIL  noneRecall          0.750  (required ≥ 0.9)
  FAIL  noneF1              0.750  (required ≥ 0.8)
  pass  agreementRate       0.985  (required ≥ 0.9)
  pass  p95 latency         406ms  (required ≤ 1500)

GATE FAILED

Note: the corpus is sanitised; 50 private entries were withheld, so this is a slightly easier retrieval problem than the full local catalog.

# Router evaluation

- Gate: **FAILED**
- Fixtures: 67, repeats: 3, total runs: 201
- Mode: live
- Fixture set: `bench/fixtures/routing.jsonl`
- Corpus fingerprint: `sha256:8fd0cfbab880a37f88f2d8c7d282d2f8b00315c0444bd63ddaa7cbba57694d09`
- Corpus captured: 2026-09-17T11:04:59.536Z
- Ran at: 2026-09-17T11:07:14.088Z

## Gate criteria

| Metric | Required | Actual | Result |
| --- | --- | --- | --- |
| recall@K | ≥ 0.9 | 0.765 | **FAIL** |
| top1Accuracy | ≥ 0.8 | 0.687 | **FAIL** |
| noneRecall | ≥ 0.9 | 0.750 | **FAIL** |
| noneF1 | ≥ 0.8 | 0.750 | **FAIL** |
| agreementRate | ≥ 0.9 | 0.985 | pass |
| p95 latency | ≤ 1500 | 406ms | pass |

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
| recall@K | 0.765 |
| MRR | 0.518 |
| gold in shortlist (per item) | 0.182 |

By gold kind:

| Kind | Runs | Recall | MRR |
| --- | --- | --- | --- |
| skill | 129 | 0.791 | 0.599 |
| mcp | 18 | 0.500 | 0.046 |
| agent | 33 | 0.727 | 0.339 |
| rule | 3 | 0.000 | 0.000 |

## Decision (layer 2)

| Metric | Value |
| --- | --- |
| top1Accuracy | 0.687 |
| abstentionCorrectness | 0.940 |
| nonePrecision | 0.750 |
| noneRecall | 0.750 |
| noneF1 | 0.750 |
| degraded rate | 0.000 |

Counts: expected abstain 48, actually abstained 48, true abstain 36, correct pick 102, wrong pick 51, missed abstain 12.

## Per group

| Group | Runs | Recall@K | top1 | noneRecall | noneF1 | p95 |
| --- | --- | --- | --- | --- | --- | --- |
| coding | 60 | 0.850 | 0.850 | 0.000 | 0.000 | 397ms |
| marketing | 24 | 1.000 | 1.000 | 0.000 | 0.000 | 408ms |
| mcp | 18 | 0.500 | 0.000 | 0.000 | 0.000 | 393ms |
| agent | 12 | 1.000 | 0.500 | 0.000 | 0.000 | 394ms |
| trivial | 45 | 0.000 | 0.733 | 0.733 | 0.846 | 388ms |
| ambiguous | 18 | 0.667 | 0.667 | 0.000 | 0.000 | 450ms |
| vietnamese | 24 | 0.429 | 0.500 | 1.000 | 0.667 | 409ms |

## Stability

66 of 67 fixtures gave the same decision on all 3 repeats.

Fixtures that changed their answer:

| Fixture | Decisions across repeats |
| --- | --- |
| vi-plan | injected:claude-code:agent:global:Explore · injected:claude-code:agent:global:Explore · injected:claude-code:skill:global:ak:advise |

## Latency

| Metric | Value |
| --- | --- |
| p50 | 308ms |
| p95 | 406ms |
| p99 | 450ms |
| mean | 289ms |
| max | 843ms |
| over budget | 0 of 201 (budget 2000ms) |
| mean tokens in | 2600 |
| mean tokens out | 509 |

## Configuration

```json
{
  "thresholds": {
    "noneThreshold": 0.5,
    "minWinnerProbability": 0.25,
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

