---
phase: 3
title: "Eval Harness và Tune Ngưỡng"
status: pending
priority: P1
effort: "2d"
dependencies: [2]
---

# Phase 3: Eval Harness và Tune Ngưỡng

## Context Links

- Plan: [plan.md](./plan.md)
- Phase 2: [Router Core](./phase-02-router-core.md)
- Phương pháp đo lường: `reports/research-measurement-methodology.md`
- Paper: arXiv:2604.24594 (SRA-Bench, cấu trúc 3 tầng, distractor corpus)

## Goal

Đo chất lượng router ở tầng retrieval và tầng decision bằng một eval harness chạy offline, rồi dùng
số đo đó để tune quota và ngưỡng — thay vì tune bằng cảm giác.

**Đây là cổng quyết định của plan.** Nếu router không đạt ngưỡng chất lượng ở đây thì dừng, sửa
prompt, và không làm hook.

## Key Insights

SRA-Bench chia pipeline thành ba tầng đo riêng rẽ: **skill retrieval**, **skill incorporation**,
**end-task execution**. Gộp chúng lại sẽ che mất nguyên nhân thất bại. Phase này sở hữu hai tầng đầu;
phase 6 sở hữu tầng thứ ba.

**Fixture phải có distractor, không chỉ gold.** Corpus của SRA-Bench gồm 636 gold skill trộn với
distractor thu thập từ web thành 26,262 mục. Nếu fixture chỉ chứa gold skill thì BM25 prefilter sẽ
dễ một cách giả tạo. Cách rẻ nhất và sát thực tế nhất là dùng **chính catalog thật trên máy làm
distractor**.

**Hai con số phải đo riêng:** chất lượng retrieval (gold có trong shortlist không) và chất lượng
quyết định (router có chọn đúng, và có abstain đúng không). Paper arXiv:2604.24594 ghi nhận agent
hiện nay load skill với tần suất như nhau bất kể task có cần hay không — nghĩa là chất lượng quyết
định abstain là một trục riêng, không suy ra được từ chất lượng retrieval.

**Phải chạy N lần lặp.** Jev không tất định: đo được `noneP` lệch ±0.03 khi lặp cùng input, và ghi
chú cũ hơn cho thấy distribution giữa các option cạnh tranh lệch tới 53/47 → 61/39. Một lần chạy
không phân biệt được tín hiệu với nhiễu. Báo cáo phải kèm agreement rate giữa các lần lặp.

## Requirements

Chức năng:

- Định dạng fixture khai báo được: prompt, gold capability id (hoặc `none`), nhóm, ghi chú.
- Corpus eval = tập gold từ fixture + catalog thật (hoặc catalog fixture) làm distractor.
- Metric tầng L1: `recall@K`, `MRR`, `goldInShortlistRate`, phân tích theo kind.
- Metric tầng L2: `top1Accuracy`, `nonePrecision`, `noneRecall`, `noneF1`, `abstentionCorrectness`.
- Metric ổn định: `agreementRate` qua N lần lặp trên cùng fixture (bao nhiêu phần trăm fixture cho
  cùng quyết định ở mọi lần chạy).
- Metric hiệu năng: p50, p95, p99 latency; token trung bình mỗi request.
- Sweep ngưỡng: chạy lại eval với nhiều giá trị `noneThreshold` và quota để chọn cấu hình tốt nhất.
- Lệnh `skillful eval` với `--fixtures`, `--repeat`, `--json`, `--sweep`.
- Báo cáo Markdown + JSON, ghi vào `plans/<plan>/reports/`.

Phi chức năng:

- Chạy offline trừ lời gọi TypeSafe. Phải có chế độ `--replay` dùng response đã ghi lại để CI không
  cần key.
- Có thể chạy trên tập con (`--limit`) để vòng lặp phát triển nhanh.
- Không gọi Jev khi heuristic skip kích hoạt; fixture `none` phải đi qua đường skip nếu phù hợp.

## Architecture

```text
bench/
  fixtures/
    routing.jsonl          # {id, group, prompt, gold, notes}
    routing.holdout.jsonl  # tập giữ riêng, không dùng để tune
  corpus/
    distractors.json       # catalog thật, snapshot lại để eval tái lập được
packages/core/src/eval/
  fixtures.ts              # đọc/validate fixture
  corpus.ts                # gộp gold + distractor
  metrics/
    retrieval.ts           # recall@K, MRR, goldInShortlistRate
    decision.ts            # top1, none P/R/F1, abstention
    stability.ts           # agreement qua N lần lặp
    latency.ts             # p50/p95/p99, tokens
  sweep.ts                 # chạy eval trên lưới tham số
  report.ts                # render Markdown + JSON
packages/cli/src/commands/eval.ts
```

