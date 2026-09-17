---
phase: 8
title: "Release v0.2"
status: pending
priority: P2
effort: "2d"
dependencies: [7]
---

# Phase 8: Release v0.2

## Context Links

- Plan: [plan.md](./plan.md)
- Phase 7: [A/B Outcome Benchmark trên repo OSS thật](./phase-07-ab-outcome-benchmark.md) — nguồn số liệu
- Phase 5: [Release v0.1](./phase-05-release-v0-1.md) — hạ tầng đã có sẵn
- Phương pháp đo lường: `reports/research-measurement-methodology.md`
- Kết quả benchmark: `reports/bench-outcome.md` + `bench-outcome.json`
- Paper nền tảng: arXiv:2604.24594

## Goal

Bổ sung **tầng đo lường** vào sản phẩm đã phát hành ở v0.1: tài liệu đo lường, nội dung landing page về
kết quả benchmark, và vòng lặp cộng đồng biến case route sai thành fixture — rồi phát hành v0.2.0 với
kết luận trung thực khớp đúng số liệu.

## Key Insights

**v0.1 đã phát hành ở phase 5, nên phase này không lặp lại phần hạ tầng.** npm, CI (3 workflow), branch
protection, repo public, cổng eval, landing page shell, `export-case`, và issue templates cơ bản đã có.
Việc của phase này chỉ là **tầng đo lường**: docs telemetry + measurement, nội dung landing page về kết
quả, và vòng lặp cộng đồng dựa trên fixture thật.

**Kết luận của phase 7 quyết định nội dung v0.2, và không được nói quá.** Ba mức:

| Mức từ `bench-outcome.json` | README và landing page được nói gì |
|---|---|
| `proven` (RAE > 0, CI 95% không chứa 0) | Được nói "đã chứng minh bằng số liệu", kèm RAE, CI, cỡ mẫu, liên kết report |
| `not-proven` (CI chứa 0) | Phải nói "chưa chứng minh được". **Không** được nói "giúp agent tốt hơn" |
| `harmful` (RAE < 0) | Phải nói rõ inject làm hại trên tập này; điều tra trước khi quảng bá bất cứ điều gì |

Đây là ràng buộc cứng. Hứa hẹn vượt quá số liệu sẽ phá hỏng đúng thứ đáng giá nhất của dự án, vì cả
giá trị của nó nằm ở chỗ đo lường trung thực.

**Vòng lặp cộng đồng là cơ chế cải tiến, không phải tính năng phụ.** Người dùng gặp route sai chạy
`skillful export-case` rồi mở issue; case đó thành fixture; fixture chạy qua `skillful eval`; PR sửa
prompt chứng minh được cải thiện qua cổng eval. Không có vòng lặp này thì chất lượng router đứng yên.
Tài liệu phải mô tả vòng lặp đó thành một quy trình, không phải một lời mời chung chung.

**Phần số liệu trên landing page phải sinh từ report, không chép tay.** Chép tay bảo đảm sẽ lệch khỏi
thực tế ở lần chạy benchmark tiếp theo.

**Phải nói rõ giới hạn của kết luận.** Kết quả đo trên một tập task repo OSS cụ thể, với một catalog
cụ thể, trên một máy cụ thể — không phải một định luật phổ quát. Cách đúng: nêu cỡ mẫu, MDE, và mời
người dùng tự chạy `skillful bench` trên môi trường của họ.

## Requirements

Chức năng:

- `docs/telemetry.md`: schema sự kiện, quyền riêng tư, cách tắt, cách đọc log.
- `docs/measurement.md`: ba tầng đo lường, định nghĩa RAE, cách đọc dashboard, cách tự chạy benchmark.
- Cập nhật `README.md`: thêm phần "kết quả đo lường" với mức kết luận khớp `bench-outcome.json`.
- Cập nhật `site/index.html`: liên kết tới trang đo lường; nêu mức kết luận trung thực.
- Tạo `site/measurement.html`: trình bày kết quả dạng đọc được, có bảng 4 ô, cỡ mẫu, CI, MDE, kết luận.
- Cập nhật `docs/routing.md` với ngưỡng và quota cuối cùng sau khi tune.
- Thêm issue template "đề xuất capability" và tài liệu hoá vòng lặp case → fixture → PR.
- `skillful export-case` bổ sung `--emit-fixture` để xuất thẳng định dạng fixture dùng được, giúp vòng
  lặp cộng đồng ngắn hơn.
- Phát hành v0.2.0 với CHANGELOG và provenance.

Phi chức năng:

- Phần số liệu trên landing page sinh từ `bench-outcome.json`, không chép tay.
- README nêu rõ cỡ mẫu, MDE, và giới hạn của kết luận.
- `docs/` không vượt quá giới hạn độ dài file của repo; tách trang khi cần.
- Cú pháp chạy benchmark của người dùng được mô tả trong `docs/measurement.md` phải thực sự chạy được.

## Architecture

