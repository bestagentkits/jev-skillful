---
title: "Skillful — capability router cho agent runtime"
description: "Hook inject sau mỗi prompt để route skill/MCP/agent/command local qua TypeSafe Jev, kèm dashboard và benchmark A/B trên repo OSS thật để chứng minh hiệu quả."
status: pending
priority: P1
effort: 20d
branch: oss/feat/skillful-capability-router
tags: [feature, oss, cli, agent-tooling, evaluation, experimental]
created: 2026-09-17
---

# Skillful — capability router cho agent runtime

## Overview

Skillful phát hành `npx skillful`, tự cài hook cho 4 agent runtime (Claude Code, Codex, OMP, Pi). Sau
mỗi prompt, hook route tập capability cài trên máy (skills, MCP servers, agents, slash commands) qua
TypeSafe Jev và chèn góp ý đã resolve vào context của agent. Kèm theo là hệ thống đo lường ba tầng, một
dashboard local, và một benchmark A/B trên repo OSS thật để chứng minh — bằng số liệu có thể phản bác —
rằng việc inject có giúp agent giải task tốt hơn hay không.

Dự án hoàn toàn open-source. Người dùng mang theo `TYPESAFE_API_KEY` của chính họ; repo không vận hành
proxy, không thu thập dữ liệu, không phone-home.

## Bối cảnh và vì sao làm

Cách phổ biến để đưa skill vào agent là liệt kê hết skill trong context window. Cách này không scale:
paper *Skill Retrieval Augmentation for Agentic AI* (arXiv:2604.24594) cho thấy khi corpus skill lớn
lên, context budget bị ăn nhanh và **agent trở nên kém chính xác hơn trong việc chọn đúng skill**. Cùng
paper ghi nhận agent hiện nay có xu hướng load skill với tần suất như nhau bất kể task có thực sự cần
capability bên ngoài hay không — nghĩa là nút thắt nằm ở cả việc quyết định **khi nào cần load**, không
chỉ load cái gì.

Trên máy dev của dự án đã có 125 skill (Claude Code), 109 skill (Pi), cùng MCP servers, agents và
commands. Đó là môi trường mà Skillful nhắm vào.

## Mục tiêu

| # | Mục tiêu | Ưu tiên |
|---|----------|---------|
| 1 | Route đúng capability cho prompt, có quyết định abstain đúng trên prompt tầm thường | P1 |
| 2 | Không làm chậm hay chặn agent: budget 2s, fail-open tuyệt đối | P1 |
| 3 | Đo lường được và chứng minh được hiệu quả, kể cả khi kết quả là tiêu cực | P1 |
| 4 | Cài và chạy được trên cả 4 runtime, đã verify bằng chạy thật | P1 |
| 5 | Hoàn toàn local: log nằm trên máy, không phone-home, BYO API key | P1 |
| 6 | Đủ chất lượng để người ngoài đóng góp: test, CI, eval chạy được khi PR | P2 |

## Kiến trúc

```text
Prompt của user
  │
  ├─ [1] Hook runtime (Claude Code / Codex / Pi / OMP)
  │      • cache lookup: hash(prompt chuẩn hoá + catalog fingerprint)
  │      • cache hit  → inject shortlist đã resolve (<50ms)
  │      • cache miss → gọi router trong budget 2000ms
  │      • timeout/lỗi → inject reminder text "npx skillful"
  │
  ├─ [2] Catalog scanner (local, 0 token)
  │      • scan 4 bề mặt × 2 scope (global + project)
  │      • normalize → {id, kind, name, description, source, runtime, scope}
  │      • BM25 + quota theo kind → shortlist K≈15
  │
  ├─ [3] Router (Jev, MỘT request)
  │      state     = { task, candidates[] }
  │      questions = {
  │        primary: choice(over candidate ids + "none"),  ← quyết định chính
  │        q_<id>:  noul per candidate, để xếp hạng runner-up
  │      }
  │
  └─ [4] Inject: TỐI ĐA 1 primary + 2 runner-up
         primary == "none"  → không inject gì
```

### Quyết định thiết kế có ràng buộc

**Inject tối đa 1 primary + 2 runner-up.** K=15 là kích thước mà Jev nhìn thấy, không phải kích thước
được inject. Inject cả 15 candidate vào mỗi prompt sẽ tái tạo đúng anti-pattern "enumerate available
skills" mà arXiv:2604.24594 đã chỉ ra là không scale.