### Định dạng fixture

Mỗi dòng một JSON object trong `bench/fixtures/routing.jsonl`:

```json
{"id":"auth-refactor","group":"coding","prompt":"refactor the auth middleware to use refresh tokens","gold":"ak-backend-development","notes":"sync rõ ràng"}
{"id":"trivial-typo","group":"trivial","prompt":"fix the typo in README line 12","gold":"none","notes":"phải abstain"}
{"id":"chitchat","group":"trivial","prompt":"thanks!","gold":"none","notes":"phải abstain"}
```

`gold: "none"` nghĩa là router phải abstain. Đây là nhóm fixture quan trọng nhất, vì nó đo trực tiếp
cơ chế chặn nhiễu.

### Nhóm fixture bắt buộc

| Nhóm | Mục đích | Số mục tối thiểu |
|---|---|---|
| `coding` | Task cần skill kỹ thuật | 20 |
| `marketing` | Task cần skill domain khác (kiểm tra quota theo kind) | 8 |
| `mcp` | Task mà candidate đúng là một MCP server | 6 |
| `agent` | Task nên delegate cho subagent | 4 |
| `trivial` | Phải abstain hoàn toàn | 15 |
| `ambiguous` | Nhiều capability hợp lý, chấp nhận nhiều đáp án | 6 |
| `vietnamese` | Prompt tiếng Việt, kiểm tra tokenizer và chất lượng đa ngữ | 8 |

Nhóm `ambiguous` khai báo `gold` là một mảng id thay vì một id, và được tính là đúng nếu router chọn
bất kỳ id nào trong mảng.

### Tiêu chí cổng quyết định

Router đạt cổng khi, đo trên tập holdout với `--repeat 5`:

| Chỉ số | Ngưỡng tối thiểu |
|---|---|
| `recall@15` | ≥ 0.90 |
| `top1Accuracy` (toàn bộ, tính cả `none`) | ≥ 0.80 |
| `noneRecall` (nhóm trivial, abstain đúng) | ≥ 0.90 |
| `noneF1` | ≥ 0.80 |
| `agreementRate` | ≥ 0.90 |
| p95 latency | ≤ 1500ms |

Nếu không đạt: sửa prompt/quota trước, không làm tiếp phase 4. Ghi lại cấu hình đã thử và số đo vào
report để quyết định sau có bằng chứng.

## Files to Create / Modify

- Create: `bench/fixtures/routing.jsonl`, `bench/fixtures/routing.holdout.jsonl`
- Create: `bench/corpus/distractors.json`
- Create: `packages/core/src/eval/fixtures.ts`, `corpus.ts`, `sweep.ts`, `report.ts`
- Create: `packages/core/src/eval/metrics/retrieval.ts`, `decision.ts`, `stability.ts`, `latency.ts`
- Create: `packages/core/src/__tests__/eval/metrics.test.ts` (metric test bằng dữ liệu tổng hợp, biết trước đáp án)
- Create: `packages/core/src/__tests__/fixtures/jev-replay/*.json` (response ghi lại cho `--replay`)
- Create: `packages/cli/src/commands/eval.ts`
- Create: `plans/260917-0942-skillful-capability-router/reports/eval-baseline.md`
- Modify: `packages/core/src/router/thresholds.ts` — giá trị mặc định sau khi tune
- Modify: `packages/core/src/retrieval/shortlist.ts` — quota sau khi tune

## Implementation Steps

1. Viết `eval/fixtures.ts` + validator. Fixture sai định dạng phải báo lỗi có số dòng.
2. Soạn fixture cho 7 nhóm. Gold lấy từ catalog thật trên máy. Nhóm `trivial` phải có ít nhất 15 mục,
   trong đó tối thiểu 5 mục là chitchat và 5 mục là yêu cầu cực ngắn. Nhóm `vietnamese` viết prompt
   tiếng Việt.
3. Snapshot catalog thật vào `bench/corpus/distractors.json` để eval tái lập được trên máy khác.
4. Viết `metrics/retrieval.ts` và `metrics/decision.ts`. Test từng hàm bằng dữ liệu tổng hợp mà đáp
   án đã biết (ví dụ: 3 fixture, 1 đúng → top-1 accuracy = 1/3), để bảo đảm công thức không sai.
5. Viết `metrics/stability.ts`: chạy N lần, tính tỉ lệ fixture có cùng quyết định ở mọi lần.
6. Viết `metrics/latency.ts` với p50/p95/p99.
7. Viết `eval/report.ts` render Markdown + JSON. Report phải in rõ cỡ mẫu, N lần lặp, và chỉ số theo
   từng nhóm — không chỉ số tổng.
