import { describe, expect, it } from "vitest";

import * as coordinatorModule from "../src/coordinator";

class FourColumnSql {
  public readonly statements: string[] = [];
  private readonly columns = ["digest", "expires_at", "target", "blob_sha"];

  public exec(statement: string): Iterable<{ name: string }> {
    this.statements.push(statement);
    if (statement.startsWith("PRAGMA table_info")) {
      return this.columns.map((name) => ({ name }));
    }
    if (statement.startsWith("ALTER TABLE")) this.columns.push("status");
    return [];
  }
}

describe("SQLite idempotency migration", () => {
  it("upgrades the d3c0f26 four-column table once with a pending status default", () => {
    const sql = new FourColumnSql();
    const migrate = Reflect.get(
      coordinatorModule,
      "migrateIdempotencySchema",
    ) as undefined | ((storage: unknown) => void);

    expect(migrate).toBeTypeOf("function");
    if (migrate === undefined) return;
    migrate(sql);
    migrate(sql);

    expect(
      sql.statements.filter((statement) => statement.startsWith("ALTER TABLE")),
    ).toEqual([
      expect.stringContaining(
        "ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'",
      ),
    ]);
  });
});
