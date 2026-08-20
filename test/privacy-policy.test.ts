import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat();
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

  it("scans every production source file for prohibited request-specific logging and metadata access", async () => {
    const sources = await Promise.all(
      (await sourceFiles(resolve(root, "src"))).map((file) =>
        readFile(file, "utf8"),
      ),
    );

    expect(sources.join("\n")).not.toMatch(
      /\bconsole(?:\.|\[|\?)|request\.cf\b|["'](?:Cookie|User-Agent|Referer)["']/,
    );
  });
});