8. Viết CLI `skillful eval` với `--repeat`, `--limit`, `--replay`, `--json`, `--fixtures`.
9. Ghi lại một bộ response đủ dùng cho `--replay` để CI chạy được không cần key.
10. Chạy baseline trên tập phát triển, ghi vào `reports/eval-baseline.md`.
11. Viết `eval/sweep.ts` và sweep `noneThreshold` ∈ {0.3, 0.4, 0.5, 0.6, 0.7} × quota skill ∈ {4, 6, 8}.
12. Chọn cấu hình tốt nhất theo tiêu chí cổng, chạy lại trên **tập holdout** để xác nhận, rồi cập nhật
    `thresholds.ts` và `shortlist.ts`.
13. Ghi lại cấu hình đã bị loại và số đo tương ứng — để sau này không thử lại mù quáng.

## Verification

```bash
pnpm -r test
node packages/cli/dist/index.js eval --replay --repeat 5 --json | jq '.aggregate, .byGroup'
node packages/cli/dist/index.js eval --fixtures bench/fixtures/routing.holdout.jsonl --repeat 5
node packages/cli/dist/index.js eval --sweep --json > /tmp/sweep.json
```

Cổng quyết định: chạy lệnh thứ hai và đối chiếu từng chỉ số với bảng tiêu chí ở trên. Tất cả chỉ số
phải đạt ngưỡng tối thiểu thì phase mới được coi là xong.

## Todo

- [ ] `eval/fixtures.ts` + validator
- [ ] Fixture 7 nhóm, ≥ 67 mục, có nhóm `vietnamese`
- [ ] Snapshot catalog thật vào `bench/corpus/distractors.json`
- [ ] `metrics/retrieval.ts` + test
- [ ] `metrics/decision.ts` + test
- [ ] `metrics/stability.ts` (N lần lặp, agreement rate)
- [ ] `metrics/latency.ts` (p50/p95/p99)
- [ ] `eval/report.ts` render Markdown + JSON, có breakdown theo nhóm và cỡ mẫu
- [ ] CLI `skillful eval`
- [ ] Bộ replay fixture cho CI chạy offline
- [ ] Baseline report
- [ ] `eval/sweep.ts` + chạy sweep
- [ ] Cập nhật `thresholds.ts` và quota, xác nhận trên holdout
- [ ] Ghi lại cấu hình bị loại và số đo

## Success Criteria

- `skillful eval --replay` chạy được trong CI mà không cần `TYPESAFE_API_KEY`.
- Báo cáo in cỡ mẫu, N lần lặp, chỉ số theo nhóm, và agreement rate.
- Test metric dùng dữ liệu tổng hợp có đáp án biết trước và pass.
- Router đạt toàn bộ tiêu chí cổng trên tập holdout, hoặc có quyết định dừng được ghi lại kèm bằng
  chứng về những gì đã thử.
- `thresholds.ts` và `shortlist.ts` mang giá trị đến từ sweep, không phải từ cảm giác, và report
  baseline ghi rõ giá trị đến từ đâu.

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| Fixture do chính tác giả viết rồi tune trên đó → overfit | Giữ tập holdout riêng, chỉ chạm một lần để xác nhận |
| Gold id trôi khi catalog thay đổi | Kiểm tra gold id tồn tại trong corpus lúc validate; báo lỗi rõ |
| Metric sai công thức một cách âm thầm | Test từng metric bằng dữ liệu tổng hợp có đáp án biết trước |
| Nhóm `trivial` quá dễ → ngưỡng lạc quan giả | Đưa prompt ngắn, mơ hồ, và câu hỏi thường vào nhóm trivial |
| Prompt tiếng Việt không được tokenize đúng | Nhóm fixture riêng, đo tách biệt |
| Sweep tốn nhiều lời gọi API | `--limit` và `--replay` cho vòng lặp phát triển; sweep chạy trên tập con rồi xác nhận trên holdout |

## Security Considerations

- Fixture phải dùng prompt tự soạn. Không đưa prompt thật của khách hàng hay nội dung repo private vào
  fixture được commit.
- `bench/corpus/distractors.json` chứa tên và mô tả skill — phải rà trước khi commit để chắc chắn
  không lộ tên dự án nội bộ hay thông tin khách hàng.
- Report eval có thể chứa tên skill nội bộ; ghi vào `plans/` (không publish) chứ không vào `docs/`.
- Bộ replay fixture chứa response API thật — phải rà để chắc chắn không chứa key hay thông tin định
  danh tài khoản.

## Next Steps

Cấu hình đã tune trở thành mặc định cho phase 4. Nếu cổng không đạt, dừng plan tại đây và ghi lại
phát hiện — đó là kết quả hợp lệ và hữu ích, không phải thất bại.
