---
phase: 1
title: "Foundation và Catalog Scanner"
status: pending
priority: P1
effort: "2d"
dependencies: []
---

# Phase 1: Foundation và Catalog Scanner

## Context Links

- Plan: [plan.md](./plan.md)
- Brainstorm: `../reports/brainstorm-260917-1623-skillful-capability-router.md`
- Bằng chứng catalog trên máy dev: brainstorm §6.2

## Goal

Dựng skeleton repo OSS và lớp quét catalog đọc được cả 4 bề mặt (skills, MCP, agents, commands) từ
4 agent runtime, trả về một catalog đã chuẩn hoá và có fingerprint ổn định.

## Key Insights

Catalog thật trên máy dev đã được probe và xác nhận: 125 skill ở `~/.claude/skills`, 109 skill ở
`~/.pi/agent/skills`, `~/.agents/skills` cho Codex, `~/.claude.json` giữ 2 MCP global cộng
`projects.<cwd>.mcpServers` cho 288 project, `~/.codex/config.toml` có `[mcp_servers]`,
`~/.omp/agent/mcp.json` có 2 server. Con số này là môi trường thật, không phải giả định.

Ba đường dẫn chưa xác minh và phải probe trong phase này: **Pi lấy MCP từ đâu** (`settings.json`
không có key `mcp`; MCP do extension/package quản lý), **OMP có cần bật extension tường minh trong
`config.yml`** hay không, và **Codex đọc hook từ `~/.codex/hooks.json` hay `[hooks.*]` trong
`config.toml`** (cả hai tồn tại). Hai câu đầu thuộc phase này, câu thứ ba thuộc phase 4.

**Phát hiện ở Verification Pass: hai runtime không chạy được.** `omp` là symlink hỏng tại
`~/.bun/bin/omp` trỏ tới `@oh-my-pi/pi-coding-agent` không còn tồn tại, và `codex` không có binary dù
`~/.codex/config.toml` (17KB) cùng `hooks.json` vẫn còn. Validation Session 1 đã chốt: **cài lại cả
hai trước phase 4** để hook installer được verify trên 4/4 runtime thay vì viết theo doc. Catalog scanner
vẫn phát triển được cho cả 4 runtime vì config của cả 4 đều tồn tại, nhưng probe extension OMP cần
binary thật.

Catalog phải chịu được môi trường bẩn: đường dẫn không tồn tại, `SKILL.md` thiếu frontmatter,
symlink vòng, file không đọc được. Một mục hỏng không được làm sập cả lần quét.

## Requirements

Chức năng:

- Quét 4 bề mặt × 2 scope (global + project) cho 4 runtime, chịu lỗi từng mục.
- Chuẩn hoá về `{id, kind, name, description, source, runtime, scope}` với `kind` ∈
  `skill | mcp | agent | command | rule`.
- Tính `catalogFingerprint` ổn định: cùng nội dung catalog cho cùng fingerprint, khác nội dung thì
  khác. Dùng cho cache key.
- Lệnh `skillful catalog --json` in catalog đầy đủ; `--kind` và `--runtime` để lọc.

Phi chức năng:

- Quét toàn bộ catalog dưới 300ms trên máy có ~250 mục.
- Không đọc thân file skill. Chỉ đọc frontmatter `name` + `description` và metadata cần thiết.
- Không resolve symlink ra ngoài thư mục gốc của catalog.
- Chịu được tên skill trùng giữa các runtime (giữ cả hai, phân biệt bằng `runtime`).

## Architecture

```text
packages/core/src/catalog/
  types.ts              # CatalogEntry, CatalogKind, CatalogScope
  scan.ts               # điều phối: gọi từng source, gộp, khử trùng theo (runtime,kind,path)
  fingerprint.ts        # sha256 trên tập (kind,name,description) đã sort
  frontmatter.ts        # parse YAML frontmatter tối thiểu, chịu lỗi
  toml.ts               # wrapper parse TOML cho Codex config
  sources/
    claude-code.ts
    codex.ts
    pi.ts
    omp.ts
  project-scope.ts      # resolve project root cho scope=project (từ cwd)
```

Mỗi source export một hàm `scan(ctx): Promise<CatalogEntry[]>`. `ctx` mang `homeDir`, `cwd`,
`env`. Không source nào tự đọc `process.env` trực tiếp — để test bơm được `homeDir` giả.

