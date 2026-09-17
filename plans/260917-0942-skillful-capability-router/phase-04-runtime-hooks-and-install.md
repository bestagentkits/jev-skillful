---
phase: 4
title: "Runtime Hooks và Install"
status: pending
priority: P1
effort: "3d"
dependencies: [3]
---

# Phase 4: Runtime Hooks và Install

## Context Links

- Plan: [plan.md](./plan.md)
- Phase 3: [Eval Harness và Tune Ngưỡng](./phase-03-eval-harness-and-thresholds.md) — cổng quyết định phải đạt trước
- Bằng chứng hook của 4 runtime: brainstorm §6.1
- Cấu hình inject đã chọn: plan.md phần Kiến trúc

## Goal

Cài được hook/extension idempotent trên cả 4 runtime, và tại mỗi prompt hook trả về góp ý đã resolve
trong budget 2000ms hoặc degrade về reminder text mà không bao giờ chặn agent.

## Key Insights

Cơ chế inject đã được xác minh cụ thể, không phải suy đoán:

- **Claude Code và Codex** dùng cùng một hợp đồng: hook `UserPromptSubmit`, stdout JSON
  `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`. AgentKit
  đã dùng pattern này ở `kits/core/hooks/simplify-gate.cjs` nên đây là đường đã chạy thật.
- **Pi và OMP** dùng chung hệ extension: event `before_agent_start` inject được message và đọc được
  `event.prompt`. Extension auto-discover từ `~/.{pi,omp}/agent/extensions/*/index.ts`.

Hệ quả quan trọng: chỉ cần **hai** triển khai hook (một script cho Claude Code + Codex, một extension
cho Pi + OMP), không phải bốn.

**Một câu hỏi chưa xác minh, phải probe ở đây:** Codex đọc hook từ `~/.codex/hooks.json` (standalone)
hay từ `[hooks.<event>]` trong `~/.codex/config.toml`. Cả hai tồn tại trên máy dev và AgentKit viết cả
hai. Phải xác định bằng một lần chạy codex thật, không đoán.

**Rủi ro ghi đè:** `~/.claude/settings.json` và `~/.codex/config.toml` là file dùng chung. AgentKit
cũng ghi hook vào đó. Installer phải **merge** và chỉ chạm đúng entry của mình, không được ghi đè
hook của người khác.

**Ngân sách bị chi phối bởi Node cold start.** Đo thực tế ở phase 1 sẽ cho biết `npx` tốn bao nhiêu.
Nếu cold start ăn quá nhiều budget thì hook phải gọi trực tiếp `node <abs-path>` thay vì qua `npx`.

**Cả 4 runtime phải chạy được trước khi bắt đầu.** Verification Pass phát hiện `omp` là symlink hỏng ở
`~/.bun/bin/omp` và `codex` không có binary, dù `~/.codex/config.toml` cùng `hooks.json` vẫn còn.
Validation Session 1 đã chốt cài lại cả hai ở phase 1. Phase này **không được** viết installer theo doc
rồi đánh dấu chưa verify — installer không được test trên runtime đích là đúng loại lỗi gây hư file cấu
hình người dùng.

## Prerequisites

- `claude`, `codex`, `omp`, `pi` đều chạy được `--help` (cài ở phase 1, bước 1).
- Cổng chất lượng của phase 3 đã đạt; nếu chưa thì dừng và sửa prompt trước.

## Requirements

Chức năng:

- `skillful install` phát hiện runtime có trên máy, cài hook cho từng cái, idempotent (chạy hai lần
  không tạo entry trùng).
- `skillful uninstall` gỡ đúng entry của Skillful, để nguyên hook của người khác.
- `skillful doctor` báo cáo: runtime nào đã cài, hook nào đang hoạt động, budget đo được, kết quả
  route thử, trạng thái cache.
- Lệnh `skillful hook` đọc JSON từ stdin, ghi JSON inject ra stdout. Đây là entry point cho Claude
  Code và Codex.
