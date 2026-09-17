/**
 * Focused reader for MCP server declarations in Codex's `config.toml`.
 *
 * This is intentionally not a general TOML parser. It extracts only the
 * `[mcp_servers.<name>]` tables and the handful of keys the catalog needs, which
 * keeps the dependency surface at zero and avoids failing on the many TOML
 * features Codex config files otherwise use.
 *
 * Known limitations, all of which degrade to "no entry for that server" rather
 * than a wrong entry:
 *
 * - Only `[mcp_servers.<name>]` tables are read, not `[[mcp_servers]]` arrays.
 * - Only `command`, `args`, and `url` are read.
 * - Inline tables and string escapes are handled only for the quoting forms
 *   Codex writes.
 */

export interface TomlMcpServer {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
}

const SECTION_PATTERN = /^\[([^\]]+)\]\s*$/;
const KEY_PATTERN = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/;

/** Extract every MCP server declared under `[mcp_servers.*]`. */
export function parseMcpServersFromToml(text: string): TomlMcpServer[] {
  const servers: TomlMcpServer[] = [];
  const byName = new Map<string, TomlMcpServer>();
  let current: TomlMcpServer | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === "") continue;

    const section = SECTION_PATTERN.exec(line);
    if (section) {
      current = null;
      const header = section[1];
      if (header === undefined) continue;
      const name = mcpServerName(header);
      if (name !== null) {
        current = { name };
        // A later table with the same name wins, matching TOML merge semantics
        // closely enough for discovery purposes.
        byName.set(name, current);
        servers.push(current);
      }
      continue;
    }

    if (current === null) continue;

    const match = KEY_PATTERN.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = (match[2] ?? "").trim();
    if (key === undefined) continue;

    if (key === "command") {
      const value = asString(rawValue);
      if (value !== null) current.command = value;
    } else if (key === "url") {
      const value = asString(rawValue);
      if (value !== null) current.url = value;
    } else if (key === "args") {
      const value = asStringArray(rawValue);
      if (value !== null) current.args = value;
    }
  }

  // Drop servers that ended up with no usable detail at all.
  return servers.filter((server) => server.command !== undefined || server.url !== undefined);
}

/**
 * Return the server name for a `[mcp_servers.<name>]` header, or null when the
 * header is not an MCP server table.
 */
function mcpServerName(header: string): string | null {
  const parts = splitDottedKey(header);
  if (parts.length !== 2) return null;
  if (parts[0] !== "mcp_servers") return null;
  const name = parts[1];
  if (name === undefined || name === "") return null;
  return name;
}

/** Split a TOML dotted key, respecting quoted segments. */
function splitDottedKey(header: string): string[] {
  const parts: string[] = [];
  let buffer = "";
  let quote: string | null = null;

  for (let i = 0; i < header.length; i += 1) {
    const char = header[i];
    if (char === undefined) continue;
    if (quote !== null) {
      if (char === quote) {
        quote = null;
        continue;
      }
      buffer += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ".") {
      parts.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += char;
  }
  parts.push(buffer.trim());
  return parts.filter((part) => part !== "");
}

/** Remove a trailing comment that is not inside a quoted string. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === undefined) continue;
    if (quote !== null) {
      if (char === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, i);
  }
  return line;
}

function asString(value: string): string | null {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return null;
}

function asStringArray(value: string): string[] | null {
  if (!(value.startsWith("[") && value.endsWith("]"))) return null;
  const inner = value.slice(1, -1);
  const out: string[] = [];
  let quote: string | null = null;
  let buffer = "";

  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char === undefined) continue;
    if (quote !== null) {
      if (char === quote) {
        out.push(buffer);
        buffer = "";
        quote = null;
        continue;
      }
      buffer += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
  }
  return out;
}
