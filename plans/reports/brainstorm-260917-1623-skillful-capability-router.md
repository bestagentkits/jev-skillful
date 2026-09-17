# Brainstorm — Skillful: per-prompt capability router cho agent runtime

- Date: 2026-09-17
- Project: `/Volumes/GOON/www/oss/jev-skillful` (greenfield, chỉ có `.pi/`)
- Trạng thái: brainstorm đã chốt contract, sẵn sàng handoff sang plan

---

## 1. Outcome

Repo OSS `skillful` phát hành `npx skillful`, tự cài hook cho 4 runtime (Claude Code, Codex, OMP, Pi).
Mỗi prompt được route qua Jev dựa trên catalog skill/MCP/agent/command cài trên máy; kết quả shortlist
được đưa thẳng vào context của agent. Khách AgentKit xác thực bằng `AGENTKIT_API_KEY` sẵn có và **không
cần key TypeSafe**. Landing page công khai tại `skillful.agentkit.best`.

Mục đích kinh doanh: đo mức độ hấp dẫn của tính năng này với tệp khách hàng AgentKit.best.

## 2. Constraints

- **Ngân sách latency cứng 2s** mỗi prompt. Đo thực tế cho thấy đường đi đầy đủ ~0.75s, nên budget này
  thừa margin. **Fail-open**: timeout/lỗi/mất mạng → không chèn gì, không bao giờ chặn agent.
- **Privacy**: chỉ gửi prompt đã truncate + tên/mô tả ngắn của shortlist. Không gửi nội dung file, thân
  skill, hay đường dẫn tuyệt đối (rò rỉ username/cấu trúc thư mục). Bắt buộc có `SKILLFUL_DISABLE=1`,
  `skillful config`, và chế độ local-only.
- **Không phụ thuộc key TypeSafe của người dùng cuối** ở hosted mode; nhưng BYO mode
  (`TYPESAFE_API_KEY`) phải cho kết quả y hệt hosted mode.
- **Cross-platform** macOS/Linux/Windows.
- Tái dùng hạ tầng đã kiểm chứng thay vì viết lại.
- Phân phối npm-only: CLI tự làm phần detect runtime + ghi hook, không dựa vào kit machinery của AgentKit.

## 3. Non-goals

Không điền argument cho skill, không execute skill, không marketplace/registry skill, không install hay
update skill, không phải LLM gateway đa provider, không bypass licensing AgentKit.

## 4. Acceptance criteria

1. Hook chạy đúng trên cả 4 runtime, chứng minh bằng output thật của từng runtime trên máy sạch.
2. Khi Jev/proxy mất >2s hoặc lỗi → prompt vẫn đi bình thường, agent không thấy lỗi.
3. `AGENTKIT_API_KEY` sai/hết hạn → fail mở, log một dòng hướng dẫn rõ ràng, không rò rỉ key.
4. Trên cùng input, BYO mode và hosted mode cho cùng shortlist.
5. Prompt tầm thường (chitchat, typo, hỏi đáp thường) → không chèn gì.
6. Landing page live trên `skillful.agentkit.best` khi `curl -I`.
7. Eval harness chạy được và báo cáo top-1 accuracy + độ ổn định qua N lần lặp.

## 5. Quyết định đã chốt

| # | Quyết định | Lựa chọn |
|---|---|---|
| 1 | Cách inject | **Hybrid**: hook pre-compute (cache → proxy nếu kịp budget) rồi chèn shortlist đã resolve; quá budget/lỗi → degrade về reminder text kèm lệnh refresh |
| 2 | Nơi đặt proxy | **Worker OSS riêng** tại `skillful.agentkit.best`, verifier cắm rời (`agentkit` / `d1` / `none`) |
| 3 | Phạm vi catalog | **Đầy đủ 4 bề mặt**: skills, MCP servers, agents/subagents, slash commands + rules |
| 4 | Phân phối | **Chỉ OSS npm package**, CLI tự detect runtime và ghi hook |

## 6. Bằng chứng đã xác minh

### 6.1 Hạ tầng đã có sẵn (không cần xây mới)

