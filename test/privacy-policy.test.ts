import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type JsonObject = { [key: string]: JsonValue };
type JsonValue = boolean | number | string | JsonObject | JsonValue[] | null;

function parseJsonc(value: string): JsonObject {
  return JSON.parse(
    value.replace(/\/\/[^\n]*/g, "").replace(/,(\s*[}\]])/g, "$1"),
  ) as JsonObject;
}

function expectPrivacyConfiguration(config: JsonObject): void {
  const rootDependencies = config.dependencies_instrumentation;
  const rootObservability = config.observability;
  if (config.send_metrics !== false)
    throw new Error("send_metrics must be false");
  if (!isObject(rootDependencies) || rootDependencies.enabled !== false) {
    throw new Error("dependencies instrumentation must be disabled");
  }
  if (!isObject(rootObservability) || rootObservability.enabled !== false) {
    throw new Error("observability must be disabled");
  }
  if (rootObservability.head_sampling_rate !== 0) {
    throw new Error("head sampling must be zero");
  }
  if (
    !isObject(rootObservability.logs) ||
    rootObservability.logs.invocation_logs !== false
  ) {
    throw new Error("invocation logs must be disabled");
  }
  visit(config);
}

function visit(value: JsonValue): void {
  if (Array.isArray(value)) {
    value.forEach(visit);
    return;
  }
  if (!isObject(value)) return;
  if ("send_metrics" in value && value.send_metrics !== false) {
    throw new Error("send_metrics override must be false");
  }
  if ("dependencies_instrumentation" in value) {
    if (
      !isObject(value.dependencies_instrumentation) ||
      value.dependencies_instrumentation.enabled !== false
    ) {
      throw new Error("dependencies instrumentation override must be disabled");
    }
  }
  if ("observability" in value) {
    const observability = value.observability;
    if (!isObject(observability) || observability.enabled !== false) {
      throw new Error("observability override must be disabled");
    }
    if (observability.head_sampling_rate !== 0) {
      throw new Error("head sampling override must be zero");
    }
    if (
      !isObject(observability.logs) ||
      observability.logs.invocation_logs !== false
    ) {
      throw new Error("invocation logs override must be disabled");
    }
  }
  for (const forbidden of [
    "logpush",
    "tail_consumers",
    "streaming_tail_consumers",
  ]) {
    if (forbidden in value) throw new Error(`${forbidden} must be absent`);
  }
  Object.values(value).forEach(visit);
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeConfig(): JsonObject {
  return {
    send_metrics: false,
    dependencies_instrumentation: { enabled: false },
    observability: {
      enabled: false,
      head_sampling_rate: 0,
      logs: { invocation_logs: false },
    },
  };
}

describe("privacy deployment policy", () => {
  it("parses the effective Wrangler configuration with every telemetry axis disabled", async () => {
    const wrangler = await readFile(resolve(root, "wrangler.jsonc"), "utf8");

    expect(() =>
      expectPrivacyConfiguration(parseJsonc(wrangler)),
    ).not.toThrow();
  });

  it.each([
    ["send metrics", { send_metrics: true }, "send_metrics"],
    [
      "dependency instrumentation",
      { dependencies_instrumentation: { enabled: true } },
      "dependencies instrumentation",
    ],
    [
      "observability",
      {
        observability: {
          enabled: true,
          head_sampling_rate: 0,
          logs: { invocation_logs: false },
        },
      },
      "observability",
    ],
    [
      "head sampling",
      {
        observability: {
          enabled: false,
          head_sampling_rate: 1,
          logs: { invocation_logs: false },
        },
      },
      "head sampling",
    ],
    [
      "invocation logs",
      {
        observability: {
          enabled: false,
          head_sampling_rate: 0,
          logs: { invocation_logs: true },
        },
      },
      "invocation logs",
    ],
    ["logpush", { logpush: true }, "logpush"],
    ["tail consumers", { tail_consumers: ["collector"] }, "tail_consumers"],
    [
      "streaming tail consumers",
      { streaming_tail_consumers: ["collector"] },
      "streaming_tail_consumers",
    ],
  ])("rejects an unsafe %s override", (_axis, override, message) => {
    const config = safeConfig();
    config.env = { production: override as JsonObject };

    expect(() => expectPrivacyConfiguration(config)).toThrow(message);
  });

  it("uses AST lint policy for every production source file", async () => {
    const lint = new ESLint({
      overrideConfigFile: resolve(root, "eslint.config.js"),
    });
    const results = await lint.lintFiles([resolve(root, "src/**/*.ts")]);
    expect(results.flatMap((result) => result.messages)).toEqual([]);
  });

  it.each([
    ["Cookie", 'value.headers.get("Cookie")'],
    ["lowercase content type", 'value.headers.get("content-type")'],
    ["source IP", 'value.headers.get("CF-Connecting-IP")'],
    ["dynamic header", "value.headers.get(headerName)"],
    ["request metadata", "value.cf"],
  ])("rejects %s with AST semantics", async (_name, code) => {
    const lint = new ESLint({
      overrideConfigFile: resolve(root, "eslint.config.js"),
    });
    const [result] = await lint.lintText(
      `declare const value: Request; declare const headerName: string; ${code}`,
      { filePath: resolve(root, "src/policy-fixture.ts") },
    );
    expect(
      result?.messages.some(
        (message) => message.ruleId === "privacy/request-capability",
      ),
    ).toBe(true);
  });

  it.each([
    [
      "an aliased request",
      'const incoming = value; incoming.headers.get("Cookie")',
    ],
    [
      "destructured headers",
      'const { headers } = value; headers.get("Cookie")',
    ],
    ["a computed getter", 'value.headers["get"]("Cookie")'],
    ["a non-get header operation", 'value.headers.set("Cookie", "value")'],
    ["computed request metadata", 'value["cf"]'],
    [
      "a Request cast alias",
      'const incoming = value as Request; incoming.headers.get("Cookie")',
    ],
    ["an optional header chain", 'value?.headers.get("Cookie")'],
    ["a non-null header chain", 'value!.headers.get("Cookie")'],
    [
      "a satisfies header chain",
      '(value satisfies Request).headers.get("Cookie")',
    ],
    [
      "an assignment alias",
      'let incoming: Request; incoming = value; incoming.headers.get("Cookie")',
    ],
    [
      "a destructuring assignment",
      'let headers: Headers; ({ headers } = value); headers.get("Cookie")',
    ],
  ])("rejects adapter-policy bypass through %s", async (_name, code) => {
    const lint = new ESLint({
      overrideConfigFile: resolve(root, "eslint.config.js"),
    });
    const [result] = await lint.lintText(
      `declare const value: Request; ${code}`,
      { filePath: resolve(root, "src/ingress.ts") },
    );
    expect(
      result?.messages.some(
        (message) => message.ruleId === "privacy/request-capability",
      ),
    ).toBe(true);
  });

  it("rejects Request and Headers capabilities outside the audited adapter", async () => {
    const lint = new ESLint({
      overrideConfigFile: resolve(root, "eslint.config.js"),
    });
    const [result] = await lint.lintText(
      "const request: Request = undefined as never; const headers: Headers = request.headers;",
      { filePath: resolve(root, "src/handler.ts") },
    );
    expect(
      result?.messages.some(
        (message) => message.ruleId === "privacy/request-capability",
      ),
    ).toBe(true);
  });

  it.each([
    [
      "structural headers",
      "const metadata: { headers: { get(): void } } = undefined as never; metadata.headers.get();",
    ],
    [
      "structural cf",
      "const metadata: { cf: unknown } = undefined as never; metadata.cf;",
    ],
    [
      "Request cast",
      'const metadata = value as Request; metadata.headers.get("Cookie");',
    ],
  ])(
    "rejects %s access outside the adapter regardless of inferred type",
    async (_name, code) => {
      const lint = new ESLint({
        overrideConfigFile: resolve(root, "eslint.config.js"),
      });
      const [result] = await lint.lintText(
        `declare const value: unknown; ${code}`,
        { filePath: resolve(root, "src/handler.ts") },
      );
      expect(
        result?.messages.some(
          (message) => message.ruleId === "privacy/request-capability",
        ),
      ).toBe(true);
    },
  );

  it("rejects bracket console syntax with no-console", async () => {
    const lint = new ESLint({
      overrideConfigFile: resolve(root, "eslint.config.js"),
    });
    const [result] = await lint.lintText('console["log"]("metadata")', {
      filePath: resolve(root, "src/handler.ts"),
    });
    expect(
      result?.messages.some((message) => message.ruleId === "no-console"),
    ).toBe(true);
  });

  it.each([
    ["console alias", "const log = console.log;"],
    ["console destructuring", "const { log } = console;"],
    ["globalThis console", "globalThis.console.log();"],
    ["computed globalThis console", 'globalThis["console"]["log"]();'],
  ])("rejects %s with the custom console policy", async (_name, code) => {
    const lint = new ESLint({
      overrideConfigFile: resolve(root, "eslint.config.js"),
    });
    const [result] = await lint.lintText(code, {
      filePath: resolve(root, "src/handler.ts"),
    });
    expect(
      result?.messages.some(
        (message) => message.ruleId === "privacy/request-capability",
      ),
    ).toBe(true);
  });
});
