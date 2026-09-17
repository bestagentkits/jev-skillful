# Research — Phương pháp đo lường hiệu quả của skill routing

Ngày: 2026-09-17. Nguồn: hai paper arXiv, đọc abstract + thiết kế thực nghiệm trực tiếp.

## 1. Vì sao cách đo "hiển nhiên" lại sai

Paper **Skill Following: Evaluating Actual Skill Use in Retrieval-Enabled LLM Agents**
(arXiv:2609.00549, Cho & Park, 09/2026) chỉ ra đúng cái bẫy mà thiết kế đo lường ngây thơ sẽ
sập vào:

> "Aggregate metrics often compare retrieved versus non-retrieved tasks, introducing severe
> selection bias and failing to isolate the true effect of skill use."

Cách làm sai: chạy một tập task, tách thành "task có retrieval" và "task không retrieval", rồi
so hai trung bình. Cách này **không đo được tác dụng thật** vì hai nhóm task khác nhau về bản
chất — task khó/thuộc domain lạ mới kích hoạt retrieval.

Phát hiện gây sốc của paper, đo trên 17 LLM ở domain coding và toán:

> "models frequently show positive aggregate retrieval lift but negative RAE. On MBPP+, multiple
> models that appear to benefit system-wide actually harm their own performance on the exact
> tasks where retrieval occurred."

Tức là: **có những model trông như được lợi trên tổng thể, nhưng lại bị hại chính ở những task
mà việc retrieval xảy ra.** Con số tổng hợp tạo ra "ảo giác về năng lực dùng công cụ".

### Metric đúng: RAE

Paper định nghĩa **RAE (Retrieval-Invoked Actual-Use Effect)**:

> "RAE computes the same-task outcome difference between matched skill-enabled and
> skill-disabled executions, conditioned exclusively on tasks where the agent actively
> retrieved a skill."

Ba đặc tính bắt buộc, phải sao chép chính xác:

1. **Same-task** — mỗi task chạy ở cả hai nhánh, không so hai tập task khác nhau.
2. **Matched** — hai lần chạy giống nhau mọi thứ trừ việc inject.
3. **Conditioned on invoked only** — chỉ tính trên subset task mà việc inject thực sự xảy ra.

Hệ quả cho Skillful: báo cáo phải có **cả hai** con số — RAE (trung thực) và aggregate lift
(để đối chiếu), kèm bảng per-task cho thấy cả 4 ô: cả hai cùng đúng, cả hai cùng sai, chỉ
treatment đúng, chỉ control đúng. Chính bảng 4 ô này là bằng chứng thuyết phục nhất, không phải
một con số trung bình.

## 2. Vì sao premise của Skillful đúng, và bẫy nào phải tránh

Paper **Skill Retrieval Augmentation for Agentic AI** (arXiv:2604.24594, Su et al., 06/2026)
xác nhận vấn đề mà Skillful giải:

> "the dominant strategy for incorporating skills is to explicitly enumerate available skills
> within the context window. However, this strategy fails to scale: as skill corpora expand,
> context budgets are consumed rapidly, and the agent becomes markedly less accurate in
> identifying the right skill."

Đây là luận cứ gốc cho cả dự án: không thể nhồi hết skill vào context. Trên máy dev đã có 125
skill (Claude Code) + 109 skill (Pi) + MCP + agents — và skill corpora của một team thực tế còn
lớn hơn nhiều.

### Bẫy trực tiếp cho thiết kế inject

Nếu Skillful inject nguyên shortlist K=15 candidate vào mỗi prompt thì **đang tái tạo đúng cái
anti-pattern mà paper phê phán**. K=15 là kích thước mà *Jev* nhìn thấy, không phải kích thước
được *inject*.

⇒ Quy tắc thiết kế: **inject tối đa 1 primary + 2 runner-up**. Shortlist lớn là chi tiết nội bộ
của tầng routing, không được rò ra context của agent.

### Bẫy về corpus benchmark

SRA-Bench xây dựng corpus gồm **5,400 test instance + 636 gold skill**, rồi **trộn thêm
distractor skill thu thập từ web** để thành corpus 26,262 skill. Distractor là bắt buộc: nếu bộ
fixture chỉ có gold skill thì BM25 prefilter sẽ dễ một cách giả tạo và kết quả không nói lên gì
về môi trường thật.

### Phát hiện về "khi nào cần load"

> "current LLM agents tend to load skills at similar rates, regardless of whether a gold skill
> is retrieved or whether the task actually requires external capabilities... the bottleneck in
> skill augmentation lies not only in retrieval but also in the base model's ability to determine
> which skill to load and when external loading is actually needed."

Đây chính là điểm mà `choice` + option `none` của Skillful nhắm vào: quyết định **có cần load
hay không**, không chỉ load cái gì. Và nó cũng là lý do phải đo riêng chất lượng quyết định
abstain, tách khỏi chất lượng retrieval.

