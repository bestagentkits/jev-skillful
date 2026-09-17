---
phase: 2
title: "Router Core"
status: pending
priority: P1
effort: "2d"
dependencies: [1]
---

# Phase 2: Router Core

## Context Links

- Plan: [plan.md](./plan.md)
- Phase 1: [Foundation và Catalog Scanner](./phase-01-start.md)
- Bằng chứng TypeSafe: brainstorm §6.3
- Phương pháp đo lường: `reports/research-measurement-methodology.md`

## Goal

Biến catalog đã chuẩn hoá thành một quyết định routing: BM25 prefilter ra shortlist K≈15, gọi Jev
một request duy nhất với câu `choice` (kèm option `none`) và các câu `noul` xếp hạng, rồi trả về
tối đa 1 primary + 2 runner-up.

## Key Insights

**Câu `choice` với option `none` là cơ chế routing, không cần `noul` gate.** Đo thật trên 4 prompt:
"refactor auth middleware" → chọn đúng skill với `noneP` 0.00 và confidence 1.0; "fix typo" →
`noneP` 0.62; "what does this function do?" → 0.54; "thanks!" → 1.00. Ngược lại câu `noul` hỏi "task
có cần capability không" trả 0.39 cho chính task mà `choice` đã chọn đúng, và 0.10 cho cả typo lẫn
thanks nên không phân biệt được gì. Dùng `choice` làm quyết định chính và bỏ hẳn gate.

**Latency không phụ thuộc số candidate.** Đo thật: K=5 với 4 câu hỏi mất 0.745–0.858s; K=15 với 2
câu hỏi mất 0.686–0.762s. Trong đó ~0.21–0.32s là TCP/TLS. Vì vậy K=15 là lựa chọn an toàn cho
chất lượng retrieval mà không phải đánh đổi latency.

**Chi phí ~1360 input token mỗi request**, khoảng $0.00006/prompt. Không phải ràng buộc.

**Ranh giới inject khác ranh giới shortlist.** K=15 là kích thước Jev nhìn thấy. Inject tối đa 3 mục
(1 primary + 2 runner-up). Inject cả 15 sẽ tái tạo anti-pattern "enumerate all skills" mà
arXiv:2604.24594 đã chỉ ra là không scale.

## Requirements

Chức năng:

- BM25 trên `name + description` của catalog, có tokenize phù hợp với skill id (`ak-backend-development`
  phải tách thành `ak`, `backend`, `development`).
- Shortlist theo quota kind để 125 skill không lấn át MCP/agent/command.
- Dựng request Jev: `state` chứa task + candidates; `questions` chứa một `choice` `primary` và một
  `noul` cho mỗi candidate.
- Gọi `https://api.typesafe.ai/v1/systemone` với retry có backoff cho 429 và 529.
- Xếp hạng runner-up theo `noul`, áp ngưỡng, trả tối đa 3 mục.
- Heuristic skip chạy trước khi gọi Jev: prompt quá ngắn, greeting, input bắt đầu bằng `/`.
- Lệnh `skillful route --prompt "..."` để test thủ công, có `--json` và `--explain`.

Phi chức năng:

- Timeout cứng cấu hình được, mặc định 2000ms cho toàn bộ đường đi.
- Không bao giờ throw ra ngoài: mọi lỗi trả một kết quả `degraded` có lý do.
- Không gọi Jev khi heuristic skip kích hoạt.
- Prompt gửi đi bị truncate (mặc định 1000 ký tự).

## Architecture

```text
packages/core/src/
  retrieval/
    tokenize.ts      # lowercase, tách kebab/camel/snake, bỏ stopword
    bm25.ts          # BM25 thuần, không dependency
    shortlist.ts     # BM25 + quota theo kind → K mục
  jev/
    client.ts        # fetch + timeout + retry/backoff (429, 529)
    types.ts         # Question, Answer, request/response shape
  router/
    questions.ts     # dựng state + questions từ task và shortlist
    route.ts         # điều phối: skip → shortlist → Jev → rank → RouteResult
    thresholds.ts    # ngưỡng có tên, có thể override qua config
  config/
    resolve.ts       # thứ tự: CLI flag > env > config file > default
```