```text
docs/
  telemetry.md         # MỚI: schema, quyền riêng tư, cách tắt
  measurement.md       # MỚI: ba tầng, RAE, đọc dashboard, tự chạy bench
  routing.md           # CẬP NHẬT: ngưỡng và quota cuối cùng
  architecture.md      # CẬP NHẬT: kết quả probe Codex hook, Pi MCP, OMP extension
  install.md           # có từ v0.1
  troubleshooting.md   # cập nhật thêm mục telemetry/dashboard
site/
  index.html           # CẬP NHẬT: liên kết measurement, nêu mức kết luận
  measurement.html     # MỚI: kết quả benchmark
  assets/              # số liệu JSON dùng để render, sinh từ report
.github/
  ISSUE_TEMPLATE/capability-suggestion.yml   # MỚI
```

### Vòng lặp cộng đồng

```text
Người dùng gặp route sai
  → skillful export-case <hash> --emit-fixture
  → mở issue bằng template bad-route
  → maintainer thêm fixture vào bench/fixtures/
  → skillful eval --replay  (chứng minh case hiện đang sai)
  → sửa prompt / ngưỡng / quota
  → skillful eval          (chứng minh đã tốt hơn)
  → PR với bảng so sánh; cổng eval trong CI xác nhận
```

Tài liệu hoá vòng lặp này trong `CONTRIBUTING.md` và `docs/measurement.md`.

## Files to Create / Modify

- Create: `docs/telemetry.md`, `docs/measurement.md`
- Create: `site/measurement.html`, `site/assets/bench-outcome.json`
- Create: `.github/ISSUE_TEMPLATE/capability-suggestion.yml`
- Modify: `README.md` — thêm phần kết quả đo lường khớp mức kết luận
- Modify: `site/index.html` — liên kết measurement, nêu mức kết luận
- Modify: `docs/routing.md` — ngưỡng và quota cuối cùng
- Modify: `docs/architecture.md` — kết quả probe còn lại
- Modify: `docs/troubleshooting.md` — mục telemetry và dashboard
- Modify: `CONTRIBUTING.md` — vòng lặp case → fixture → PR
- Modify: `packages/cli/src/commands/export-case.ts` — thêm `--emit-fixture`
- Modify: `packages/cli/package.json` + `CHANGELOG.md` — v0.2.0

## Implementation Steps

1. Viết `docs/telemetry.md`: schema hai loại sự kiện, vị trí file theo OS, cách tắt, và điều gì **không**
   được ghi (không key, không prompt đầy đủ mặc định, không đường dẫn tuyệt đối).
2. Viết `docs/measurement.md`: giải thích ba tầng, định nghĩa RAE kèm lý do vì sao so sánh trung bình
   thông thường sai (dẫn arXiv:2609.00549), cách đọc từng phần dashboard, và **cách tự chạy benchmark
   trên môi trường của người dùng** kèm lệnh cụ thể.
3. Thêm `--emit-fixture` vào `export-case.ts`: xuất một dòng JSONL đúng định dạng fixture để maintainer
   thêm thẳng vào `bench/fixtures/`. Có test khẳng định output không chứa key hay đường dẫn tuyệt đối.
4. Cập nhật `CONTRIBUTING.md`: mô tả vòng lặp case → fixture → eval → PR thành các bước cụ thể, kèm
   lệnh cho từng bước.
5. Cập nhật `docs/routing.md` với ngưỡng và quota cuối cùng từ phase 3, và kết quả sweep.
6. Cập nhật `docs/architecture.md` với ba kết quả probe (Codex hook file, Pi MCP surface, OMP extension
   enablement) đã thu được ở phase 1 và phase 4.
7. Tạo `site/assets/bench-outcome.json` bằng cách copy từ `reports/bench-outcome.json`, sau khi đã rà
   loại bỏ mọi đường dẫn tuyệt đối và thông tin nội bộ.
8. Viết `site/measurement.html`: đọc `assets/bench-outcome.json`, render bảng 4 ô, cỡ mẫu, RAE, CI, MDE,
   và kết luận. Nêu rõ mức kết luận và giới hạn.
9. Cập nhật `site/index.html`: thêm liên kết tới trang đo lường, và một câu nêu mức kết luận. **Câu này
   phải khớp mức trong `bench-outcome.json`** — nếu là `not-proven` thì không được viết như đã chứng minh.
10. Cập nhật `README.md`: thêm phần "kết quả đo lường" với mức kết luận, cỡ mẫu, MDE, liên kết report,
    và câu mời người dùng tự chạy `skillful bench`.
11. Thêm issue template `capability-suggestion.yml`.
12. Cập nhật `docs/troubleshooting.md` với các vấn đề telemetry và dashboard.
13. Rà toàn bộ `docs/` và `site/` để chắc chắn không nội dung nào nói quá so với `bench-outcome.json`.
14. Cập nhật `CHANGELOG.md`, bump lên v0.2.0, chạy `npm publish --dry-run`.
15. Phát hành v0.2.0. Xác nhận `curl -I https://skillful.agentkit.best` và trang measurement tải được.

## Verification

