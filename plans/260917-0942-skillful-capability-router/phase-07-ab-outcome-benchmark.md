---
phase: 7
title: "A/B Outcome Benchmark trên repo OSS thật"
status: pending
priority: P1
effort: "5d"
dependencies: [6]
---

# Phase 7: A/B Outcome Benchmark trên repo OSS thật

## Context Links

- Plan: [plan.md](./plan.md)
- Phase 6: [Telemetry và Dashboard](./phase-06-telemetry-and-dashboard.md)
- Phương pháp đo lường: `reports/research-measurement-methodology.md`
- Paper chính: arXiv:2609.00549 (RAE, paradox aggregate vs RAE)
- Paper phụ: arXiv:2604.24594 (SRA-Bench, cấu trúc 3 tầng, distractor corpus)

## Goal

Chạy benchmark A/B trên **task thật từ repo OSS có test suite sẵn** để trả lời câu hỏi trung tâm —
inject có làm agent giải task tốt hơn không — bằng protocol RAE, và kết luận theo đúng mức bằng chứng
đã chốt: **RAE > 0 và CI 95% không chứa 0**.

## Key Insights

**Task thật đổi bản chất bài toán đo lường, theo hai hướng ngược nhau.** Hướng tốt: kết quả thuyết phục
với người ngoài vì không ai nghĩ ra task để tự khen. Hướng xấu: repo thật ồn hơn nhiều, nên phải xử lý
ba vấn đề mà fixture tự dựng không có.

**Vấn đề 1 — chọn task mà capability thực sự gánh trọng số.** Với repo thật, không có gì bảo đảm skill
nào trong catalog liên quan tới task. Phải **pre-screen bằng một pilot ở nhánh control**: chạy 5-10 task
trước, task nào control đã pass 100% thì không phải capability-bound (loại hoặc chuyển sang nhóm
`neutral`), task nào control fail 100% có thể quá khó hoặc đúng là capability-bound. Không có bước này
thì RAE sẽ xấp xỉ 0 một cách vô nghĩa và không phân biệt được "capability không giúp" với "capability
không liên quan".

**Vấn đề 2 — power thống kê.** Outcome nhị phân + cặp bất đồng ít thì CI rất rộng. Phải tính và báo cáo
**hiệu ứng nhỏ nhất phát hiện được (MDE)** theo cỡ mẫu thực tế, thay vì chỉ in p-value. Nếu MDE lớn hơn
hiệu ứng kỳ vọng thì kết luận đúng là "chưa đủ dữ liệu để kết luận".

**Vấn đề 3 — hạ tầng.** Repo thật cần cài dependency và build. Đây là lý do dùng định dạng
SWE-bench-style với Docker image đóng băng theo `base_commit`, build một lần rồi cache. Không có môi
trường đóng băng thì kết quả không tái lập được và RAE vô nghĩa.

**Protocol RAE không đổi, nhưng cách diễn giải phải chặt hơn.** Paper arXiv:2609.00549 chỉ ra rằng lift
tổng hợp có thể dương trong khi hiệu ứng thật trên chính task đó là âm. Với repo thật, khoảng cách giữa
hai con số này thường lớn hơn, nên càng phải in cả hai cạnh nhau.

**Test thống kê đúng là McNemar**, vì đây là cặp bất đồng trên cùng task chứ không phải hai tỉ lệ độc
lập. `b` = control pass / treatment fail (inject làm hại), `c` = control fail / treatment pass (inject
cứu được). Hướng của RAE là `c − b`.

## Requirements

Chức năng:

- Task theo định dạng SWE-bench-style: `{id, repo, baseCommit, problemStatement, testCommand,
  failToPass[], passToPass[], capabilityHint, group}`.
- Môi trường đóng băng theo `base_commit` bằng Docker image, build một lần rồi cache.
- Harness chạy mỗi task ở hai nhánh trên cùng image và cùng `base_commit`:
  - `control`: `SKILLFUL_DISABLE=1`.
  - `treatment`: inject bật.