### Đường dẫn đã xác minh

| Runtime | Kind | Đường dẫn |
|---|---|---|
| claude-code | skill | `~/.claude/skills/*/SKILL.md`, `<proj>/.claude/skills/*/SKILL.md` |
| claude-code | mcp | `~/.claude.json` → `mcpServers` + `projects[<proj>].mcpServers`, `<proj>/.mcp.json` |
| claude-code | agent | `~/.claude/agents/*.md`, `<proj>/.claude/agents/*.md` |
| claude-code | command | `~/.claude/commands/**/*.md`, `<proj>/.claude/commands/**/*.md` |
| codex | skill | `$AGENTKIT_CODEX_SKILLS_ROOT` nếu có, ngược lại `~/.agents/skills/*/SKILL.md`, `<proj>/.agents/skills` |
| codex | mcp | `~/.codex/config.toml` → `[mcp_servers.*]`, `<proj>/.codex/config.toml` |
| codex | agent | `~/.codex/agents/*.toml`, `<proj>/.codex/agents/*.toml` |
| pi | skill | `~/.pi/agent/skills/*/SKILL.md`, `<proj>/.pi/skills/*/SKILL.md` |
| pi | agent | `~/.pi/agent/agents/*.md`, `<proj>/.pi/agents/*.md` |
| omp | skill | `~/.omp/agent/skills/*/SKILL.md`, `~/.omp/agent/managed-skills/*/SKILL.md`, `<proj>/.omp/skills` |
| omp | mcp | `~/.omp/agent/mcp.json` → `mcpServers` |
| omp | agent | `~/.omp/agent/agents/*.md` |
| omp | rule | `<proj>/.omp/rules/*.md` |

## Files to Create / Modify

- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `LICENSE`, `.gitignore`
- Create: `vitest.config.ts`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/core/src/catalog/**` (theo cây ở trên)
- Create: `packages/core/src/__tests__/catalog/*.test.ts`
- Create: `packages/core/src/__tests__/fixtures/homes/*` (home giả cho từng runtime)
- Create: `packages/cli/package.json`, `packages/cli/src/index.ts`, `packages/cli/src/commands/catalog.ts`
- Create: `docs/architecture.md`

## Implementation Steps

1. **Cài/khôi phục binary `codex` và `omp`.** Trạng thái đã probe: `omp` là symlink hỏng, `codex`
   không có binary. Cài lại cả hai, xác nhận `--help` chạy được, ghi version vào
   `docs/architecture.md`. Đây là điều kiện để probe extension OMP ở bước 8 và để phase 4 verify hook
   trên 4/4 runtime.
2. Khởi tạo pnpm workspace với `packages/core` và `packages/cli`. TypeScript strict, ESM, Node ≥20.
   Thêm `biome` cho lint/format và `vitest` cho test.
3. Viết `catalog/types.ts` và `catalog/frontmatter.ts`. Frontmatter parser chỉ cần bắt `name` và
   `description` từ khối `---` đầu file; mọi lỗi parse trả entry với `description: ""` và đánh dấu
   `degraded: true` thay vì throw.
4. Viết `sources/claude-code.ts`. Đây là source giàu nhất (4 kind), làm mẫu cho các source còn lại.
5. Viết `sources/codex.ts` kèm `catalog/toml.ts`. Parse `[mcp_servers]` lấy key làm tên, `command`
   hoặc `url` làm mô tả ngắn.
6. Viết `sources/pi.ts` và `sources/omp.ts`.
7. **Probe Pi MCP surface**: chạy một session Pi có MCP, rồi tìm file config thực tế được đọc
   (kiểm tra `~/.pi/agent/extensions`, `packages` trong `settings.json`, và thư mục package đã cài).
   Ghi kết quả vào `docs/architecture.md`. Nếu không tìm thấy surface ổn định, source pi trả rỗng cho
   kind `mcp` và ghi chú rõ thay vì đoán.
8. **Probe OMP extension/MCP enablement**: xác nhận extension ở `~/.omp/agent/extensions/` có được
   auto-discover không, hay cần khai báo trong `config.yml`. Ghi kết quả vào `docs/architecture.md`.
9. Viết `scan.ts` gộp kết quả, khử trùng theo `(runtime, kind, resolvedPath)`, sort theo `kind` rồi
   `name` để fingerprint ổn định.
10. Viết `fingerprint.ts`: sha256 trên chuỗi nối của `kind:name:description` đã sort. Test rằng thêm
    một skill đổi fingerprint, và đổi thứ tự file không đổi fingerprint.
11. Viết CLI `skillful catalog` với `--json`, `--kind`, `--runtime`.
12. **Đo Node cold start**: `time npx skillful catalog --json` và `time node dist/index.js catalog --json`.
    Ghi số vào `docs/architecture.md`. Nếu cold start > 400ms thì ghi nhận làm rủi ro cho phase 4 và
    đề xuất đường binary/cache.

## Verification

```bash
# Bước 1: xác nhận 4 runtime chạy được
for b in claude codex omp pi; do "$b" --help >/dev/null 2>&1 && echo "$b OK" || echo "$b MISSING"; done

pnpm install
pnpm -r typecheck
pnpm -r test                        # unit test với home giả
node packages/cli/dist/index.js catalog --json | jq 'length'
node packages/cli/dist/index.js catalog --kind skill --runtime claude-code | jq 'length'
time node packages/cli/dist/index.js catalog --json
```

Kỳ vọng trên máy dev: catalog trả về hơn 230 mục, trong đó hơn 125 skill cho claude-code và hơn 109
skill cho pi. Quét dưới 300ms (không tính cold start).

## Todo

- [ ] Cài/khôi phục binary `codex` và `omp`, xác nhận `--help` + ghi version
- [ ] Khởi tạo pnpm workspace, TS strict, biome, vitest
- [ ] `catalog/types.ts` + `frontmatter.ts` chịu lỗi
- [ ] `sources/claude-code.ts` (4 kind)
- [ ] `catalog/toml.ts` + `sources/codex.ts`
- [ ] `sources/pi.ts`
- [ ] `sources/omp.ts`
- [ ] Probe Pi MCP surface, ghi vào `docs/architecture.md`
- [ ] Probe OMP extension/MCP enablement, ghi vào `docs/architecture.md`
- [ ] `scan.ts` + khử trùng + sort ổn định
- [ ] `fingerprint.ts` + test bất biến thứ tự
- [ ] CLI `skillful catalog`
- [ ] Đo Node cold start, ghi số
- [ ] Fixture home giả cho cả 4 runtime + test

## Success Criteria

- `skillful catalog` trả catalog đúng cho cả 4 runtime trên máy thật.
- Cả 4 runtime chạy được `--help`; `codex` và `omp` đã được cài/khôi phục và version đã được ghi lại.
- Thêm/xoá một skill đổi `catalogFingerprint`; đổi thứ tự file thì không.
- Một `SKILL.md` hỏng không làm lần quét thất bại; entry đó được đánh dấu `degraded`.
- Symlink trỏ ra ngoài thư mục catalog bị bỏ qua.
- Quét < 300ms, có số đo cold start được ghi lại.
- Hai câu hỏi chưa xác minh về Pi MCP và OMP enablement đã có câu trả lời bằng thực nghiệm, ghi trong `docs/architecture.md`.

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| Pi MCP surface không ổn định hoặc không có file config | Trả rỗng cho kind `mcp` của pi, ghi chú rõ; không đoán đường dẫn |
| Đường dẫn runtime đổi giữa các bản | Tách theo source; version probe trong test; log cảnh báo khi thư mục gốc không tồn tại |
| Catalog lớn làm chậm mọi prompt | Quét chỉ chạy khi fingerprint cache miss; fingerprint tính từ metadata nhẹ |
| Tên skill trùng giữa runtime | Giữ cả hai, phân biệt bằng `runtime` trong `id` |

## Security Considerations

- Chỉ đọc frontmatter, không đọc thân file skill. Thân skill có thể chứa thông tin nội bộ.
- Không follow symlink ra ngoài thư mục catalog gốc.
- Không log giá trị env. `AGENTKIT_CODEX_SKILLS_ROOT` chỉ được log sự tồn tại, không log giá trị.
- Không ghi gì ra ngoài `~/.local/state/skillful/` (hoặc tương đương theo OS).
- Fixture test dùng home giả, không bao giờ chạm home thật trong test.

## Next Steps

Phase 2 dùng `CatalogEntry[]` từ phase này làm input cho tầng retrieval. `catalogFingerprint` trở
thành một nửa của cache key ở phase 4.
