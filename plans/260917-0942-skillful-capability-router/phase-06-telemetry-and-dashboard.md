---
phase: 6
title: "Telemetry và Dashboard"
status: pending
priority: P1
effort: "2d"
dependencies: [5]
---

# Phase 5: Telemetry và Dashboard

## Context Links

- Plan: [plan.md](./plan.md)
- Phase 5: [Release v0.1](./phase-05-release-v0-1.md) — dependency trực tiếp; hạ tầng CI/docs đã có
- Phase 4: [Runtime Hooks và Install](./phase-04-runtime-hooks-and-install.md) — nơi ghi sự kiện `route`
- Phương pháp đo lường: `reports/research-measurement-methodology.md`
- Paper: arXiv:2609.00549 (RAE, bảng 4 ô per-task)

## Goal

Ghi lại đủ dữ liệu local để tái dựng phân tích hiệu quả về sau, và sinh một dashboard HTML tự chứa
hiển thị cả ba tầng đo lường cộng bảng thất bại trung thực.

## Key Insights

**Telemetry phải ghi đủ để tính RAE, không chỉ để vẽ biểu đồ.** Paper arXiv:2609.00549 định nghĩa RAE
là chênh lệch kết quả trên cùng task giữa hai nhánh matched, chỉ tính trên subset task mà việc inject
thực sự xảy ra. Nếu log không ghi được prompt hash, shortlist, quyết định, và lý do thì không thể tái
dựng phân tích — và không thể tính RAE.

**Phải tách được "router sai" khỏi "agent bỏ qua".** Đây là lý do phải ghi thêm sự kiện
`capability-used`. Nếu chỉ ghi lúc route thì khi kết quả kém sẽ không biết là do chọn sai hay do agent
không dùng gợi ý. Hai nguyên nhân này cần hai cách sửa hoàn toàn khác nhau.

**Bảng 4 ô là deliverable hạng nhất, không phải phụ lục.** Chính bảng này là thứ chứng minh được
điều mà một con số trung bình che mất: có bao nhiêu task mà inject làm hại. Paper 1 chỉ ra rằng lift
tổng hợp có thể dương trong khi hiệu ứng thật trên chính task đó là âm.

**Không phone-home.** Log nằm trên máy người dùng. Đây là điều kiện để một công cụ OSS đáng tin, và
cũng là điều khiến dashboard phải chạy local thay vì là một web service.

## Requirements

Chức năng:

- Ghi sự kiện JSONL append-only, mỗi dòng một object, versioned.
- Hai loại sự kiện: `route` (một lần route) và `capability-used` (agent thực sự dùng một capability).
- Xoay file log theo kích thước; dọn log cũ theo retention cấu hình được.
- Chịu được nhiều hook ghi đồng thời (append là atomic với dòng nhỏ trên POSIX; phải test trên
  Windows).
- `skillful report --html <out>` sinh một file HTML tự chứa đọc được từ đĩa.
- `skillful dashboard` sinh report với vị trí mặc định và in đường dẫn (`--open` để mở).
- Dashboard gồm 6 phần: tổng quan, chất lượng routing, vận hành, adoption, kết quả A/B, thất bại
  trung thực.
- `--include-prompts` để đưa prompt vào report (mặc định tắt).
- `skillful telemetry --disable` / `--enable` và biến env tương ứng.

Phi chức năng:

- Sinh report cho 50,000 sự kiện dưới 3 giây.
- Report tự chứa: không có request mạng, không có asset ngoài khi mở file.
- Không đọc key hay env value vào report.

## Architecture

```text
packages/core/src/telemetry/
  events.ts          # định nghĩa kiểu event + schema version
  writer.ts          # append JSONL, giới hạn kích thước dòng, atomic append
  reader.ts          # stream đọc, chịu được dòng hỏng
  retention.ts       # xoay và dọn theo kích thước/số ngày
  paths.ts           # XDG: ~/.local/state/skillful/ (Linux), ~/Library/... (mac), %LOCALAPPDATA% (win)
packages/dashboard/
  src/render.ts      # sinh HTML
  src/sections/*.ts  # 6 phần
  src/charts.ts      # SVG inline, không dependency ngoài
packages/cli/src/commands/
  report.ts
  dashboard.ts
  telemetry.ts
```

### Schema sự kiện

```jsonc
// kind: "route"
{
  "v": 1, "kind": "route", "ts": "2026-09-17T09:00:00.000Z",
  "runtime": "claude-code", "sessionId": "abc",
  "promptHash": "sha256:...", "promptChars": 132,
  "catalogFingerprint": "sha256:...", "candidateCount": 15,
  "candidateIds": ["ak-backend-development", "..."],
  "primary": "ak-backend-development", "noneP": 0.02, "confidence": 1.0,
  "ranking": [{"id": "ak-backend-development", "noul": 0.91}],
  "decision": "injected", "reason": "primary",
  "latencyMs": 742, "cacheHit": false,
  "tokensIn": 1360, "tokensOut": 140, "error": null
}

// kind: "capability-used"
{
  "v": 1, "kind": "capability-used", "ts": "2026-09-17T09:00:12.000Z",
  "runtime": "claude-code", "sessionId": "abc",
  "capabilityId": "ak-backend-development", "via": "skill-invoked"
}
```