- Success khách quan: mọi test trong `failToPass` chuyển sang pass, và mọi test trong `passToPass` vẫn
  pass. Không có người chấm.
- Thu mỗi lần chạy: success, turns, tool calls, tokens in/out, wall-clock, chi phí, `injectionObserved`.
- **Pilot pre-screen** ở nhánh control để loại task không capability-bound.
- Tính: RAE trên invoked subset, aggregate lift trên toàn bộ, bảng 4 ô, `b`, `c`, McNemar, paired
  bootstrap CI, và **MDE** theo cỡ mẫu thực tế.
- Lặp R=3; chạy lại 3 lần các task bất đồng để tách tín hiệu khỏi nondeterminism của agent.
- Phân loại thất bại cho task thuộc ô "control pass / treatment fail".
- Kết luận theo ba mức: `proven` (RAE > 0 và CI 95% không chứa 0), `not-proven` (CI chứa 0),
  `harmful` (RAE < 0). Ghi mức vào report và vào `plans/<plan>/reports/bench-outcome.json`.
- Xuất dữ liệu cho dashboard phần 5 và 6.
- `skillful bench --suite <path> --arms control,treatment --repeat R` với `--task`, `--pilot`,
  `--resume`.

Phi chức năng:

- Trần chi phí và trần thời gian cho cả suite; dừng sớm và báo cáo phần đã chạy.
- Resume được suite bị dừng.
- Chạy được một task đơn lẻ để debug.
- Docker image được cache, không build lại mỗi lần chạy.
- Chạy được song song có giới hạn để giảm wall-clock mà không làm nhiễu phép đo (mỗi task vẫn độc lập).

## Architecture

```text
bench/
  datasets/
    selected.json               # task đã qua pilot, kèm số đo pre-screen
    candidates.json             # task ứng viên trước pilot
    excluded.json               # task bị loại ở pilot + lý do
  env/
    images.json                 # repo → base image, build recipe, cache key
  suites/
    core/suite.json             # ~40 task đã qua pilot
    neutral/suite.json          # ~10 task, capability không liên quan
    adversarial/suite.json      # ~6 task, capability trông hợp nhưng sai
packages/core/src/bench/
  task.ts
  dataset.ts                    # nạp SWE-bench-style task
  screening.ts                  # pilot pre-screen + phân nhóm
  docker.ts                     # build/cache/run trong image đóng băng
  runner.ts
  agent-cli.ts                  # adapter headless cho 4 runtime
  analysis/
    rae.ts
    quadrants.ts
    significance.ts             # McNemar, paired bootstrap CI
    power.ts                    # MDE theo cỡ mẫu
    taxonomy.ts
  report.ts
packages/cli/src/commands/bench.ts
```

### Định nghĩa chỉ số

| Chỉ số | Định nghĩa |
|---|---|
| `invokedSubset` | Task mà ở nhánh treatment, quyết định là `injected` |
| `RAE` | Trung bình của `(treatment_success − control_success)` trên `invokedSubset` |
| `aggregateLift` | Trung bình của `(treatment_success − control_success)` trên toàn bộ task |
| `b` | Số task control pass và treatment fail (inject làm hại) |
| `c` | Số task control fail và treatment pass (inject cứu được) |
| `bootstrapCI` | CI 95% theo cặp, resample trên **task** chứ không resample trên lần chạy |
| `mcnemar` | Test McNemar trên cặp bất đồng `b`/`c` |
| `mde` | Hiệu ứng nhỏ nhất phát hiện được ở cỡ mẫu hiện tại |

**Quy tắc báo cáo bắt buộc:** luôn in `RAE` cùng `aggregateLift` cùng `b`, `c`, `n`, `nInvoked`, `R`,
CI, và MDE. Không bao giờ in `aggregateLift` một mình. Bảng 4 ô là phần bắt buộc.

### Ba mức kết luận

| Mức | Điều kiện | Ý nghĩa cho phase 8 |
|---|---|---|
| `proven` | RAE > 0 và CI 95% không chứa 0 | README và landing page được nói "đã chứng minh, có số liệu" |
| `not-proven` | CI 95% chứa 0 | README nói "chưa chứng minh được"; không được nói "giúp agent tốt hơn" |
| `harmful` | RAE < 0 | README nói rõ inject làm hại trên tập này; phải điều tra trước khi quảng bá |