| Sự kiện | Bằng chứng |
|---|---|
| TypeSafe API: `POST https://api.typesafe.ai/v1/systemone`, Bearer key, body `{state, model, questions}` với `noul`/`choice`/`score` | `docs.typesafe.ai/api.md` |
| `AGENTKIT_API_KEY` tồn tại thật, format `ak_live_<32>`, có `validateApiKey()` + rate limit (default 10000/key) + đếm usage | `agentkit-web/src/lib/api-keys.ts`, `agentkit-auth.ts` |
| agentkit-web đã có proxy tổng quát `/api/proxy/{service}/{path}`: bearer auth → allowlist → tự inject secret upstream từ env → forward body, có timeout + giới hạn 10MB | `agentkit-web/src/lib/proxy/service-config.ts`, `proxy-handler.ts` |
| Claude Code **và** Codex đều hỗ trợ hook `UserPromptSubmit`; inject context qua stdout JSON `hookSpecificOutput.additionalContext` — pattern đã dùng và đã test | `kits/core/hooks/hooks.json`, `simplify-gate.cjs`; `agentkit/adapters/codex/doc.go` + `hook_translator.go` |
| Pi **và** OMP cùng hệ extension: event `input` (transform) + `before_agent_start` (inject message, đọc được `event.prompt`) | pi `docs/extensions.md` |
| Extension auto-discover từ `~/.pi/agent/extensions/*/index.ts` và `~/.omp/agent/extensions/*.ts`; cũng nhận `packages` trong `settings.json` | pi `docs/extensions.md`; probe local |

### 6.2 Catalog có thật trên máy dev

| Bề mặt | Đường dẫn | Số lượng quan sát |
|---|---|---|
| Skills (Claude Code) | `~/.claude/skills` | 125 |
| Skills (Pi) | `~/.pi/agent/skills` | 109 |
| Skills (Codex) | `~/.agents/skills` | có |
| Skills (OMP) | `~/.omp/agent/managed-skills`, `~/.omp/skills` | có |
| MCP (Claude Code) | `~/.claude.json` → `mcpServers` (2 global) + `projects.<path>.mcpServers` (288 project) + `.mcp.json` | 2 global |
| MCP (Codex) | `~/.codex/config.toml` → `[mcp_servers]` | có |
| MCP (OMP) | `~/.omp/agent/mcp.json` → `mcpServers` | 2 |
| Agents | `~/.claude/agents`, `~/.codex/agents/*.toml`, `~/.omp/agent/agents`, `~/.pi/agent/agents` | có |
| Pi MCP | không nằm trong `settings.json`; do extension/package quản lý | cần probe lúc implement |

### 6.3 Đo thực tế Jev API (đây là phần quan trọng nhất)

Probe live với key của operator, model `jev-latest` (thực tế resolve thành `jev-1.13.0`).

**Latency — không phụ thuộc số candidate:**

| Cấu hình | Latency (3–8 lần gọi) |
|---|---|
| K=5 candidate, 4 câu hỏi | 0.745 – 0.858s |
| K=15 candidate, 2 câu hỏi | 0.686 – 0.762s |

Trong đó ~0.21–0.32s là TCP/TLS connect. Kết luận: latency bị chi phối bởi overhead cố định, không phải
kích thước shortlist. Budget 2s an toàn.

**Độ chính xác routing — `choice` + option `none` tự chặn được nhiễu:**

| Prompt | `choice` | `none_p` | confidence |
|---|---|---|---|
| "refactor the auth middleware to use refresh tokens" | `ak-backend-development` | 0.00 | 1.00 |
| "fix the typo in README line 12" | `none` | 0.62 / 0.65 | 0.59 / 0.62 |
| "what does this function do?" | `none` | 0.54 / 0.52 | 0.49 / 0.47 |
| "thanks!" | `none` | 1.00 | 1.00 |

**Câu `noul` làm gate thì vô dụng và phản tác dụng:**

| Prompt | `noul` gate trả về |
|---|---|
| "refactor the auth middleware..." (rõ ràng cần capability) | 0.39 / 0.37 |
| "fix the typo..." | 0.10 |
| "thanks!" | 0.10 |

Gate noul cho 0.39 cho đúng cái case mà `choice` đã chọn đúng với confidence 1.0. Hai primitive không
đồng thuận, và `noul` là bên sai nhiều hơn.

**Độ ổn định:** lặp lại cùng input cho `none_p` lệch ~±0.03 (0.62→0.65, 0.54→0.52). Ổn định hơn nhiều
so với việc so sánh distribution giữa các option cạnh tranh. Ngưỡng 0.5 tách sạch 4/4 mẫu.

**Chi phí:** 1360 input tokens + ~140 output tokens mỗi route. Theo giá jev-1.12 ($0.042/1M input) là
~$0.00006/prompt, tức ~$0.06 cho 1000 prompt. Chi phí không phải ràng buộc; **rate limit 10000/key mới là**.