Correlation giữa `capability-used` và `route` diễn ra **lúc đọc report**, theo `sessionId` và cửa sổ
thời gian. Không cần state trong hook, nên hook vẫn không trạng thái và không thể hỏng vì correlation.

### Sáu phần của dashboard

| # | Phần | Nội dung | Nguồn |
|---|---|---|---|
| 1 | Tổng quan | Số prompt, injection rate, abstention rate, cache hit rate, degrade rate | events |
| 2 | Chất lượng routing | top-1, `none` P/R/F1, recall@K, agreement rate, breakdown theo nhóm | `eval` results |
| 3 | Vận hành | p50/p95/p99 latency, token trung bình, chi phí ước tính, tỉ lệ degrade theo nguyên nhân | events |
| 4 | Adoption | Acceptance rate: tỉ lệ gợi ý được agent thực sự dùng | events (correlated) |
| 5 | Kết quả A/B | RAE, aggregate lift, bảng 4 ô, cỡ mẫu, CI | `bench` results |
| 6 | Thất bại trung thực | Danh sách task inject làm hại; phân loại nguyên nhân | `bench` results |

Phần 5 và 6 đọc kết quả do phase 6 sinh ra. Khi chưa có, dashboard hiển thị trạng thái "chưa chạy
benchmark" thay vì bịa số hoặc ẩn phần đi.

Phần 6 là phần dễ bị bỏ qua nhất và cũng là phần quyết định độ tin cậy của cả dashboard. Một dashboard
chỉ hiển thị số dương mà không có ô "injection làm hại" thì không đáng tin — và đúng là kiểu báo cáo
mà arXiv:2609.00549 cảnh báo.

## Files to Create / Modify

- Create: `packages/core/src/telemetry/events.ts`, `writer.ts`, `reader.ts`, `retention.ts`, `paths.ts`
- Create: `packages/core/src/__tests__/telemetry/*.test.ts`
- Create: `packages/core/src/__tests__/fixtures/events/*.jsonl` (log mẫu, có dòng hỏng, để test reader)
- Create: `packages/dashboard/package.json`, `src/render.ts`, `src/sections/*.ts`, `src/charts.ts`
- Create: `packages/cli/src/commands/report.ts`, `dashboard.ts`, `telemetry.ts`
- Modify: `packages/core/src/hooks/render.ts` — ghi sự kiện `route` sau mỗi lần route
- Create: `docs/telemetry.md` (schema, quyền riêng tư, cách tắt)
- Create: `docs/measurement.md` (giải thích ba tầng, RAE, cách đọc dashboard)

## Implementation Steps

1. Viết `paths.ts` cho 3 hệ điều hành. Test bằng cách bơm biến môi trường giả, không chạm thư mục thật.
2. Viết `events.ts`: kiểu dữ liệu + validator. Sự kiện sai schema bị bỏ qua khi đọc, không làm sập
   report.
3. Viết `writer.ts`: append một dòng JSON. Truncate `promptChars` và `candidateIds` để một dòng không
   vượt quá giới hạn. Không bao giờ throw — telemetry hỏng không được làm hook hỏng.
4. Viết `reader.ts` dạng stream, bỏ qua dòng hỏng và đếm số dòng bị bỏ để báo cáo minh bạch.
5. Viết `retention.ts`: xoay khi vượt kích thước, dọn theo số ngày. Chạy ở lần ghi thứ N, không chạy
   mỗi lần ghi.
6. Wire vào `hooks/render.ts`: sau khi có `RouteResult` thì ghi sự kiện `route`. Ghi telemetry phải
   không nằm trên đường tới hạn của budget — ghi lỗi thì bỏ qua.
7. Ghi `capability-used`: thêm một nhánh trong hook để nhận diện capability invocation từ payload của
   runtime. Với Pi/OMP dùng event `tool_call`; với Claude Code/Codex dùng `PostToolUse`. Nếu runtime
   không cung cấp đủ thông tin thì ghi `via: "unobserved"` thay vì bịa.
8. Viết `charts.ts`: SVG inline thuần, không dependency. Cần: bar chart, histogram, scatter cho bảng
   4 ô. Giữ nhỏ và không màu mè.
9. Viết `render.ts` sinh HTML tự chứa: CSS inline, dữ liệu nhúng dạng JSON trong `<script>`, không
   request ngoài. Xuất số liệu thô kèm bảng để người đọc tự kiểm chứng.