- Extension cho Pi và OMP dùng `before_agent_start`.
- Cache local cho kết quả route, key = hash(prompt chuẩn hoá + catalogFingerprint).
- Degrade: quá budget, lỗi upstream, thiếu key, hoặc config sai → inject reminder text
  `"npx skillful"` và không lỗi.
- Rename/hủy hook khi `skillful install` phát hiện entry cũ của chính mình.

Phi chức năng:

- Ghi file phải atomic (ghi file tạm rồi rename) và có backup trước khi sửa file của runtime.
- Mọi lỗi trong hook bị nuốt và exit 0. Không bao giờ làm prompt thất bại.
- Budget 2000ms được enforce bằng AbortController; có guard tổng.
- Inject tối đa 1 primary + 2 runner-up, không quá 2 dòng văn bản.

## Architecture

```text
packages/cli/src/commands/
  install.ts             # phát hiện runtime + gọi installer
  uninstall.ts
  doctor.ts
  hook.ts                # stdin JSON → stdout JSON inject
packages/core/src/hooks/
  detect.ts              # runtime nào có trên máy (dựa trên thư mục cấu hình thực tế)
  cache.ts               # cache route theo key hash, TTL, ghi atomic
  degrade.ts             # dựng reminder text
  render.ts              # RouteResult → văn bản inject (tối đa 1+2)
  installers/
    claude-code.ts       # merge vào ~/.claude/settings.json
    codex.ts             # hooks.json và/hoặc config.toml (chọn theo probe)
    pi.ts                # ghi ~/.pi/agent/extensions/skillful/index.ts
    omp.ts               # ghi ~/.omp/agent/extensions/skillful/index.ts
  json-merge.ts          # đọc/sửa/ghi JSON giữ nguyên phần còn lại
packages/extension/      # template extension cho Pi và OMP
```

### Định dạng inject

Giữ ngắn. Đây là văn bản đi vào context của agent ở mọi prompt, nên độ dài là chi phí thật:

```text
[skillful] Capability phù hợp: ak-backend-development — backend API, auth, database.
Gợi ý thêm: mcp-postgres. Bỏ qua nếu không liên quan.
```

Degrade:

```text
[skillful] Không resolve được gợi ý capability. Nếu task cần skill/MCP chuyên biệt, chạy: npx skillful
```

### Cache

```text
~/.cache/skillful/routes.json     # { "<key>": { result: RouteResult, ts: number } }
```

`key = sha256(normalizedPrompt + "|" + catalogFingerprint)`. TTL mặc định 15 phút. Chỉ cache quyết
định đã resolve; **không** cache trạng thái degraded (nếu không, một lần TypeSafe sập sẽ đóng băng
hành vi degrade suốt TTL).

Ghi cache phải atomic và chịu được nhiều hook chạy song song. Giới hạn kích thước và dọn entry cũ.

### Hợp đồng hook (Claude Code và Codex)

```text
stdin:  { prompt, session_id, cwd, hook_event_name, ... }
stdout: {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<text>"}}
exit:   0 luôn luôn
```

Khi không có gì để inject: in ra `{}` và exit 0, không in text rỗng.

## Files to Create / Modify

- Create: `packages/cli/src/commands/install.ts`, `uninstall.ts`, `doctor.ts`, `hook.ts`
- Create: `packages/core/src/hooks/detect.ts`, `cache.ts`, `degrade.ts`, `render.ts`, `json-merge.ts`
- Create: `packages/core/src/hooks/installers/claude-code.ts`, `codex.ts`, `pi.ts`, `omp.ts`
- Create: `packages/extension/index.ts` (template, được copy khi cài)
- Create: `packages/core/src/__tests__/hooks/*.test.ts`
- Create: `packages/core/src/__tests__/fixtures/settings/*.json` (settings giả để test merge)
- Modify: `packages/cli/src/index.ts` — đăng ký 4 command mới
- Create: `docs/install.md`
- Modify: `docs/architecture.md` — ghi kết quả probe Codex hook file

