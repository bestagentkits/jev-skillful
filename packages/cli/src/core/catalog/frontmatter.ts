/**
 * Minimal YAML frontmatter reader.
 *
 * Every supported runtime describes a skill with a `SKILL.md` whose frontmatter
 * carries `name` and `description`. Those are the only fields the router needs,
 * so this parser deliberately understands far less than YAML: a leading `---`
 * block of `key: value` pairs, optional quoting, and optional block scalars.
 *
 * Anything it cannot understand becomes `degraded: true` rather than an error,
 * because one malformed skill must not fail a whole catalog scan.
 */

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  /**
   * Routing-intent text, present on 203 of 230 skills measured on the development machine.
   *
   * This field exists for exactly the decision the router makes — `Invoke when the user wants
   * honest advice, a second opinion, requirement reframing` — and ignoring it cost measurable
   * recall: adding it moved `recall@K` from 0.765 to 0.804 on the development fixtures and from
   * 0.500 to 0.600 on the holdout set.
   */
  whenToUse?: string;
  /** True when the block was missing, unterminated, or yielded no usable name. */
  degraded: boolean;
}

const KEY_PATTERN = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

/**
 * Parse the leading frontmatter block of a markdown document.
 *
 * `name`, `description` and `when_to_use` are extracted; all other keys are ignored.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const content = stripBom(text);
  const lines = content.split(/\r?\n/);

  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    if (line.trim() === "---") start = i;
    break;
  }
  // No frontmatter block at all: the document has no usable metadata.
  if (start === -1) return { degraded: true };

  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed === "---" || trimmed === "...") {
      end = i;
      break;
    }
  }
  // Block was opened but never closed.
  if (end === -1) return { degraded: true };

  const result: Record<string, string> = {};
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const match = KEY_PATTERN.exec(trimmed);
    if (!match) continue;
    const key = match[1];
    if (key === undefined) continue;
    const rawValue = (match[2] ?? "").trim();

    if (rawValue === ">" || rawValue === "|" || rawValue === ">-" || rawValue === "|-") {
      const folded = rawValue.startsWith(">");
      const collected: string[] = [];
      let cursor = i + 1;
      while (cursor < end) {
        const next = lines[cursor] ?? "";
        const nextTrimmed = next.trim();
        const isIndented = /^\s+\S/.test(next);
        if (nextTrimmed !== "" && !isIndented) break;
        collected.push(nextTrimmed);
        cursor += 1;
      }
      i = cursor - 1;
      result[key] = collected.join(folded ? " " : "\n").trim();
      continue;
    }

    result[key] = unquote(rawValue);
  }

  const parsed: ParsedFrontmatter = { degraded: result.name === undefined };
  if (result.name !== undefined) parsed.name = result.name;
  if (result.description !== undefined) parsed.description = result.description;
  const whenToUse = result["when_to_use"] ?? result["whenToUse"];
  if (whenToUse !== undefined && whenToUse.length > 0) parsed.whenToUse = whenToUse;
  return parsed;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
