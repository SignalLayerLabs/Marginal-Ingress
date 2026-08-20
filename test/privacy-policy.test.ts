import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("privacy deployment policy", () => {
  it("disables Worker telemetry and request-specific source logging", async () => {
    const [wrangler, sources] = await Promise.all([
      readFile(resolve(root, "wrangler.jsonc"), "utf8"),
      Promise.all(
        ["index.ts", "schema.ts", "coordinator.ts", "github-sink.ts"].map(
          (file) => readFile(resolve(root, "src", file), "utf8"),
        ),
      ),
    ]);

    expect(wrangler).toMatch(/"send_metrics"\s*:\s*false/);
    expect(wrangler).toMatch(
      /"dependencies_instrumentation"\s*:\s*\{\s*"enabled"\s*:\s*false,?\s*}/s,
    );
    expect(wrangler).toMatch(
      /"observability"\s*:\s*\{\s*"enabled"\s*:\s*false/s,
    );
    expect(wrangler).toMatch(/"head_sampling_rate"\s*:\s*0/);
    expect(wrangler).toMatch(/"invocation_logs"\s*:\s*false/);
    expect(sources.join("\n")).not.toMatch(/\bconsole\.|request\.cf\b/);
  });
});