## 3. Cấu trúc đo lường bắt buộc — 3 tầng tách rời

SRA-Bench chia pipeline thành 3 tầng và đánh giá riêng từng tầng (skill retrieval, skill
incorporation, end-task execution). Skillful phải theo đúng cách chia này, vì mỗi tầng có cách
đo khác nhau và gộp lại sẽ che mất nguyên nhân thất bại:

| Tầng | Câu hỏi | Metric | Chi phí đo | Phase |
|---|---|---|---|---|
| L1 Retrieval | Gold skill có nằm trong shortlist không? | recall@K, MRR, gold-in-shortlist rate | Rẻ, offline, không cần gọi agent | 3 |
| L2 Decision | Router chọn đúng chưa? Có quyết định abstain đúng chưa? | top-1 accuracy, `none` precision/recall/F1, stability qua N lần lặp, p50/p95 latency | Rẻ, offline, cần gọi Jev | 3 |
| L3 Outcome | Inject có làm agent giải task tốt hơn không? | RAE (paired, conditioned), aggregate lift, turns/tool-calls/tokens/wall-clock | Đắt, cần chạy agent thật | 6 |

Điểm mấu chốt: **L1 và L2 là điều kiện cần, không phải bằng chứng.** Router top-1 = 90% vẫn
không chứng minh được agent làm việc tốt hơn, vì paper 1 đã chỉ ra lift tổng hợp có thể dương
trong khi RAE âm. Chỉ L3 mới trả lời được câu hỏi "có giúp agent tốt hơn không".

## 4. Cảnh báo thống kê

Paper 1 dùng **matched pair** (cùng task, hai nhánh) và điều kiện hoá trên invoked subset. Hai
hệ quả thực hành:

- **Cần đủ số task ở invoked subset.** Nếu router abstain ở 70% task thì cỡ mẫu hiệu dụng chỉ
  còn 30% — phải chọn task suite sao cho phần lớn task thực sự kích hoạt inject, hoặc chấp nhận
  chạy nhiều task hơn.
- **Phải chạy nhiều lần lặp.** Jev không tất định (đo được: `none_p` lệch ±0.03 khi lặp cùng
  input; ghi chú cũ hơn cho thấy distribution giữa các option cạnh tranh lệch tới 53/47 → 61/39).
  Một lần chạy không phân biệt được tín hiệu với nhiễu.
- **Phải báo cáo khoảng tin cậy và cỡ mẫu**, và phải báo cáo cả trường hợp thất bại. Một báo cáo
  chỉ có delta dương mà không có số task, không có CI, và không có ô "injection làm hại" thì
  không đáng tin — và đúng là kiểu báo cáo mà paper 1 cảnh báo.

## 5. Ứng dụng vào thiết kế cụ thể

1. **Telemetry local ghi đủ để tính RAE về sau.** Mỗi lần route phải log: prompt hash, shortlist,
   choice, `noneP`, confidence, decision, lý do, latency, cache hit, tokens. Không có log này thì
   không thể tái dựng phân tích.
2. **Ghi nhận "acceptance"** — agent có thực sự dùng capability được gợi ý không. Đây là biến
   trung gian quan trọng: inject đúng nhưng agent bỏ qua thì L3 sẽ âm, và dashboard phải phân biệt
   được hai nguyên nhân "router sai" và "agent bỏ qua".
3. **Fixture phải có distractor**, không chỉ gold. Lấy chính catalog thật trên máy làm distractor
   là cách rẻ nhất và sát thực tế nhất.
4. **Bảng 4 ô per-task là deliverable hạng nhất** của dashboard, không phải phụ lục.
5. **Tune ngưỡng `noneP` trên fixture, không tune trên cảm giác.** Bằng chứng hiện có (4 mẫu:
   0.00 / 0.62 / 0.54 / 1.00) tách sạch ở ngưỡng 0.5 nhưng 4 mẫu không phải eval.

## 6. Nguồn

- Cho & Park, *Skill Following: Evaluating Actual Skill Use in Retrieval-Enabled LLM Agents*,
  arXiv:2609.00549 — https://arxiv.org/abs/2609.00549 (định nghĩa RAE, paradox aggregate vs RAE)
- Su et al., *Skill Retrieval Augmentation for Agentic AI*, arXiv:2604.24594 —
  https://arxiv.org/abs/2604.24594 (SRA-Bench, cấu trúc 3 tầng, distractor corpus, phát hiện về
  khi nào cần load skill)
- Haiku riêng của dự án: `plans/reports/brainstorm-260917-1623-skillful-capability-router.md`
  (đo latency Jev thật, độ chính xác `choice` + `none`, điều khoản TypeSafe)