### Kiểu dữ liệu chính

```ts
type RouteDecision =
  | { kind: "injected"; primary: Pick; runnersUp: Pick[] }
  | { kind: "skipped"; reason: "heuristic" | "none-won" | "below-threshold" }
  | { kind: "degraded"; reason: "timeout" | "auth" | "upstream" | "config" | "network" };

type RouteResult = {
  decision: RouteDecision;
  shortlist: string[];        // id đã gửi cho Jev
  primary?: { id: string; noneP: number; confidence: number };
  ranking: { id: string; noul: number }[];
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheHit: boolean;
  promptChars: number;
};
```

`RouteResult` là hợp đồng giữa phase 2, 4 (hook) và 5 (telemetry). Mọi field phải serialize được
sang JSONL không mất mát.

### Quota shortlist mặc định

| Kind | Quota |
|---|---|
| skill | 6 |
| mcp | 4 |
| agent | 3 |
| command + rule | 2 |
| **Tổng** | **15** |

Quota phải cấu hình được, vì tỉ lệ kind trên máy người dùng khác nhau và đây sẽ là tham số cần tune
ở phase 3.

### Ngưỡng mặc định

| Tên | Mặc định | Ý nghĩa |
|---|---|---|
| `noneThreshold` | 0.5 | `primary == "none"` hoặc `noneP >= 0.5` thì không inject |
| `runnerUpThreshold` | 0.6 | `noul` tối thiểu để một runner-up được chèn |
| `maxRunnersUp` | 2 | Số runner-up tối đa |
| `minPromptChars` | 12 | Dưới ngưỡng này thì skip |
| `budgetMs` | 2000 | Timeout cứng toàn đường đi |

Ngưỡng `noneThreshold` = 0.5 tách sạch 4/4 mẫu hiện có, nhưng **4 mẫu không phải eval** — phase 3
sở hữu việc tune lại.

## Files to Create / Modify

- Create: `packages/core/src/retrieval/tokenize.ts`, `bm25.ts`, `shortlist.ts`
- Create: `packages/core/src/jev/client.ts`, `types.ts`
- Create: `packages/core/src/router/questions.ts`, `route.ts`, `thresholds.ts`
- Create: `packages/core/src/config/resolve.ts`
- Create: `packages/core/src/__tests__/retrieval/*.test.ts`
- Create: `packages/core/src/__tests__/router/*.test.ts`
- Create: `packages/core/src/__tests__/fixtures/jev-responses/*.json` (response ghi lại, để test offline)
- Modify: `packages/cli/src/index.ts` — thêm command `route`
- Create: `packages/cli/src/commands/route.ts`
- Create: `docs/routing.md`

## Implementation Steps

1. Viết `tokenize.ts`. Phải tách đúng `ak-backend-development` → `ak`, `backend`, `development`;
   `claudeFable` → `claude`, `fable`; `SKILL.md` → `skill`. Lowercase, bỏ dấu câu, bỏ stopword tiếng
   Anh tối thiểu. Test riêng cho tokenizer vì đây là chỗ dễ sai âm thầm.
2. Viết `bm25.ts` thuần (k1=1.2, b=0.75), không thêm dependency. Nhận `docs: {id, text}[]` và
   `query: string`, trả điểm đã sort.
3. Viết `shortlist.ts`: BM25 theo từng kind riêng, lấy top theo quota, gộp lại. Nếu một kind không
   đủ quota thì phần dư không dồn sang kind khác (giữ tính dự đoán được).
4. Viết `jev/client.ts`. Đọc key từ env theo tên cấu hình được (mặc định `TYPESAFE_API_KEY`).
   Retry tối đa 2 lần với backoff cho 429 và 529. Timeout riêng cho request. Không log key.
5. Ghi lại response thật vào `fixtures/jev-responses/` để test offline. Test client bằng cách inject
   `fetch` giả, không gọi mạng trong test.
6. Viết `router/questions.ts`: dựng `state = { task: { text }, candidates: [{id, kind, desc}] }`,
   câu `primary` là `choice` với criteria gồm mọi id candidate cộng `none`, kèm một câu `noul` mỗi
   candidate tham chiếu `state.candidates[i]`. Đặt `none` **đầu tiên** trong criteria để tránh thiên
   lệch thứ tự.