**Không dùng `noul` làm gate "task có cần capability không".** Đo thực tế: noul trả 0.39 cho một task
mà `choice` đã chọn đúng với confidence 1.0, và trả 0.10 cho cả "fix typo" lẫn "thanks" nên không phân
biệt được gì. Chính option `none` trong câu `choice` đã lo việc chặn nhiễu (chitchat → `noneP` 1.00;
typo → 0.62). Bớt một câu hỏi, bớt một nhánh logic, bớt một failure mode.

**BYO key, không proxy.** Người dùng tự đặt `TYPESAFE_API_KEY`. Repo không có server, không giữ key của
ai.

### Đo lường — ba tầng tách rời

Chi tiết ở `reports/research-measurement-methodology.md`. Ràng buộc quan trọng nhất: paper *Skill
Following* (arXiv:2609.00549) chứng minh rằng so sánh trung bình giữa nhóm "có retrieval" và "không
retrieval" **có selection bias nghiêm trọng** và có thể cho lift dương trong khi hiệu ứng thật trên
chính những task đó là âm. Metric đúng là **RAE** — chênh lệch kết quả trên **cùng một task**, chạy ở
hai nhánh matched, chỉ tính trên **subset task mà việc inject thực sự xảy ra**.

| Tầng | Câu hỏi | Metric | Phase |
|---|---|---|---|
| L1 Retrieval | Gold skill có trong shortlist không? | recall@K, MRR, gold-in-shortlist rate | 3 |
| L2 Decision | Router chọn đúng chưa, abstain đúng chưa? | top-1 accuracy, `none` P/R/F1, stability, p50/p95 | 3 |
| L3 Outcome | Inject có làm agent tốt hơn không? | RAE (paired + conditioned), aggregate lift, bảng 4 ô, CI, MDE | 7 |

L1 và L2 là điều kiện cần, không phải bằng chứng. Chỉ L3 trả lời được câu hỏi trung tâm.

### Mức bằng chứng đã chốt

L3 chỉ được coi là **đã chứng minh** khi `RAE > 0` **và** CI 95% (paired bootstrap) không chứa 0. Ba
mức kết luận hợp lệ: `proven`, `not-proven` (CI chứa 0), `harmful` (RAE < 0). Cả ba đều được báo cáo
trung thực và quyết định nội dung README, landing page ở phase 8.

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Foundation và Catalog Scanner](./phase-01-start.md) | Pending |
| 2 | [Router Core](./phase-02-router-core.md) | Pending |
| 3 | [Eval Harness và Tune Ngưỡng](./phase-03-eval-harness-and-thresholds.md) | Pending |
| 4 | [Runtime Hooks và Install](./phase-04-runtime-hooks-and-install.md) | Pending |
| 5 | [Release v0.1](./phase-05-release-v0-1.md) | Pending |
| 6 | [Telemetry và Dashboard](./phase-06-telemetry-and-dashboard.md) | Pending |
| 7 | [A/B Outcome Benchmark trên repo OSS thật](./phase-07-ab-outcome-benchmark.md) | Pending |
| 8 | [Release v0.2](./phase-08-release-v0-2.md) | Pending |

### Mốc phát hành

| Mốc | Sau phase | Nội dung | Số liệu |
|---|---|---|---|
| **v0.1** | 5 | Router + eval + hook trên 4 runtime, docs nền, CI gate, landing page | Số đo eval (L1/L2) |
| **v0.2** | 8 | Telemetry + dashboard + benchmark A/B, docs đo lường | RAE, CI, bảng 4 ô (L3) |

Phase 3 là **cổng chất lượng**: nếu router không đạt ngưỡng trên fixture thì dừng, sửa prompt, và không
làm hook. Phase 7 là **bằng chứng**: nếu kết luận là `not-proven` hoặc `harmful` thì phải viết ra trung
thực, không được quảng bá quá mức.

## Success Criteria