```bash
pnpm -r typecheck && pnpm -r lint && pnpm -r test
node packages/cli/dist/index.js export-case <hash> --emit-fixture   # kiểm định dạng + redact
node packages/cli/dist/index.js eval --replay --repeat 5 --json | jq '.aggregate'
jq '.conclusion' plans/260917-0942-skillful-capability-router/reports/bench-outcome.json
npm publish --dry-run -w packages/cli
curl -sI https://skillful.agentkit.best | head -1
curl -sI https://skillful.agentkit.best/measurement.html | head -1
# Kiểm tra README khớp mức kết luận:
grep -i "chưa chứng minh\|đã chứng minh\|làm hại" README.md
```

Cổng release v0.2: mọi tài liệu và trang web nêu đúng mức kết luận trong `bench-outcome.json`; phần số
liệu được render từ file chứ không chép tay; `docs/measurement.md` chứa lệnh chạy benchmark đã được
kiểm là chạy được.

## Todo

- [ ] `docs/telemetry.md` (schema, quyền riêng tư, cách tắt, điều không được ghi)
- [ ] `docs/measurement.md` (ba tầng, RAE, đọc dashboard, tự chạy bench)
- [ ] `export-case --emit-fixture` + test redact
- [ ] `CONTRIBUTING.md` với vòng lặp case → fixture → PR
- [ ] `docs/routing.md` cập nhật ngưỡng và quota cuối cùng
- [ ] `docs/architecture.md` cập nhật 3 kết quả probe
- [ ] `site/assets/bench-outcome.json` đã rà redact
- [ ] `site/measurement.html` render từ JSON
- [ ] `site/index.html` nêu đúng mức kết luận
- [ ] `README.md` phần kết quả đo lường khớp mức kết luận
- [ ] Issue template `capability-suggestion.yml`
- [ ] `docs/troubleshooting.md` mục telemetry + dashboard
- [ ] Rà toàn bộ docs + site không nói quá số liệu
- [ ] `CHANGELOG.md` + bump v0.2.0 + npm dry-run
- [ ] Phát hành v0.2.0 + verify domain và trang measurement

## Success Criteria

- `bench-outcome.json` tồn tại và có trường `conclusion` với một trong ba mức.
- Mọi tài liệu và trang web nêu đúng mức kết luận; không có chỗ nào nói quá số liệu.
- Phần số liệu trên landing page render từ `site/assets/bench-outcome.json`, không chép tay.
- `docs/measurement.md` chứa lệnh chạy benchmark cho người dùng, và lệnh đó đã được kiểm là chạy được.
- `skillful export-case --emit-fixture` xuất đúng định dạng fixture và không chứa key hay đường dẫn
  tuyệt đối.
- `curl -sI https://skillful.agentkit.best` và `/measurement.html` đều trả 200.
- `docs/telemetry.md` nói rõ ba điều: không phone-home, telemetry tắt được, và chỉ có một loại network
  call ra ngoài là tới `api.typesafe.ai`.
- v0.2.0 trên npm với provenance và CHANGELOG.

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| README hoặc landing page nói quá so với kết quả | Bước 13 là một lần rà riêng; câu kết luận trên `index.html` và README phải khớp trường `conclusion`; kiểm bằng `grep` trong verification |
| Số liệu trên landing page lệch sau lần chạy benchmark sau | Render từ `assets/bench-outcome.json`; ghi rõ ngày chạy và cỡ mẫu |
| Vòng lặp cộng đồng chỉ là lời mời chung chung, không ai dùng | `--emit-fixture` làm bước gửi case ngắn nhất có thể; template tài liệu hoá từng bước và lệnh cụ thể |
| Kết luận `harmful` gây khó xử khi phát hành | Đây là kết quả hợp lệ: nói rõ inject làm hại trên tập nào, giới hạn ra sao, và điều tra là bước tiếp theo — không che |
| Đưa thông tin nội bộ vào file JSON publish | Rà redact trước khi copy vào `site/assets/`; có test cho `export-case` |
| KiBài benchmark quá lớn để người dùng tự chạy | Ghi rõ trong `docs/measurement.md` cách chạy một suite con với `--task` và `--limit` |

## Security Considerations

- `site/assets/bench-outcome.json` phải qua bước rà: không đường dẫn tuyệt đối, không username, không
  env value, không tên capability riêng của khách hàng.
- `export-case --emit-fixture` dùng cùng cơ chế redact như `export-case` hiện có; test khẳng định.
- `docs/telemetry.md` phải nói rõ người dùng tự kiểm chứng bằng cách ngắt mạng, và cách xoá log.
- Không đưa prompt thật của người dùng vào fixture khi chưa có sự đồng ý; template issue phải nhắc điều
  này.
- Landing page vẫn không tracking bên thứ ba, giữ nguyên từ v0.1.

## Next Steps

Sau v0.2, vòng lặp cải tiến là quy trình đã tài liệu hoá: case thật → fixture → `skillful eval` chứng
minh → PR. Chất lượng router tiếp tục tăng theo số fixture được đóng góp, và mỗi lần chạy lại benchmark
cho một điểm dữ liệu mới. Nếu kết luận là `not-proven` hoặc `harmful`, bước tiếp theo là điều tra bằng
`analysis/taxonomy.ts` trên các task bị hại trước khi mở rộng suite.