7. Viết `router/route.ts` điều phối đủ 4 nhánh: skip do heuristic, gọi Jev thành công, `none` thắng,
   và degraded do lỗi/timeout. Mọi nhánh trả `RouteResult` hợp lệ.
8. Viết `config/resolve.ts` với thứ tự CLI flag > env > config file > default. Config file ở
   `~/.config/skillful/config.json`. **Không đọc key từ config file** — chỉ từ env, để key không bao
   giờ nằm trong file có thể bị commit.
9. Viết CLI `skillful route --prompt "..." [--json] [--explain]`. `--explain` in shortlist, điểm
   BM25, `noneP`, confidence và lý do quyết định.
10. Viết test cho route.ts bằng `fetch` giả, phủ đủ 4 nhánh cộng trường hợp 429 rồi thành công.

## Verification

```bash
pnpm -r typecheck
pnpm -r test
export TYPESAFE_API_KEY=<key>   # không in ra
node packages/cli/dist/index.js route --prompt "refactor the auth middleware to use refresh tokens" --explain
node packages/cli/dist/index.js route --prompt "thanks!" --json
node packages/cli/dist/index.js route --prompt "fix the typo in README line 12" --json
```

Kỳ vọng: prompt đầu inject `ak-backend-development`; "thanks!" và prompt typo không inject gì; tổng
latency mỗi lần dưới 2000ms.

Test phải chạy hoàn toàn offline (không có `TYPESAFE_API_KEY`) và vẫn pass nhờ `fetch` giả.

## Todo

- [ ] `tokenize.ts` + test cho kebab/camel/snake
- [ ] `bm25.ts` thuần, không dependency
- [ ] `shortlist.ts` + quota theo kind
- [ ] `jev/client.ts` + retry 429/529 + timeout
- [ ] Ghi fixture response thật để test offline
- [ ] `router/questions.ts` với `none` đặt đầu criteria
- [ ] `router/route.ts` phủ đủ 4 nhánh
- [ ] `config/resolve.ts`, key chỉ từ env
- [ ] CLI `skillful route --explain`
- [ ] Test route.ts bằng fetch giả, offline

## Success Criteria

- `skillful route --explain` cho kết quả đúng trên 4 prompt mẫu đã đo ở brainstorm.
- Test suite pass hoàn toàn offline, không cần key, không gọi mạng.
- Cả 4 nhánh của `RouteResult` đều có test.
- Timeout 2000ms được enforce; khi vượt thì trả `degraded` chứ không throw.
- Key không bao giờ xuất hiện trong config file, log, hay thông báo lỗi.

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| Tokenizer sai âm thầm làm BM25 kém | Test riêng cho tokenize với id thật từ catalog |
| Prompt tiếng Việt bị BM25 bỏ qua | Tokenize không phụ thuộc khoảng trắng tiếng Anh; test với prompt tiếng Việt |
| Thứ tự criteria gây thiên lệch chọn `none` | Đặt `none` đầu tiên; đo lại trong phase 3 |
| Key rò qua log hoặc thông báo lỗi | Redact ở tầng logger; test khẳng định key không xuất hiện trong output lỗi |
| `state` quá lớn khi catalog nhiều kind | Giới hạn description còn 200 ký tự trong candidate |

## Security Considerations

- `TYPESAFE_API_KEY` chỉ đọc từ env. Không chấp nhận qua CLI flag (sẽ lộ trong process list) và không
  đọc từ config file.
- Redact key trong mọi log, thông báo lỗi, và output `--explain`.
- Prompt bị truncate trước khi gửi ra ngoài. Có công tắc `--no-prompt-upload` để chỉ gửi catalog.
- Không ghi prompt đầy đủ vào telemetry mặc định; chỉ ghi hash và độ dài.

## Next Steps

Phase 3 dùng `RouteResult` và `shortlist` từ phase này để đo recall@K, top-1 và độ ổn định, rồi tune
lại quota và ngưỡng.
