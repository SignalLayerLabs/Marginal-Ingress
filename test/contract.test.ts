import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("frozen Commons envelope contract", () => {
  it("matches the Task 1 SHA-256 fixture byte-for-byte", async () => {
    const [schema, fixture] = await Promise.all([
      readFile(resolve(root, "schemas/commons-evidence-envelope-v1.json")),
      readFile(
        resolve(root, "schemas/commons-evidence-envelope-v1.sha256"),
        "utf8",
      ),
    ]);

    expect(createHash("sha256").update(schema).digest("hex")).toBe(
      fixture.trim(),
    );
  });
});