Cả ba đều là kết quả hợp lệ và phải được báo cáo. **Không chỉnh sửa suite, ngưỡng, hay cách chọn task
sau khi đã nhìn kết quả.** Nếu phải sửa, phải chạy lại toàn bộ và ghi rõ trong report rằng suite đã đổi.

### Nhóm task

| Nhóm | Mô tả | Số task mục tiêu | Kỳ vọng |
|---|---|---|---|
| `capability-bound` | Task thuộc repo mà capability trong catalog thật sự áp dụng được | 30 | inject giúp |
| `mcp-bound` | Task cần thông tin ngoài repo mà MCP server cung cấp được | 6 | inject giúp |
| `neutral` | Task repo thật, capability không liên quan | 10 | inject không đổi kết quả |
| `adversarial` | Task mà capability trông hợp nhưng thực ra sai | 6 | inject không được hại |

### Quy trình chọn task (bắt buộc theo thứ tự)

1. Lấy task ứng viên từ dataset có sẵn (SWE-bench-style) — không tự nghĩ ra task.
2. Tính ánh xạ repo → capability: language, framework, tooling của repo so với catalog trên máy.
   Chỉ giữ task thuộc repo có ít nhất một capability khớp hợp lý.
3. **Pilot**: chạy nhánh control trên task ứng viên. Phân loại:
   - Control pass → không capability-bound → chuyển sang `neutral` hoặc loại.
   - Control fail → giữ làm `capability-bound`, kèm ghi chú vì sao capability được cho là gánh trọng số.
   - Control fail vì lỗi môi trường (build hỏng, test không chạy được) → loại, ghi vào `excluded.json`.
4. Chốt suite `core`, `neutral`, `adversarial` và **đóng băng** chúng trước khi chạy chính thức.
5. Ghi lại toàn bộ quá trình lọc vào `bench/datasets/excluded.json` để người đọc biết có bao nhiêu task
   bị loại và vì sao — đây là phần quan trọng để đánh giá độ tin cậy của kết quả.

## Files to Create / Modify

- Create: `bench/datasets/candidates.json`, `selected.json`, `excluded.json`
- Create: `bench/env/images.json` (+ Dockerfile nếu cần cho từng repo)
- Create: `bench/suites/core/suite.json`, `neutral/suite.json`, `adversarial/suite.json`
- Create: `packages/core/src/bench/task.ts`, `dataset.ts`, `screening.ts`, `docker.ts`, `runner.ts`, `agent-cli.ts`, `report.ts`
- Create: `packages/core/src/bench/analysis/rae.ts`, `quadrants.ts`, `significance.ts`, `power.ts`, `taxonomy.ts`
- Create: `packages/core/src/__tests__/bench/analysis.test.ts` (công thức + dữ liệu tổng hợp có đáp án biết trước)
- Create: `packages/cli/src/commands/bench.ts`
- Create: `plans/260917-0942-skillful-capability-router/reports/bench-outcome.md`
- Create: `plans/260917-0942-skillful-capability-router/reports/bench-outcome.json`
- Modify: `packages/dashboard/src/sections/ab-outcome.ts`, `honest-failure.ts`

## Implementation Steps

1. Viết `dataset.ts` + `task.ts` cho định dạng SWE-bench-style. Task thiếu `testCommand` hoặc có
   `failToPass` rỗng thì báo lỗi rõ.
2. Viết `docker.ts`: build image theo `repo` + `baseCommit`, cache theo key `repo@commit`, chạy lệnh
   trong container với working tree là repo ở `baseCommit`. Khẳng định image đã cache thì không build
   lại.
3. Viết `agent-cli.ts`. Với mỗi runtime, **đọc live help để xác định flag headless** thay vì hardcode:
   `claude -p`, `codex exec`, `pi -p`, `omp -p` — xác nhận từng cái và ghi lại vào
   `docs/architecture.md`. Cả 4 runtime đã được cài và verify ở phase 4.