## 7. Kiến trúc đã chọn

```text
Prompt của user
  │
  ├─ [1] Hook runtime (Claude Code / Codex / Pi / OMP)
  │      • cache lookup: hash(prompt chuẩn hoá + catalog fingerprint)
  │      • cache hit  → chèn shortlist (<50ms)
  │      • cache miss → gọi proxy trong budget 2s
  │      • timeout    → chèn reminder text "npx skillful"
  │
  ├─ [2] CLI local (code, 0 token)
  │      • scan catalog 4 bề mặt (global + project scope)
  │      • chuẩn hoá → {id, kind, name, description, source, runtime, scope}
  │      • BM25 + quota theo kind → shortlist K≈15 (6 skill / 4 MCP / 3 agent / 2 command)
  │      • heuristic skip: prompt < 3 từ, greeting, input bắt đầu bằng "/"
  │
  ├─ [3] Worker OSS tại skillful.agentkit.best
  │      • verify AGENTKIT_API_KEY qua verifier cắm rời + cache KV 5 phút
  │      • rate limit theo keyPrefix
  │      • dựng 1 request Jev, gọi api.typesafe.ai bằng TYPESAFE_API_KEY (Worker secret)
  │      • trả shortlist đã xếp hạng
  │
  └─ [4] Jev (jev-latest), MỘT request duy nhất
         state   = { task, candidates[] }
         questions = {
           primary: choice(over candidate ids + "none"),   ← quyết định chính
           q_<id>:  noul  (per candidate, để xếp hạng runner-up)
         }
         → code chèn nếu primary != "none"
```

Prompt-building nằm trong một npm package dùng chung giữa CLI và Worker (`@skillful/router-core`), nên
BYO mode cho kết quả y hệt hosted mode.

Verifier interface cho Worker:

| Mode | Cơ chế | Dùng khi |
|---|---|---|
| `agentkit` | Gọi endpoint có sẵn của agentkit.best để xác thực `AGENTKIT_API_KEY`, cache KV 5 phút | Mặc định cho khách AgentKit |
| `d1` | Bind thẳng D1, đọc bảng `apiKeys` | Cùng tài khoản Cloudflare, nhanh nhất |
| `none` | Không verify, ai có URL đều gọi được | Người self-host BYO key |

## 8. Trade-offs

| Cách tiếp cận | Giả định phụ thuộc nhất | Vỡ trước tiên khi |
|---|---|---|
| **Hybrid inject** (đã chọn) | Cache hit đủ thường xuyên để 2s budget không bị chạm | Prompt luôn khác nhau → cache hit ~0 → mỗi prompt đều đi đường 0.75s; vẫn dưới budget nhưng không có lợi ích cache |
| Reminder thuần | Agent tuân lệnh chạy `npx skillful` | Prompt ngắn hoặc agent tự tin xử lý luôn → tốn 1 turn vô ích |
| Resolved injection thuần | Latency Jev luôn ổn định | TypeSafe 429/529 → không có đường degrade, prompt bị chặn |
| **Worker OSS riêng** (đã chọn) | Cloudflare KV đủ nhanh và verify cache đủ tốt | KV latency cao + TTL ngắn → mỗi prompt tốn thêm 1 hop; hoặc bị abuse vì phải tự viết rate limit |
| Thêm service vào proxy agentkit-web | Chấp nhận endpoint không nằm trên domain riêng | Cần sửa repo private cho mỗi thay đổi router, và repo OSS không self-host được |
| Catalog chỉ skills | Skill description đủ giàu để BM25 hoạt động | MCP/agent description nghèo → prefilter bỏ sót candidate đúng trước khi Jev kịp thấy |
| **Catalog đầy đủ 4 bề mặt** (đã chọn) | Quota theo kind đủ để 234 skill không lấn át MCP | Tỉ lệ kind trên máy user lệch mạnh → shortlist mất cân bằng, cần tune quota |

## 9. Better approaches (khác với phương án ban đầu của user)

**9.1 Bỏ hẳn `noul` gate cho quyết định "có cần capability không".**
Đề xuất ban đầu là dùng một câu noul làm cổng chặn nhiễu. Đo thực tế cho thấy noul trả 0.39/0.37 cho
một task cần capability, trong khi `choice` với option `none` chọn đúng với confidence 1.0 và cho
`none_p` = 0.00; đồng thời `none` thắng đúng ở cả 3 prompt tầm thường. Delta vận hành: bớt 1 câu hỏi,
bớt 1 nhánh logic, bớt 1 failure mode. Chi phí chuyển đổi: bằng 0 vì chưa có code.

