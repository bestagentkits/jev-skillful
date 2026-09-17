---
phase: 5
title: "Release v0.1"
status: pending
priority: P1
effort: "2d"
dependencies: [4]
---

# Phase 5: Release v0.1

## Context Links

- Plan: [plan.md](./plan.md)
- Phase 4: [Runtime Hooks và Install](./phase-04-runtime-hooks-and-install.md)
- Phase 3: [Eval Harness và Tune Ngưỡng](./phase-03-eval-harness-and-thresholds.md) — cổng chất lượng
- Paper nền tảng: arXiv:2604.24594

## Goal

Phát hành `skillful` v0.1 công khai ngay khi hook đã verify trên cả 4 runtime: repo OSS, package trên
npm, CI gác chất lượng router, docs đủ để người ngoài cài và đóng góp, landing page tại
`skillful.agentkit.best`.

## Key Insights

**Mục đích của việc phát hành sớm là thu fixture thật.** Chất lượng router phụ thuộc vào bộ fixture, và
bộ fixture tốt nhất đến từ những prompt thật mà router đã route sai. Phát hành sau phase 4 — khi hook
đã chạy ổn nhưng chưa có benchmark — nghĩa là cộng đồng bắt đầu dùng và báo case sai sớm, đúng lúc
phase 7 cần dữ liệu.

**Luận cứ gốc đến từ một paper nên README phải trích dẫn.** arXiv:2604.24594 ghi nhận rằng liệt kê hết
skill trong context window không scale: context bị ăn nhanh và agent trở nên kém chính xác hơn khi
chọn skill. Đây là "vì sao" của dự án và phải là đoạn đầu README.

**v0.1 chưa có số liệu đo lường, và README phải nói thẳng điều đó.** Hứa hẹn "giúp agent tốt hơn" khi
chưa có bằng chứng sẽ phá hỏng đúng thứ đáng giá nhất của dự án. Cách đúng: nói rõ "benchmark A/B đang
được xây, xem phase tiếp theo; trong lúc đó bạn tự đo bằng `skillful eval`".

**Cổng eval phải chạy được trên PR từ fork, nghĩa là không được cần secret.** Đây là điều kiện để
`eval --replay` trở thành hạ tầng cộng đồng thay vì công cụ nội bộ.

## Requirements

Chức năng:

- `LICENSE` (MIT), `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.
- `docs/`: architecture, install, routing, troubleshooting.
- CI chạy typecheck, lint, unit test, và `skillful eval --replay` như một cổng.
- Cổng eval chặn PR chạm `packages/core/src/router/**`, `shortlist.ts`, hoặc `thresholds.ts` nếu không
  kèm số đo không tệ hơn baseline.
- `skillful export-case <prompt-hash>` xuất một case đã redact để người dùng mở issue.
- Issue templates: bad route, install problem.
- Phát hành npm v0.1.0 với provenance.
- Repo GitHub public với topics, description, branch protection trên `main`.
- Landing page tĩnh tại `skillful.agentkit.best`: giới thiệu, cài một dòng, liên kết GitHub và docs.

Phi chức năng:

- `npx skillful` chạy trên thư mục sạch không cần bước thủ công nào.
- Cổng eval chạy được trên PR từ fork mà không cần secret nào.
- README nói rõ: BYO `TYPESAFE_API_KEY`, không server, không phone-home, và benchmark chưa có.
- Landing page không tracking bên thứ ba, không tài nguyên từ CDN ngoài.

## Architecture

```text
docs/
  architecture.md      # catalog, router, hook; kết quả probe đường dẫn 4 runtime
  install.md           # cài/gỡ/doctor cho 4 runtime; cảnh báo extension chạy full quyền
  routing.md           # thiết kế câu hỏi Jev, ngưỡng, quota, cách chỉnh
  troubleshooting.md   # fail-open, degrade, cache hỏng, hook xung đột
site/
  index.html           # landing page v0.1
.github/
  workflows/ci.yml
  workflows/eval-gate.yml
  workflows/release.yml
  ISSUE_TEMPLATE/bad-route.yml
  ISSUE_TEMPLATE/install-problem.yml
  ISSUE_TEMPLATE/config.yml
  pull_request_template.md
packages/cli/src/commands/export-case.ts
```

### Cổng eval trong CI

`eval-gate.yml` chạy khi PR chạm `packages/core/src/router/**`,
`packages/core/src/retrieval/shortlist.ts`, hoặc `packages/core/src/config/thresholds.ts`:

1. Chạy `skillful eval --replay --repeat 5 --json` trên base branch → `before.json`.
2. Chạy cùng lệnh trên PR head → `after.json`.
3. So sánh; fail nếu bất kỳ chỉ số nào tụt dưới ngưỡng cổng của phase 3.
4. In bảng so sánh vào PR comment.

`--replay` dùng response Jev đã ghi lại nên không cần key — đây là điều kiện để job chạy được trên PR
từ fork.

## Files to Create / Modify

- Create: `LICENSE`, `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`
- Create: `docs/architecture.md`, `install.md`, `routing.md`, `troubleshooting.md`
- Create: `.github/workflows/ci.yml`, `eval-gate.yml`, `release.yml`
- Create: `.github/ISSUE_TEMPLATE/bad-route.yml`, `install-problem.yml`, `config.yml`
- Create: `.github/pull_request_template.md`
- Create: `site/index.html`
- Create: `packages/cli/src/commands/export-case.ts`
- Modify: `packages/cli/package.json` — metadata publish, `files`, `bin`, repository, license
- Modify: `packages/core/src/__tests__/fixtures/jev-replay/*` — bổ sung đủ phủ cho cổng eval

## Implementation Steps

1. Viết `LICENSE` MIT và các file cộng đồng.
2. Viết `README.md`: vấn đề kèm trích dẫn arXiv:2604.24594 → cài một dòng → BYO key → bằng chứng hiện
   có (số đo eval từ phase 3, không phải số đo A/B) → nói rõ benchmark đang xây → liên kết docs.
3. Viết `CONTRIBUTING.md`. Nhấn mạnh quy trình: đổi prompt/ngưỡng phải kèm số đo `skillful eval`.
4. Viết `SECURITY.md`: extension chạy với quyền đầy đủ của user; prompt đã truncate được gửi tới
   TypeSafe; telemetry không rời khỏi máy; cách báo lỗ hổng.
5. Hợp nhất `docs/` từ nội dung đã tích lũy ở phase 1 (kết quả probe) và phase 2 (thiết kế routing).
   Xoá ghi chú tạm. Giữ mỗi trang dưới giới hạn độ dài của repo.
6. Viết `export-case.ts` với redact đường dẫn tuyệt đối, mọi env value, key, và token. Thêm test khẳng
   định không có key hay đường dẫn tuyệt đối trong output.
7. Bổ sung fixture `--replay` để cổng eval có đủ phủ và có ý nghĩa. Kiểm tra suite chạy trong CI sạch
   không có `TYPESAFE_API_KEY`.
8. Viết 3 workflow. `eval-gate.yml` phải không tham chiếu secret nào.
9. **Kiểm chứng cổng eval thật**: tạo một PR thử cố tình hạ chất lượng prompt (ví dụ đổi criteria của
   `none` thành chuỗi vô nghĩa). Xác nhận job fail và in bảng so sánh. Revert.
10. Viết issue templates. `bad-route.yml` hướng người dùng chạy `skillful export-case` trước khi mở.
11. Viết `site/index.html` tĩnh. Nội dung: vấn đề, cách giải, cài một dòng, liên kết docs và GitHub.
    Không tracking, không font từ CDN ngoài.
12. Deploy `site/` lên Cloudflare Pages, gắn domain `skillful.agentkit.best`, xác nhận bằng `curl -I`.
13. Cấu hình npm publish với provenance, thêm changesets, chạy `npm publish --dry-run`.
14. Tạo repo GitHub public, thêm topics, description, branch protection cho `main`.
15. **Kiểm tra không có secret trong lịch sử git** trước khi chuyển repo sang public.
16. Chạy `npx skillful` trong một thư mục sạch để xác nhận đường cài đặt từ đầu hoạt động.
17. Phát hành v0.1.0.

## Verification

```bash
pnpm -r typecheck && pnpm -r lint && pnpm -r test
node packages/cli/dist/index.js eval --replay --repeat 5 --json | jq '.aggregate'
node packages/cli/dist/index.js export-case <hash>          # kiểm tra redact
npm publish --dry-run -w packages/cli
curl -I https://skillful.agentkit.best
gh repo view <org>/skillful --json visibility,repositoryTopics
```

Cổng release v0.1: tất cả chỉ số eval trên tập holdout đạt ngưỡng phase 3; cổng CI fail khi thử phá
hoạch prompt; `curl -I` trả 200; `npx skillful` chạy trên thư mục sạch.

## Todo

- [ ] `LICENSE` MIT + `CODE_OF_CONDUCT.md` + `CHANGELOG.md`
- [ ] `README.md` trích dẫn paper, nói rõ chưa có số đo A/B
- [ ] `CONTRIBUTING.md` với quy trình eval-gated
- [ ] `SECURITY.md`
- [ ] Hợp nhất `docs/` (architecture, install, routing, troubleshooting)
- [ ] `export-case.ts` + test redact
- [ ] Bổ sung fixture `--replay` đủ phủ cho cổng
- [ ] `.github/workflows/ci.yml`
- [ ] `.github/workflows/eval-gate.yml` không cần secret
- [ ] `.github/workflows/release.yml`
- [ ] Kiểm chứng cổng eval fail trên PR phá hoạch, rồi revert
- [ ] Issue templates + PR template
- [ ] `site/index.html`
- [ ] Deploy Cloudflare Pages + domain `skillful.agentkit.best`
- [ ] npm metadata + provenance + changesets + dry-run
- [ ] Tạo repo GitHub public + topics + branch protection
- [ ] Kiểm tra không có secret trong lịch sử git
- [ ] Verify `npx skillful` trên thư mục sạch
- [ ] Phát hành v0.1.0

## Success Criteria

- `npx skillful` chạy trên thư mục sạch không cần bước thủ công nào.
- Cổng eval thất bại khi cố tình hạ chất lượng prompt (đã kiểm chứng), và chạy được trên PR từ fork mà
  không cần secret.
- `curl -I https://skillful.agentkit.best` trả 200.
- `skillful export-case` không xuất key, token, hay đường dẫn tuyệt đối.
- README trích dẫn paper nền tảng, nói rõ BYO key và không phone-home, và nói rõ benchmark A/B chưa có.
- v0.1.0 có mặt trên npm với provenance.
- Repo công khai, `main` được bảo vệ, và lịch sử git đã được rà không có secret.

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| Phát hành rồi mới phát hiện hook ghi đè cấu hình người dùng | Install/uninstall đã có test round-trip ở phase 4; thêm bước verify trên thư mục sạch |
| Cổng eval cần secret nên không chạy được trên PR từ fork | `--replay` không cần key; test bằng một PR từ fork thật ở bước 9 |
| README hứa hẹn quá mức so với bằng chứng hiện có | Phần bằng chứng chỉ dùng số đo eval; nói rõ A/B chưa có |
| Người dùng lo ngại quyền riêng tư | Nói rõ BYO key và local-only; thêm test khẳng định chỉ có một loại network call |
| Tên `skillful` bị chiếm trên npm | Kiểm tra trước; nếu bị chiếm thì dùng scope `@skillful/cli` và cập nhật README |
| Secret lọt vào lịch sử git của repo public | Quét lịch sử trước khi chuyển sang public; dùng `gitleaks` hoặc tương đương |

## Security Considerations

- `skillful export-case` phải redact đường dẫn tuyệt đối (lộ username), mọi env value, key, và token.
  Có test khẳng định.
- npm publish bật provenance để người dùng xác minh nguồn gốc.
- Branch protection trên `main`; workflow từ fork không có quyền ghi vào repo.
- `SECURITY.md` nói rõ ba điều: extension chạy full quyền user; prompt đã truncate được gửi tới
  TypeSafe; log nằm trên máy và không rời đi.
- Quét secret trong lịch sử git trước khi public.

## Next Steps

v0.1 phát hành xong thì cộng đồng bắt đầu gửi case route sai. Phase 6 (telemetry + dashboard) và phase
7 (benchmark trên repo OSS thật) dùng chính những case đó để mở rộng fixture.