## Implementation Steps

1. Viết `detect.ts`: runtime được coi là có mặt nếu thư mục cấu hình tồn tại (`~/.claude`,
   `~/.codex`, `~/.pi/agent`, `~/.omp/agent`). Không dựa vào binary trên PATH vì người dùng có thể
   chạy runtime qua wrapper.
2. Viết `json-merge.ts` + test. Đây là chỗ dễ gây hư hại nhất: phải giữ nguyên mọi key khác, giữ
   nguyên thứ tự khi có thể, và bảo toàn hook của người khác trong cùng mảng.
3. Viết installer cho Claude Code: đọc `~/.claude/settings.json`, backup sang
   `<file>.bak.skillful.<ts>`, chèn entry vào `hooks.UserPromptSubmit` với command là
   `skillful hook` (absolute path tới CLI), idempotent theo một marker nhận dạng được.
4. **Probe Codex hook**: tạo một hook tạm ghi ra file khi chạy `codex exec`. Xác định file nào được
   đọc. Viết installer theo kết quả. Ghi kết luận vào `docs/architecture.md`.
5. Viết `packages/extension/index.ts` cho Pi: `pi.on("before_agent_start", ...)` đọc `event.prompt`,
   gọi route, trả `{ message: { customType: "skillful", content, display: true } }`. Bọc toàn bộ trong
   try/catch; mọi lỗi trả về object rỗng.
6. Viết installer cho Pi và OMP: ghi `index.ts` vào `~/.{pi,omp}/agent/extensions/skillful/`. Kiểm tra
   xem OMP có cần khai báo trong `config.yml` không (kết quả probe từ phase 1); nếu cần thì merge vào
   `config.yml` với cùng nguyên tắc an toàn như JSON.
7. Viết `cache.ts` với ghi atomic, TTL, giới hạn kích thước, và không cache kết quả degraded. Test
   trường hợp hai tiến trình ghi đồng thời.
8. Viết `render.ts` giới hạn cứng 1 primary + 2 runner-up và độ dài văn bản.
9. Viết `hook.ts`: đọc stdin, áp budget, gọi cache rồi route, render, in JSON. Không throw ở bất kỳ
   nhánh nào. Exit 0 luôn.
10. Viết `doctor.ts` báo cáo trạng thái cài đặt và chạy một route thử, in latency đo được.
11. Viết `install.ts` và `uninstall.ts` điều phối 4 installer. In rõ đã làm gì với file nào.
12. Test end-to-end thủ công trên cả 4 runtime: cài, chạy một prompt thật, xác nhận góp ý xuất hiện
    trong context, gỡ, xác nhận không còn dấu vết.
13. **Test fail-open thật**: đặt `TYPESAFE_API_KEY` sai, chạy prompt, xác nhận agent vẫn hoạt động
    bình thường và hook không in lỗi. Đo lại latency khi degrade.

## Verification

```bash
# 0. Xác nhận 4 runtime chạy được trước khi cài hook
for b in claude codex omp pi; do "$b" --help >/dev/null 2>&1 && echo "$b OK" || echo "$b MISSING"; done

pnpm -r test
node packages/cli/dist/index.js install
node packages/cli/dist/index.js doctor
echo '{"prompt":"refactor the auth middleware","session_id":"t1","cwd":"'"$PWD"'"}' | node packages/cli/dist/index.js hook
echo '{"prompt":"thanks!","session_id":"t1","cwd":"'"$PWD"'"}' | node packages/cli/dist/index.js hook
TYPESAFE_API_KEY=invalid node packages/cli/dist/index.js doctor
node packages/cli/dist/index.js uninstall
```

Kỳ vọng: prompt đầu in JSON có `additionalContext`; prompt "thanks!" in `{}`; key sai thì `doctor`
báo degrade mà vẫn exit 0; `uninstall` gỡ sạch và `git diff` trên file cấu hình runtime cho thấy chỉ
entry của Skillful biến mất.