4. Viết `runner.ts`: chạy một task ở một nhánh trong container, bật/tắt inject qua `SKILLFUL_DISABLE`,
   chạy `testCommand`, xác định success từ kết quả test, thu metric, và ghi `injectionObserved` từ
   telemetry của chính lần chạy đó.
5. Viết `screening.ts` cho pilot pre-screen, cộng logic phân nhóm và ghi `excluded.json`.
6. Viết `analysis/rae.ts` và `quadrants.ts`. Test bằng dữ liệu tổng hợp có đáp án biết trước: ví dụ 4
   task với outcome đã biết → assert RAE, `b`, `c`, bảng 4 ô đúng từng con số.
7. Viết `analysis/significance.ts`: McNemar trên `b`/`c`, paired bootstrap CI 10,000 vòng resample trên
   task.
8. Viết `analysis/power.ts`: MDE theo `n` và tỉ lệ bất đồng quan sát được. Báo cáo MDE cạnh CI.
9. Chọn task ứng viên, tính ánh xạ repo → capability, và chạy pilot ở nhánh control. Đây là bước tốn
   thời gian nhất; dùng `--resume`.
10. Chốt và **đóng băng** ba suite. Ghi lại mọi task bị loại kèm lý do.
11. Smoke 1 task ở cả hai nhánh để xác nhận harness và Docker hoạt động.
12. Chạy suite đầy đủ với `--repeat 3`. Có trần chi phí; dừng sớm nếu vượt và báo cáo phần đã chạy.
13. Chạy lại 3 lần các task thuộc cặp bất đồng để tách tín hiệu khỏi nondeterminism.
14. Viết `analysis/taxonomy.ts`: phân loại task thuộc ô "control pass / treatment fail" — capability sai
    được inject, agent đi theo gợi ý sai, context bloat, hay nondeterminism.
15. Viết report `bench-outcome.md` + `bench-outcome.json` với đầy đủ các trường bắt buộc, và ghi mức kết
    luận (`proven` / `not-proven` / `harmful`).
16. Wire kết quả vào dashboard phần 5 và 6.
17. Nếu mức là `not-proven` hoặc `harmful`: ghi rõ và đề xuất bước sửa. Không chỉnh suite hay ngưỡng.

## Verification

```bash
pnpm -r test
node packages/cli/dist/index.js bench --suite bench/suites/core/suite.json --task <id>     # smoke
node packages/cli/dist/index.js bench --suite bench/suites/core/suite.json --pilot         # pre-screen
node packages/cli/dist/index.js bench --suite bench/suites/core/suite.json --arms control,treatment --repeat 3
node packages/cli/dist/index.js bench --suite bench/suites/neutral/suite.json --repeat 3
node packages/cli/dist/index.js dashboard
jq '.conclusion, .rae, .ci, .b, .c, .n, .nInvoked, .mde' \
  plans/260917-0942-skillful-capability-router/reports/bench-outcome.json
```

Cổng của phase: report tồn tại với đầy đủ trường bắt buộc; `conclusion` là một trong ba mức;
`excluded.json` ghi rõ số task bị loại và lý do; dashboard phần 5 và 6 hiển thị đúng số liệu.

## Todo

- [ ] `task.ts` + `dataset.ts` cho định dạng SWE-bench-style
- [ ] `docker.ts` build/cache/run theo `repo@commit`
- [ ] `agent-cli.ts` xác định flag headless cho 4 runtime từ live help
- [ ] `runner.ts` + `injectionObserved`
- [ ] `screening.ts` pilot pre-screen + `excluded.json`
- [ ] `analysis/rae.ts` + test dữ liệu tổng hợp
- [ ] `analysis/quadrants.ts` + test
- [ ] `analysis/significance.ts` (McNemar + paired bootstrap CI)
- [ ] `analysis/power.ts` (MDE)
- [ ] Chọn task ứng viên + ánh xạ repo → capability
- [ ] Chạy pilot pre-screen ở nhánh control
- [ ] Đóng băng 3 suite + ghi `excluded.json`
- [ ] Smoke 1 task cả hai nhánh
- [ ] Chạy suite đầy đủ `--repeat 3`, có trần chi phí
- [ ] Chạy lại 3 lần các task bất đồng
- [ ] `analysis/taxonomy.ts` phân loại task bị hại
- [ ] Report `bench-outcome.md` + `.json` với mức kết luận
- [ ] Wire vào dashboard phần 5 và 6

