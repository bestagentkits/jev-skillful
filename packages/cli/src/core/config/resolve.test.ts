import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "../router/thresholds.js";
import { DEFAULT_QUOTA_GROUPS } from "../retrieval/shortlist.js";
import { defaultConfigPath, resolveConfig } from "./resolve.js";

const HOME = "/home/tester";
const CONFIG_PATH = "/home/tester/.config/skillful/config.json";

/** Resolve config with a file that exists and contains `body`. */
function withFile(body: unknown, extra: Parameters<typeof resolveConfig>[0] = {}) {
  return resolveConfig({
    homeDir: HOME,
    env: {},
    readFile: () => JSON.stringify(body),
    ...extra,
  });
}

/** Resolve config with no file on disk. */
function withoutFile(extra: Parameters<typeof resolveConfig>[0] = {}) {
  return resolveConfig({
    homeDir: HOME,
    env: {},
    readFile: () => {
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    ...extra,
  });
}

describe("resolveConfig", () => {
  it("uses defaults when nothing is configured anywhere", () => {
    const resolved = withoutFile();

    expect(resolved.config.model).toBe("jev-latest");
    expect(resolved.config.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(resolved.config.quotaGroups).toEqual(DEFAULT_QUOTA_GROUPS);
    expect(resolved.config.uploadPrompt).toBe(true);
    expect(resolved.warnings).toEqual([]);
    expect(resolved.sources["budgetMs"]).toBe("default");
  });

  it("derives the config path from the home directory", () => {
    expect(defaultConfigPath("/home/x")).toBe("/home/x/.config/skillful/config.json");
  });

  it("lets the environment override a default", () => {
    const resolved = withoutFile({ env: { SKILLFUL_BUDGET_MS: "5000" } });

    expect(resolved.config.thresholds.budgetMs).toBe(5000);
    expect(resolved.sources["budgetMs"]).toBe("env");
  });

  it("lets the config file override a default", () => {
    const resolved = withFile({ thresholds: { budgetMs: 3000 } });

    expect(resolved.config.thresholds.budgetMs).toBe(3000);
    expect(resolved.sources["budgetMs"]).toBe("file");
  });

  it("lets the environment win over the config file", () => {
    const resolved = withFile(
      { thresholds: { budgetMs: 3000 } },
      { env: { SKILLFUL_BUDGET_MS: "7000" } },
    );

    expect(resolved.config.thresholds.budgetMs).toBe(7000);
    expect(resolved.sources["budgetMs"]).toBe("env");
  });

  it("lets a CLI flag win over everything", () => {
    const resolved = withFile(
      { thresholds: { budgetMs: 3000 } },
      { env: { SKILLFUL_BUDGET_MS: "7000" }, cli: { thresholds: { budgetMs: 900 } } },
    );

    expect(resolved.config.thresholds.budgetMs).toBe(900);
    expect(resolved.sources["budgetMs"]).toBe("cli");
  });

  it("ignores a non-numeric environment value instead of producing NaN", () => {
    const resolved = withoutFile({ env: { SKILLFUL_BUDGET_MS: "soon" } });

    expect(resolved.config.thresholds.budgetMs).toBe(DEFAULT_THRESHOLDS.budgetMs);
    expect(resolved.sources["budgetMs"]).toBe("default");
  });

  it("resolves the model through all four sources", () => {
    expect(withoutFile().config.model).toBe("jev-latest");
    expect(withoutFile({ env: { SKILLFUL_MODEL: "from-env" } }).config.model).toBe("from-env");
    expect(withFile({ model: "from-file" }).config.model).toBe("from-file");
    expect(withFile({ model: "from-file" }, { cli: { model: "from-cli" } }).config.model).toBe("from-cli");
  });

  it("resolves a boolean setting from an environment string", () => {
    expect(withoutFile({ env: { SKILLFUL_UPLOAD_PROMPT: "false" } }).config.uploadPrompt).toBe(false);
    expect(withoutFile({ env: { SKILLFUL_UPLOAD_PROMPT: "0" } }).config.uploadPrompt).toBe(false);
    expect(withoutFile({ env: { SKILLFUL_UPLOAD_PROMPT: "nonsense" } }).config.uploadPrompt).toBe(true);
  });

  it("survives a malformed config file with a warning rather than throwing", () => {
    const resolved = resolveConfig({
      homeDir: HOME,
      env: {},
      readFile: () => "{ this is not json",
    });

    expect(resolved.config.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(resolved.warnings.join(" ")).toContain("unreadable");
  });

  it("survives a config file whose top level is an array", () => {
    const resolved = resolveConfig({ homeDir: HOME, env: {}, readFile: () => "[1,2,3]" });

    expect(resolved.config.model).toBe("jev-latest");
    expect(resolved.warnings.join(" ")).toContain("not an object");
  });

  it("refuses to read a credential from the config file", () => {
    const resolved = withFile({ apiKey: "sk-should-not-be-here", thresholds: { budgetMs: 2500 } });

    // The rest of the file still applies, but the key is rejected loudly.
    expect(resolved.config.thresholds.budgetMs).toBe(2500);
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain("apiKey");
    expect(resolved.warnings[0]).toContain("leaked");
    expect(JSON.stringify(resolved.config)).not.toContain("sk-should-not-be-here");
  });

  it("warns about a malformed quotaGroups entry and keeps the defaults", () => {
    const resolved = withFile({ quotaGroups: [{ kinds: "skill", limit: 3 }] });

    expect(resolved.config.quotaGroups).toEqual(DEFAULT_QUOTA_GROUPS);
    expect(resolved.warnings.join(" ")).toContain("quotaGroups");
  });

  it("accepts a valid quotaGroups override", () => {
    const resolved = withFile({ quotaGroups: [{ kinds: ["skill"], limit: 2 }] });

    expect(resolved.config.quotaGroups).toEqual([{ kinds: ["skill"], limit: 2 }]);
  });

  it("repairs a non-positive budget instead of shipping a broken value", () => {
    const resolved = withFile({ thresholds: { budgetMs: -5 } });

    expect(resolved.config.thresholds.budgetMs).toBe(DEFAULT_THRESHOLDS.budgetMs);
    expect(resolved.warnings.join(" ")).toContain("budgetMs");
  });

  it("reports the config path it consulted even when absent", () => {
    expect(withoutFile().configPath).toBe(CONFIG_PATH);
  });
});