10. Viết CLI `skillful report --html <path>` và `skillful dashboard [--open]`.
11. Viết `docs/measurement.md` giải thích ba tầng, định nghĩa RAE, và cách đọc từng phần của dashboard
    — đặc biệt là phần 6 và tại sao nó tồn tại.
12. Test hiệu năng: sinh 50,000 sự kiện tổng hợp, đo thời gian render, phải dưới 3 giây.

## Verification

```bash
pnpm -r test
node packages/cli/dist/index.js report --html /tmp/report.html
node packages/cli/dist/index.js dashboard --open
node packages/cli/dist/index.js telemetry --disable
node packages/cli/dist/index.js telemetry --enable
wc -l ~/.local/state/skillful/events.jsonl
```

Kỳ vọng: report mở được từ đĩa không cần server; 6 phần đều hiển thị, phần 5 và 6 hiện trạng thái
"chưa chạy benchmark" khi chưa có dữ liệu; `telemetry --disable` làm hook ngừng ghi; render 50,000 sự
kiện dưới 3 giây.

## Todo

- [ ] `paths.ts` cho macOS/Linux/Windows
- [ ] `events.ts` + validator
- [ ] `writer.ts` append JSONL, không bao giờ throw
- [ ] `reader.ts` stream, đếm dòng hỏng
- [ ] `retention.ts` xoay + dọn
- [ ] Wire ghi sự kiện `route` vào hook
- [ ] Ghi `capability-used` cho 4 runtime, có nhánh `unobserved`
- [ ] `charts.ts` SVG inline, không dependency
- [ ] `render.ts` HTML tự chứa, 6 phần
- [ ] Phần 6 (thất bại trung thực) hiển thị đúng khi có dữ liệu
- [ ] CLI `report` và `dashboard`
- [ ] `docs/telemetry.md` + `docs/measurement.md`
- [ ] Test hiệu năng 50,000 sự kiện

## Success Criteria

- Report HTML mở được từ đĩa, không request mạng nào (kiểm bằng cách ngắt mạng khi mở).
- Dashboard hiển thị cả 6 phần; phần 5 và 6 không bao giờ bịa số, chỉ hiện trạng thái chưa có dữ liệu.
- Telemetry tắt được và không ghi gì khi tắt.
- Log hỏng hoặc dòng sai schema không làm report thất bại; số dòng bị bỏ được báo cáo.
- 50,000 sự kiện render dưới 3 giây.
- `docs/measurement.md` giải thích được RAE và vì sao phần 6 tồn tại.
- Không có prompt text trong log mặc định; `--include-prompts` phải là lựa chọn rõ ràng.

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| Telemetry nằm trên đường tới hạn làm hook chậm | Ghi sau khi đã trả kết quả; nuốt mọi lỗi; đo tác động vào p95 |
| Log phình to theo thời gian | Giới hạn kích thước dòng, xoay file, retention mặc định 30 ngày |
| Ghi đồng thời từ nhiều hook làm hỏng dòng | Append dòng ngắn là atomic trên POSIX; test Windows; dòng hỏng bị reader bỏ qua |
| Dashboard vô tình chứa nội dung nhạy cảm | Prompt tắt mặc định; rà kỹ phần "top candidate" vì tên skill có thể lộ tên dự án |
| Correlation `capability-used` sai do sessionId trùng | Ghép theo cả sessionId và cửa sổ thời gian; ghi `unobserved` khi không chắc |
| Người dùng không tin công cụ vì sợ thu thập dữ liệu | Không phone-home, tài liệu nói rõ, telemetry tắt được, có test khẳng định không có network call ngoài TypeSafe |

## Security Considerations

- Không ghi `TYPESAFE_API_KEY` hay bất kỳ env value nào vào log, kể cả khi lỗi.
- Không ghi prompt đầy đủ mặc định; chỉ hash và độ dài. `--include-prompts` phải cảnh báo rõ.
- Log nằm trong thư mục state của user với quyền chỉ user đọc.
- Report HTML tự chứa nhưng vẫn có thể chứa tên skill nội bộ — tài liệu phải cảnh báo trước khi chia sẻ.
- Có test khẳng định chỉ có đúng một loại network call ra ngoài: tới `api.typesafe.ai`.
- Redact đường dẫn tuyệt đối trong report vì chúng lộ username và cấu trúc thư mục.

## Next Steps

Phase 7 sinh dữ liệu cho phần 5 và 6 của dashboard. Phase 8 viết `docs/measurement.md` thành nội dung
landing page. v0.1 đã phát hành ở phase 5 nên telemetry xuất hiện từ v0.2 — README phải được cập nhật ở
phase 8 để phản ánh điều đó.
