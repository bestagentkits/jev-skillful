import { describe, expect, it } from "vitest";
import type { CatalogEntry, CatalogKind } from "../catalog/types.js";
import type { SystemOneResponse } from "../jev/types.js";
import { route } from "./route.js";
import { PRIMARY_QUESTION_ID } from "./questions.js";

const TEST_KEY = "test-key-that-must-never-be-echoed";

function entry(name: string, kind: CatalogKind, description: string): CatalogEntry {
  return {
    id: `pi:${kind}:global:${name}`,
    kind,
    name,
    description,
    runtime: "pi",
    scope: "global",
    sourcePath: `/tmp/${kind}/${name}`,
  };
}

const CATALOG: CatalogEntry[] = [
  entry("ak-backend-development", "skill", "Build backends with Node.js, Python and Go. REST APIs and auth."),
  entry("ak-frontend-development", "skill", "Build React and TypeScript user interfaces."),
  entry("postgres", "mcp", "Query a PostgreSQL database."),
  entry("ak-copywriting", "skill", "Write conversion copy and headlines."),
];

/** Build a response where `choice` wins and every candidate gets a stated `noul`. */
function response(
  choice: string,
  probabilities: Record<string, number>,
  noul: Record<string, number> = {},
  confidence = 1,
): SystemOneResponse {
  const answers: SystemOneResponse["answers"] = {
    [PRIMARY_QUESTION_ID]: { type: "choice", choice, probabilities, confidence },
  };
  Object.entries(noul).forEach(([id, value], index) => {
    answers[`c${index}`] = { type: "noul", noul: value };
  });
  return { model: "jev-latest", answers, usage: { input_tokens: 1200, output_tokens: 90 } };
}

interface StubOptions {
  responses?: (Response | Error)[];
  onRequest?: (url: string, init: RequestInit) => void;
}