## Todo

- [ ] Xác nhận 4 runtime chạy được `--help` trước khi bắt đầu
- [ ] `detect.ts` (4 runtime)
- [ ] `json-merge.ts` + test bảo toàn hook của người khác
- [ ] Installer Claude Code + backup + marker idempotent
- [ ] Probe Codex hook file bằng chạy thật, ghi vào `docs/architecture.md`
- [ ] Installer Codex theo kết quả probe
- [ ] Extension Pi (`before_agent_start`)
- [ ] Installer Pi
- [ ] Installer OMP + xử lý `config.yml` nếu cần
- [ ] `cache.ts` atomic + TTL + không cache degraded
- [ ] `render.ts` giới hạn 1+2
- [ ] `hook.ts` fail-open tuyệt đối
- [ ] `doctor.ts` có số đo latency
- [ ] `install.ts` / `uninstall.ts`
- [ ] Test end-to-end trên cả 4 runtime
- [ ] Test fail-open với key sai

## Success Criteria

- `skillful install` chạy hai lần liên tiếp không tạo entry trùng trong bất kỳ file cấu hình nào.
- `skillful uninstall` để lại file cấu hình runtime đúng như trước khi cài (kiểm chứng bằng diff, trừ
  entry của Skillful).
- Trên mỗi runtime trong 4 runtime, một prompt thật nhận được góp ý; prompt tầm thường không nhận gì.
  Đây là 4/4 verify bằng chạy thật, không có runtime nào được đánh dấu chưa verify.
- Fail-open: key sai, mạng chết, hoặc router timeout đều không làm prompt thất bại và không in lỗi ra
  terminal của người dùng.
- p95 latency của hook ≤ 1500ms đo trên máy thật, đã trừ cold start.
- File cấu hình runtime luôn được backup trước khi sửa.

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| Không cài được `codex` hoặc `omp` | Chặn ở Prerequisites: phase chỉ bắt đầu khi cả 4 runtime chạy được. Nếu chặn quá lâu thì báo lại để đổi scope, không tự ý viết installer chưa verify |
| Ghi đè hook của AgentKit hoặc người dùng | `json-merge.ts` + test khẳng định mọi key khác được giữ nguyên; uninstall có test round-trip |
| Codex đổi cách đọc hook | Probe ở bước 4; ghi kết quả; nếu không chắc thì cài cả hai đường và ghi chú |
| Node cold start ăn hết budget | Đo ở phase 1; dùng absolute path tới `node` + script thay vì `npx`; gọi song song cache lookup và catalog scan |
| Extension Pi/OMP lỗi làm hỏng session | Bọc try/catch toàn bộ, trả object rỗng, không bao giờ throw |
| Ghi cache hỏng do nhiều hook song song | Ghi atomic (temp + rename), bỏ qua lỗi ghi, cache hỏng thì coi như miss |
| Inject quá dài gây context bloat | Giới hạn cứng 1+2 và độ dài văn bản; đo tác động ở phase 6 |

## Security Considerations

- Backup mọi file cấu hình runtime trước khi sửa, với timestamp trong tên.
- Không ghi key vào cache, không ghi vào log. Cache chỉ chứa `RouteResult`.
- Cache nằm ở `~/.cache/skillful/` với quyền chỉ user đọc được.
- Hook đọc prompt từ stdin và không ghi prompt đầy đủ ra đĩa mặc định.
- Extension chạy với quyền đầy đủ của user — tài liệu phải nói rõ điều này trong `docs/install.md`,
  và code phải giữ bề mặt nhỏ.

## Next Steps

Phase 5 dùng `RouteResult` và cache để sinh telemetry. Phase 6 dùng `SKILLFUL_DISABLE=1` (đã có từ
phase này) làm nhánh control của benchmark.