- [ ] `skillful install` cài hook/extension idempotent trên cả 4 runtime, verify bằng chạy thật từng runtime.
- [ ] Hook giữ budget 2000ms; khi router timeout hoặc lỗi thì prompt vẫn đi bình thường và agent không thấy lỗi.
- [ ] Prompt tầm thường (chitchat, typo, hỏi đáp thường) không nhận được injection nào.
- [ ] `skillful eval` chạy được offline qua `--replay`, báo cáo L1 + L2 kèm stability, agreement rate, p50/p95.
- [ ] Cổng eval trong CI chặn được PR hạ chất lượng prompt, và chạy được trên PR từ fork không cần secret.
- [ ] `skillful bench` chạy protocol RAE trên repo OSS thật: cùng task × hai nhánh trong Docker image đóng băng, phân tích trên invoked subset, báo RAE + aggregate + bảng 4 ô + `b`/`c` + CI + **MDE** + cỡ mẫu.
- [ ] `bench-outcome.json` ghi `conclusion` là `proven` / `not-proven` / `harmful`, khớp với CI thực tế.
- [ ] `excluded.json` ghi rõ số task bị loại ở pilot pre-screen và lý do từng loại.
- [ ] `skillful dashboard` sinh một file HTML tự chứa, mở được từ đĩa, hiển thị cả ba tầng + bảng thất bại trung thực.
- [ ] Telemetry mặc định chỉ ghi local; tắt được; có test khẳng định chỉ có một loại network call ra ngoài (tới `api.typesafe.ai`).
- [ ] v0.1.0 và v0.2.0 phát hành trên npm với provenance; README không hứa hẹn vượt quá số liệu.
- [ ] Landing page live tại `skillful.agentkit.best`, nội dung số liệu sinh từ report chứ không chép tay.

## Rủi ro cấp plan

| Rủi ro | Ảnh hưởng | Giảm thiểu |
|---|---|---|
| Router không đủ tốt để chứng minh lợi ích | Toàn bộ premise sụp | Phase 3 là cổng chặn sớm; fixture có distractor; sẵn sàng báo cáo kết quả âm |
| Task repo thật không thực sự capability-bound → RAE ≈ 0 vô nghĩa | Không đo được gì | Pilot pre-screen bắt buộc ở phase 7; task control đã pass bị loại |
| Power thống kê quá thấp trên repo thật | Không kết luận được | Tính và báo cáo MDE; nếu MDE > hiệu ứng kỳ vọng thì kết luận là "chưa đủ dữ liệu" |
| RAE âm dù router tốt (agent bỏ qua injection) | Không chứng minh được giá trị | Đo riêng "acceptance" để tách nguyên nhân router sai vs agent bỏ qua |
| Injection gây context bloat | Làm agent tệ đi | Giới hạn 1+2; nhóm `neutral` và `adversarial` trong suite phát hiện tác hại |
| Jev không tất định | Kết luận không tái lập được | N lần lặp, chạy lại task bất đồng, báo cáo CI và cỡ mẫu |
| Node cold start ăn budget | Hook chậm | Đo `npx skillful` thật ở phase 1; nếu quá chậm thì dùng absolute path tới node thay vì qua npx |
| Docker ảnh hưởng kết quả đo | RAE sai | Cài dependency lúc build image, không lúc chạy task; cấm network trong lúc chạy |
| Hook runtime đổi API | Vỡ trên bản mới | Tách adapter theo runtime; verify bằng chạy thật; doctor phát hiện lệch |

## Cross-Plan Dependencies

Không có. Đây là plan độc lập, repo greenfield.

## Validation Log

### Verification Results

- Claims checked: 20
- Verified: 14 | Failed: 2 | Unverified: 4
- Tier: Full (8 phases, all 4 roles)

**Verified (bằng chứng cụ thể):**