/** A fetch stub that returns queued responses and records every call. */
function stubFetch(options: StubOptions = {}): typeof fetch {
  const queue = [...(options.responses ?? [])];
  return (async (url: string | URL, init?: RequestInit) => {
    options.onRequest?.(String(url), init ?? {});
    const next = queue.shift();
    if (next === undefined) throw new Error("stubFetch: no queued response");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const noSleep = async (): Promise<void> => {};

function routeWith(prompt: string, stub: typeof fetch, override = {}) {
  return route(prompt, {
    entries: CATALOG,
    jev: { apiKey: TEST_KEY, fetchImpl: stub, sleepImpl: noSleep, maxRetries: 2 },
    ...override,
  });
}

const BACKEND_PROMPT = "refactor the auth middleware in the backend service";

describe("route — injected branch", () => {
  it("injects the chosen capability", async () => {
    const stub = stubFetch({
      responses: [
        jsonResponse(response("pi:skill:global:ak-backend-development", {
          none: 0,
          "pi:skill:global:ak-backend-development": 0.9,
          "pi:skill:global:ak-frontend-development": 0.1,
        })),
      ],
    });

    const result = await routeWith(BACKEND_PROMPT, stub);

    expect(result.decision.kind).toBe("injected");
    if (result.decision.kind !== "injected") throw new Error("expected injected");
    expect(result.decision.primary.name).toBe("ak-backend-development");
    expect(result.decision.primary.sourcePath).toContain("ak-backend-development");
    expect(result.primary?.noneP).toBe(0);
  });

  it("attaches runner-ups above the threshold and caps them at two", async () => {
    const stub = stubFetch({
      responses: [
        jsonResponse({
          model: "jev-latest",
          answers: {
            [PRIMARY_QUESTION_ID]: {
              type: "choice",
              choice: "pi:skill:global:ak-backend-development",
              probabilities: { none: 0, "pi:skill:global:ak-backend-development": 0.8 },
              confidence: 0.8,
            },
            c0: { type: "noul", noul: 0.95 },
            c1: { type: "noul", noul: 0.7 },
            c2: { type: "noul", noul: 0.65 },
            c3: { type: "noul", noul: 0.2 },
          },
        }),
      ],
    });

    const result = await routeWith(BACKEND_PROMPT, stub);
    if (result.decision.kind !== "injected") throw new Error("expected injected");

    expect(result.decision.runnersUp).toHaveLength(2);
    expect(result.decision.runnersUp.map((r) => r.noul)).toEqual([0.7, 0.65]);
  });

  it("reports token usage and latency", async () => {
    const stub = stubFetch({
      responses: [
        jsonResponse(response("pi:skill:global:ak-backend-development", {
          none: 0,
          "pi:skill:global:ak-backend-development": 0.9,
        })),
      ],
    });

    const result = await routeWith(BACKEND_PROMPT, stub);
    expect(result.tokensIn).toBe(1200);
    expect(result.tokensOut).toBe(90);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.cacheHit).toBe(false);
  });
});

describe("route — skipped branches", () => {
  it("skips a stall prompt without calling the network", async () => {
    let called = false;
    const stub = stubFetch({
      onRequest: () => {
        called = true;
      },
    });

    const result = await routeWith("thanks!", stub);

    expect(result.decision).toEqual({ kind: "skipped", reason: "heuristic", detail: "too-short" });
    expect(called).toBe(false);
  });

  it("skips a slash command", async () => {
    const stub = stubFetch({ onRequest: () => {} });
    const result = await routeWith("/deploy the staging environment now", stub);

    expect(result.decision).toEqual({
      kind: "skipped",
      reason: "heuristic",
      detail: "slash-command",
    });
  });

  it("skips a long-enough stall prompt by content, not length", async () => {
    const stub = stubFetch({ onRequest: () => {} });
    const result = await routeWith("looks good to me", stub);

    expect(result.decision).toEqual({ kind: "skipped", reason: "heuristic", detail: "stall" });
  });

  it("skips when the model chooses none", async () => {
    const stub = stubFetch({
      responses: [
        jsonResponse(response("none", { none: 0.97, "pi:skill:global:ak-backend-development": 0.03 })),
      ],
    });

    const result = await routeWith(BACKEND_PROMPT, stub);
    expect(result.decision).toEqual({ kind: "skipped", reason: "none-won" });
  });

  it("skips when none loses the vote but crosses the threshold", async () => {
    const stub = stubFetch({
      responses: [
        jsonResponse(response("pi:skill:global:ak-backend-development", {
          none: 0.55,
          "pi:skill:global:ak-backend-development": 0.45,
        }, {}, 0.2)),
      ],
    });

    const result = await routeWith(BACKEND_PROMPT, stub);
    expect(result.decision.kind).toBe("skipped");
    if (result.decision.kind !== "skipped") throw new Error("expected skipped");
    expect(result.decision.reason).toBe("none-won");
  });

  it("skips a winner below the winner-probability floor", async () => {
    const stub = stubFetch({
      responses: [
        jsonResponse(response("pi:skill:global:ak-backend-development", {
          none: 0.1,
          "pi:skill:global:ak-backend-development": 0.2,
          "pi:skill:global:ak-frontend-development": 0.2,
          postgres: 0.2,
          "pi:skill:global:ak-copywriting": 0.2,
        }, {}, 0.05)),
      ],
    });

    const result = await routeWith(BACKEND_PROMPT, stub);
    expect(result.decision.kind).toBe("skipped");
    if (result.decision.kind !== "skipped") throw new Error("expected skipped");
    expect(result.decision.reason).toBe("below-threshold");
    // The winning option is still reported so `--explain` can show what nearly won.
    expect(result.primary?.id).toBe("pi:skill:global:ak-backend-development");
  });

  it("injects a winner that clears the floor but not noneThreshold", async () => {
    // The floor is deliberately separate from `noneThreshold`. With sixteen options on the
    // ballot a clearly-best answer routinely carries under half the probability, and treating
    // that as no decision discarded correct picks.
    const stub = stubFetch({
      responses: [
        jsonResponse(response("pi:skill:global:ak-backend-development", {
          none: 0.05,
          "pi:skill:global:ak-backend-development": 0.4,
          "pi:skill:global:ak-frontend-development": 0.3,
          postgres: 0.25,
        }, {}, 0.15)),
      ],
    });

    const result = await routeWith(BACKEND_PROMPT, stub);
    expect(result.decision.kind).toBe("injected");
    if (result.decision.kind !== "injected") throw new Error("expected injected");
    expect(result.decision.primary.name).toBe("ak-backend-development");
  });

  it("skips an empty catalog without calling the network", async () => {
    let called = false;
    const stub = stubFetch({
      onRequest: () => {
        called = true;
      },
    });

    const result = await route(BACKEND_PROMPT, { entries: [], jev: { apiKey: TEST_KEY, fetchImpl: stub } });

    expect(result.decision).toEqual({ kind: "skipped", reason: "empty-shortlist" });
    expect(called).toBe(false);
  });
});

describe("route — degraded branches", () => {
  it("degrades with auth when the key is rejected", async () => {
    const stub = stubFetch({ responses: [jsonResponse({ error: "unauthorized" }, 401)] });
    const result = await routeWith(BACKEND_PROMPT, stub);

    expect(result.decision.kind).toBe("degraded");
    if (result.decision.kind !== "degraded") throw new Error("expected degraded");
    expect(result.decision.reason).toBe("auth");
  });

  it("degrades with config when no key is configured", async () => {
    const stub = stubFetch({ onRequest: () => {} });
    const result = await route(BACKEND_PROMPT, {
      entries: CATALOG,
      jev: { fetchImpl: stub, env: {} },
    });

    expect(result.decision.kind).toBe("degraded");
    if (result.decision.kind !== "degraded") throw new Error("expected degraded");
    expect(result.decision.reason).toBe("config");
  });

  it("degrades with network when fetch rejects", async () => {
    const stub = stubFetch({ responses: [new Error("socket hang up"), new Error("socket hang up"), new Error("socket hang up")] });
    const result = await routeWith(BACKEND_PROMPT, stub);

    expect(result.decision.kind).toBe("degraded");
    if (result.decision.kind !== "degraded") throw new Error("expected degraded");
    expect(result.decision.reason).toBe("network");
  });

  it("degrades with malformed when the body is not JSON", async () => {
    const stub = stubFetch({ responses: [new Response("<html>502</html>", { status: 200 })] });
    const result = await routeWith(BACKEND_PROMPT, stub);

    expect(result.decision.kind).toBe("degraded");
    if (result.decision.kind !== "degraded") throw new Error("expected degraded");
    expect(result.decision.reason).toBe("malformed");
  });

  it("degrades with malformed when the model picks an option it was not offered", async () => {
    const stub = stubFetch({
      responses: [jsonResponse(response("not-a-real-candidate", { none: 0, "not-a-real-candidate": 1 }))],
    });

    const result = await routeWith(BACKEND_PROMPT, stub);
    expect(result.decision.kind).toBe("degraded");
    if (result.decision.kind !== "degraded") throw new Error("expected degraded");
    expect(result.decision.reason).toBe("malformed");
  });

  it("degrades with timeout when the budget expires", async () => {
    const stub = (async (_url: string | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    const result = await routeWith(BACKEND_PROMPT, stub, {
      thresholds: { budgetMs: 300, requestTimeoutMs: 300 },
    });

    expect(result.decision.kind).toBe("degraded");
    if (result.decision.kind !== "degraded") throw new Error("expected degraded");
    expect(result.decision.reason).toBe("timeout");
  });

  it("never throws, whatever the failure", async () => {
    const stub = stubFetch({ responses: [jsonResponse({}, 422)] });
    await expect(routeWith(BACKEND_PROMPT, stub)).resolves.toBeDefined();
  });
});

describe("route — retry behaviour", () => {
  it("retries a 429 and succeeds", async () => {
    let attempts = 0;
    const stub = (async () => {
      attempts += 1;
      if (attempts === 1) return jsonResponse({ error: "rate limited" }, 429);
      return jsonResponse(response("pi:skill:global:ak-backend-development", {
        none: 0,
        "pi:skill:global:ak-backend-development": 0.9,
      }));
    }) as unknown as typeof fetch;

    const result = await routeWith(BACKEND_PROMPT, stub);

    expect(attempts).toBe(2);
    expect(result.decision.kind).toBe("injected");
  });

  it("retries a 529 and succeeds", async () => {
    let attempts = 0;
    const stub = (async () => {
      attempts += 1;
      if (attempts === 1) return jsonResponse({ error: "overloaded" }, 529);
      return jsonResponse(response("none", { none: 0.99 }));
    }) as unknown as typeof fetch;

    const result = await routeWith(BACKEND_PROMPT, stub);
    expect(attempts).toBe(2);
    expect(result.decision.kind).toBe("skipped");
  });

  it("gives up after the configured retry count", async () => {
    let attempts = 0;
    const stub = (async () => {
      attempts += 1;
      return jsonResponse({ error: "rate limited" }, 429);
    }) as unknown as typeof fetch;

    const result = await routeWith(BACKEND_PROMPT, stub);

    expect(attempts).toBe(3); // first attempt plus two retries
    expect(result.decision.kind).toBe("degraded");
  });

  it("does not retry a 401, because an invalid key cannot become valid", async () => {
    let attempts = 0;
    const stub = (async () => {
      attempts += 1;
      return jsonResponse({ error: "unauthorized" }, 401);
    }) as unknown as typeof fetch;

    await routeWith(BACKEND_PROMPT, stub);
    expect(attempts).toBe(1);
  });
});

describe("route — credential safety", () => {
  it("sends the key only as an Authorization header", async () => {
    let seen: RequestInit | undefined;
    const stub = stubFetch({
      responses: [jsonResponse(response("none", { none: 1 }))],
      onRequest: (_url, init) => {
        seen = init;
      },
    });

    await routeWith(BACKEND_PROMPT, stub);

    const headers = seen?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TEST_KEY}`);
    expect(seen?.body).not.toContain(TEST_KEY);
  });

  it("never puts the key in a degraded result", async () => {
    const stub = stubFetch({ responses: [jsonResponse({ error: "unauthorized" }, 401)] });
    const result = await routeWith(BACKEND_PROMPT, stub);

    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
  });

  it("never puts the key in a network error message", async () => {
    const stub = stubFetch({ responses: [new Error(`failed to connect using ${TEST_KEY}`), new Error("x"), new Error("y")] });
    const result = await routeWith(BACKEND_PROMPT, stub);

    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
  });

  it("withholds the prompt when uploadPrompt is false", async () => {
    let body = "";
    const stub = stubFetch({
      responses: [jsonResponse(response("none", { none: 1 }))],
      onRequest: (_url, init) => {
        body = String(init.body);
      },
    });

    const secret = "the unique phrase that must not leave the machine";
    await routeWith(secret, stub, { uploadPrompt: false });

    expect(body).not.toContain("unique phrase");
    expect(body).toContain("prompt withheld");
  });

  it("puts the candidate name in the choice criteria, not only its description", async () => {
    // A name is often the strongest signal there is: an MCP server's description is the
    // infrastructure string found in a config file, while its name says what it does.
    let body = "";
    const stub = stubFetch({
      responses: [jsonResponse(response("none", { none: 1 }))],
      onRequest: (_url, init) => {
        body = String(init.body);
      },
    });

    await routeWith(BACKEND_PROMPT, stub);

    expect(body).toContain("ak-backend-development");
    expect(body).toContain("Build backends with Node.js");
  });

  it("truncates a very long prompt before sending it", async () => {
    let body = "";
    const stub = stubFetch({
      responses: [jsonResponse(response("none", { none: 1 }))],
      onRequest: (_url, init) => {
        body = String(init.body);
      },
    });

    const long = `refactor auth middleware ${"padding ".repeat(500)}SECRET_TAIL`;
    await routeWith(long, stub, { thresholds: { maxPromptChars: 100 } });

    expect(body).not.toContain("SECRET_TAIL");
  });
});

describe("route — result contract", () => {
  it("survives a JSON round trip without losing fields", async () => {
    const stub = stubFetch({
      responses: [
        jsonResponse({
          model: "jev-latest",
          answers: {
            [PRIMARY_QUESTION_ID]: {
              type: "choice",
              choice: "pi:skill:global:ak-backend-development",
              probabilities: { none: 0, "pi:skill:global:ak-backend-development": 0.9 },
              confidence: 0.9,
            },
            c0: { type: "noul", noul: 0.95 },
            c1: { type: "noul", noul: 0.65 },
          },
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      ],
    });

    const result = await routeWith(BACKEND_PROMPT, stub);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("always reports the shortlist that was sent", async () => {
    const stub = stubFetch({ responses: [jsonResponse(response("none", { none: 1 }))] });
    const result = await routeWith(BACKEND_PROMPT, stub);

    expect(result.shortlist.length).toBeGreaterThan(0);
    expect(result.shortlistDetail.length).toBe(result.shortlist.length);
    expect(result.model).toBe("jev-latest");
  });

  it("keeps the ranking even when nothing is injected", async () => {
    const stub = stubFetch({
      responses: [
        jsonResponse({
          model: "jev-latest",
          answers: {
            [PRIMARY_QUESTION_ID]: { type: "choice", choice: "none", probabilities: { none: 1 }, confidence: 1 },
            c0: { type: "noul", noul: 0.2 },
          },
        }),
      ],
    });

    const result = await routeWith(BACKEND_PROMPT, stub);
    expect(result.decision.kind).toBe("skipped");
    expect(result.ranking.length).toBeGreaterThan(0);
  });
});