## Success Criteria

- Mỗi task chạy ở cả hai nhánh trên cùng Docker image và cùng `baseCommit`; harness từ chối chạy nếu
  image không khớp commit.
- Pilot pre-screen đã chạy, và `excluded.json` ghi rõ số task bị loại cùng lý do từng loại.
- Report in đủ: `n`, `nInvoked`, `R`, `RAE`, `aggregateLift`, `b`, `c`, CI, McNemar, **MDE**, bảng 4 ô,
  bảng per-task.
- Report **không bao giờ** in `aggregateLift` một mình mà thiếu RAE và bảng 4 ô.
- `conclusion` được ghi là một trong `proven` / `not-proven` / `harmful`, và khớp với CI thực tế.
- Test công thức RAE, `b`, `c`, bảng 4 ô, và McNemar pass trên dữ liệu tổng hợp có đáp án biết trước.
- Nhóm `neutral` cho thấy inject không gây hại rõ rệt; nếu có hại thì đó là phát hiện được báo cáo.
- Dashboard phần 5 và 6 hiển thị đúng số liệu, kể cả khi kết luận là `not-proven` hoặc `harmful`.

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| Task không capability-bound → RAE ≈ 0 vô nghĩa | Pilot pre-screen bắt buộc; task control đã pass bị loại hoặc chuyển sang `neutral` |
| Power quá thấp, CI quá rộng, không kết luận được | Tính và báo cáo MDE; nếu MDE lớn hơn hiệu ứng kỳ vọng thì kết luận là "chưa đủ dữ liệu", và mở rộng suite ở vòng sau |
| Repo thật không build được trong container | Loại ở pilot, ghi vào `excluded.json`; không đưa task lỗi môi trường vào suite |
| Agent không tất định làm nhiễu tín hiệu | R=3; chạy lại 3 lần task bất đồng; báo cáo phân tán giữa các lần |
| Chi phí và thời gian vượt kiểm soát | Trần chi phí và thời gian; Docker cache; chạy song song có giới hạn; `--resume` |
| Vô thức tune theo kết quả đã nhìn | Đóng băng suite trước khi chạy; ghi rõ trong method rằng đổi suite thì phải chạy lại toàn bộ |
| Harness rò state giữa hai nhánh | Container mới hoặc reset về `baseCommit` cho mỗi lần chạy; khẳng định working tree sạch |
| Kết quả bị ảnh hưởng bởi network/registry trong lúc chạy | Cài dependency trong lúc build image, không trong lúc chạy task |

## Security Considerations

- Docker container phải chạy không có quyền truy cập vào thư mục home thật; chỉ mount thư mục task.
- Không mount `~/.claude`, `~/.codex`, `~/.pi`, `~/.omp` vào container ở nhánh nào — hook cấu hình nằm
  trong image hoặc thư mục task, không lấy từ home thật.
- Không truyền `TYPESAFE_API_KEY` vào container của task; hook gọi ra ngoài qua proxy của host hoặc
  không gọi. Ghi rõ cách ly này trong docs.
- Report chứa problem statement và diff từ repo public — an toàn để commit, nhưng vẫn rà vì có thể chứa
  nội dung từ repo private nếu dataset trộn.
- Có công tắc dừng khẩn cấp để không đốt quota ngoài ý muốn.

## Next Steps

`bench-outcome.json` quyết định nội dung phase 8: mức `proven` cho phép landing page nói "đã chứng minh
bằng số liệu"; `not-proven` và `harmful` đều phải được viết ra trung thực, kèm hướng dẫn để người dùng
tự chạy `skillful bench` trên máy họ.