| # | Claim | Bằng chứng |
|---|---|---|
| 1 | TypeSafe API: `POST https://api.typesafe.ai/v1/systemone`, Bearer key, `{state, model, questions}` với `noul`/`choice`/`score` | 8 lời gọi live thành công; `docs.typesafe.ai/api.md` |
| 2 | Latency K=5 (4 câu hỏi): 0.745–0.858s | đo live |
| 3 | Latency K=15 (2 câu hỏi): 0.686–0.762s — **không tăng theo số candidate** | đo live |
| 4 | `choice` + `none` route đúng: auth-refactor → skill đúng, `noneP` 0.00; typo → 0.62; hỏi đáp → 0.54; chitchat → 1.00 | đo live, 2 lần lặp mỗi prompt |
| 5 | `noul` gate phản tác dụng: 0.39 cho task cần capability, 0.10 cho cả typo lẫn thanks | đo live |
| 6 | Claude Code headless: `-p/--print`, `--output-format=stream-json` | `claude --help` live |
| 7 | Pi headless: `-p/--print`, `--mode json` | `pi --help` live |
| 8 | AgentKit `AGENTKIT_API_KEY` = `ak_live_<32>`, có `validateApiKey()` + rate limit 10000/key | đọc source agentkit-web |
| 9 | agentkit-web có proxy tổng quát `/api/proxy/{service}/{path}` | đọc `service-config.ts`, `proxy-handler.ts` |
| 10 | Claude Code/Codex cùng hợp đồng hook `UserPromptSubmit` + `hookSpecificOutput.additionalContext` | đọc `hooks.json`, `simplify-gate.cjs`, `adapters/codex/hook_translator.go` |
| 11 | Pi/OMP extension: `input` + `before_agent_start`, auto-discover từ `~/.{pi,omp}/agent/extensions/*/index.ts` | pi `docs/extensions.md` |
| 12 | Catalog tồn tại trên máy: 125 skill `~/.claude/skills`, 109 skill `~/.pi/agent/skills`, `~/.agents/skills`, 2 MCP `~/.omp/agent/mcp.json`, 2 MCP global + 288 project trong `~/.claude.json`, `~/.codex/config.toml` + `hooks.json` | probe filesystem |
| 13 | arXiv:2609.00549: định nghĩa RAE, paradox aggregate vs RAE, 17 model | đọc abstract |
| 14 | arXiv:2604.24594: "enumerate skills không scale", 5,400 instance + 636 gold + 26,262 corpus, agent load skill với tần suất như nhau | đọc abstract |

**Failed (2):**

| # | Claim | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | `omp` chạy được trên máy | Binary là symlink hỏng tại `~/.bun/bin/omp` → `@oh-my-pi/pi-coding-agent` không còn tồn tại | **User đã chốt: cài lại `omp` trước phase 4** |
| 2 | `codex` chạy được trên máy | Không có binary; `~/.codex/config.toml` (17KB) và `hooks.json` vẫn tồn tại | **User đã chốt: cài `codex` trước phase 4** |

**Unverified (4 — đã gán vào phase, không chặn plan):**

| # | Claim | Phase xử lý |
|---|---|---|
| 1 | Codex đọc hook từ `~/.codex/hooks.json` hay `[hooks.<event>]` trong `config.toml` | 4 (probe bằng chạy thật) |
| 2 | Pi lấy MCP config từ đâu (`settings.json` không có key `mcp`) | 1 (probe) |
| 3 | OMP có cần bật extension tường minh trong `config.yml` | 1 (probe) |

Riêng câu hỏi về Cloudflare đã được trả lời ở Setup Log bên dưới.

### Setup Log (2026-09-17)

**Repo.** `git init` trên nhánh `main`, remote `bestagentkits/jev-skillful`. Commit đầu là bootstrap
(tài liệu plan + `.gitignore` + `.env.example`), không chứa code triển khai. **Mọi thay đổi code sau đó
phải đi qua nhánh riêng và PR**, theo quy tắc phát triển của workspace.

**Bảo mật.** `.env` trong thư mục này được xác minh là **bản sao y nguyên của
`oss/typesafe-demo/.env`** và chứa `TYPESAFE_API_KEY` thật. `.gitignore` loại trừ `.env` và `.env.*`
trước khi commit đầu tiên, và `.env.example` được viết lại cho Skillful (bản cũ mô tả một MCP server
của dự án khác và tham chiếu `docs/typesafe-mcp-server.md` không tồn tại ở đây).