**9.2 Dùng lại proxy có sẵn của agentkit-web cho phần auth thay vì tự viết từ đầu.**
Nếu chọn hướng đó, thêm service `typesafe` chỉ là ~12 dòng config và thừa hưởng auth + rate limit +
usage counting đã được test. Đã cân nhắc và bị loại vì bạn chọn ưu tiên repo OSS tự chứa, nhưng đây vẫn
là **đường lui rẻ nhất** nếu việc tự viết rate limit cho Worker phình ra.

## 10. Rủi ro và câu hỏi chưa giải quyết

1. **BLOCKER PHÁP LÝ — điều khoản TypeSafe chưa cho phép rõ ràng mô hình proxy.**
   `typesafe.ai/legal/terms` mục 3(a) cấp license "solely for your **personal use**", "**non-transferable,
   non-sublicensable**", và 3(b)(vi) cấm "use the Site to develop new products and services without
   TypeSafe's express written permission". Mục 13(d) nói còn "Additional Terms" cho API service.
   Mô hình một key phục vụ nhiều khách hàng không có TypeSafe account **không được cho phép rõ ràng**.
   Cần: xin xác nhận bằng văn bản từ TypeSafe trước khi launch hosted proxy. BYO mode không bị ảnh hưởng.
   Lưu ý tích cực: TypeSafe có tài liệu `patterns/intent-routing.md` — đúng pattern này — nên use case
   được ủng hộ; câu hỏi nằm ở mô hình thương mại, không phải kỹ thuật.

2. **4 mẫu chưa phải là eval.** Ngưỡng `none_p < 0.5` tách sạch 4/4 nhưng không đủ để tin. Cần eval
   harness với fixture (prompt → capability mong đợi) chạy N lần để đo top-1 accuracy và độ ổn định
   trước khi chốt ngưỡng.

3. **Codex đọc hook từ file nào.** Cả `~/.codex/hooks.json` (standalone) và `[hooks.<event>]` trong
   `~/.codex/config.toml` đều tồn tại; AgentKit viết cả hai. Phải probe bằng một lần chạy codex thật.

4. **Rate limit 10000/key có bị tiêu hao bởi bước verify không.** Nếu verify đi qua endpoint
   entitlements của agentkit.best thì mỗi prompt tăng `usageCount`. TTL cache 5 phút giảm ảnh hưởng
   nhưng vẫn cần một đường verify rẻ hơn, hoặc chấp nhận và ghi nhận.

5. **OMP có cần bật extension tường minh trong `config.yml` không.** AgentKit ghi chú "extensions remain
   user-owned and explicitly loaded via config" — chưa xác minh với OMP thật.

6. **Pi MCP surface.** `~/.pi/agent/settings.json` không có key `mcp`; MCP do extension/package quản lý.
   Cần probe để biết scan ở đâu.

7. **Node cold start ~150–250ms ăn 10–25% budget.** Cần đo `npx skillful` thực tế; nếu quá chậm phải
   chuyển sang binary nhẹ hoặc bỏ cache-on-disk để tránh npx resolve.

8. **Quyền truy cập Cloudflare account + DNS cho `skillful.agentkit.best`** chưa xác nhận.

## 11. Handoff

Bước tiếp theo: `/ak:plan` cho repo `jev-skillful`, tạo `plans/260917-1623-skillful-capability-router/`.

Phasing đề xuất cho plan (theo thứ tự giảm dần rủi ro, để phần đắt nhất được validate sớm):

1. **Spike eval + đo lường trước**: fixture routing + đo accuracy/stability + đo latency `npx skillful`
   thật. Đây là thứ quyết định toàn bộ phần còn lại có đáng làm hay không.
2. Catalog scanner + BM25 shortlist cho 4 bề mặt (thuần local, test được không cần network).
3. `router-core` package: dựng request Jev + xếp hạng kết quả, chạy được ở cả BYO và hosted mode.
4. Worker OSS + verifier interface + landing page; deploy `skillful.agentkit.best`.
5. Hook/extension adapter cho từng runtime + `skillful install` (detect + ghi hook, idempotent).
6. Eval hoá ngưỡng, tài liệu, npm publish.