**Cloudflare — nguồn credential (giải quyết câu hỏi mở trước đó).** Credential Cloudflare sẽ lấy từ
`.env` với các biến `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, đã khai báo
(mặc định tắt) trong `.env.example`. **Trạng thái hiện tại: các biến này chưa tồn tại** — đã dò
trong `.env` của dự án, `.env` của agentkit, shell rc, và `wrangler whoami`, không tìm thấy credential
Cloudflare nào. Phải thêm vào `.env` trước khi bắt đầu phase 5. Đây không phải blocker cho phase 1–4.

| # | Câu hỏi | Quyết định |
|---|---|---|
| 1 | Codex/OMP không chạy được nên hook installer không verify được | **Cài cả `codex` và `omp` trước phase 4** → verify hook thật trên 4/4 runtime |
| 2 | Task suite cho benchmark A/B lấy từ đâu | **Task từ repo OSS thật** (SWE-bench-style, Docker đóng băng theo `baseCommit`) |
| 3 | Mức bằng chứng để coi là "đã chứng minh" | **RAE > 0 và CI 95% không chứa 0**; ba mức `proven`/`not-proven`/`harmful` đều phải báo cáo |
| 4 | Mốc phát hành | **Hai mốc**: v0.1 sau phase 5 (router+eval+hook), v0.2 sau phase 8 (đo lường đầy đủ) |

### Propagation Log

<!-- Updated: Validation Session 1 -->

| Quyết định | File bị ảnh hưởng | Thay đổi |
|---|---|---|
| 1 (cài codex+omp) | `phase-01-start.md`, `phase-04-runtime-hooks-and-install.md`, `phase-07-ab-outcome-benchmark.md` | Thêm bước cài binary; bỏ mọi ngôn ngữ hedge về "không test được"; benchmark arms phủ 4/4 runtime |
| 2 (repo OSS thật) | `phase-07-ab-outcome-benchmark.md` (viết lại), `phase-06-telemetry-and-dashboard.md` | Định dạng task SWE-bench-style, Docker đóng băng, pilot pre-screen, `excluded.json`, MDE |
| 3 (CI không chứa 0) | `phase-07-ab-outcome-benchmark.md`, `phase-08-release-v0-2.md`, `plan.md` | Ba mức kết luận; `bench-outcome.json` mang trường `conclusion`; README bị ràng buộc theo mức |
| 4 (hai mốc) | `plan.md`, `phase-05-release-v0-1.md` (mới), `phase-06`, `phase-07`, `phase-08` | Tách release thành 2 phase; đánh số lại 5→8; telemetry/dashboard rời sang v0.2 |

### Whole-Plan Consistency Sweep

Đã đọc lại `plan.md` và cả 8 `phase-*.md` sau khi propagate. Các kiểm tra bắt buộc:

- Không còn tham chiếu tới số phase cũ (5 = telemetry, 6 = bench, 7 = release). Mọi cross-link đã trỏ
  đúng file mới.
- Không còn ngôn ngữ nói rằng Codex hoặc OMP không verify được. Cả hai đã chuyển thành bước cài đặt
  tường minh.
- Không còn tham chiếu tới "repo fixture tự dựng" như nguồn task của benchmark. Phase 7 đã đổi sang task
  từ repo OSS thật; nhóm `capability-bound`/`neutral`/`adversarial` giữ nguyên tên nhưng nội dung đổi
  sang task thật.
- Ngưỡng cổng chất lượng ở phase 3 khớp với ngưỡng được dẫn lại ở phase 5 và phase 7.
- Giới hạn inject "1 primary + 2 runner-up" nhất quán giữa `plan.md`, phase 2, phase 4, phase 6.
- Quyết định bỏ `noul` gate nhất quán giữa `plan.md`, phase 2, phase 3.
- `AGENTKIT_API_KEY` không còn xuất hiện như một dependency của bất kỳ phase nào (dự án đã chuyển sang
  BYO `TYPESAFE_API_KEY`).
- Effort tổng `20d` khớp tổng 8 phase: 2+2+2+3+2+2+5+2.
- Bảng phases dùng đúng định dạng canonical 3 cột mà `ak plan` yêu cầu.

Không còn mâu thuẫn chưa giải quyết.

## Tham chiếu

- Brainstorm: `plans/reports/brainstorm-260917-1623-skillful-capability-router.md`
- Phương pháp đo lường: `plans/260917-0942-skillful-capability-router/reports/research-measurement-methodology.md`
- TypeSafe API: https://docs.typesafe.ai/api.md
- RAE / Skill Following: https://arxiv.org/abs/2609.00549
- Skill Retrieval Augmentation: https://arxiv.org/abs/2604.24594
- Pi extension API: https://github.com/earendil-works/pi-coding-agent (docs/extensions.md)
