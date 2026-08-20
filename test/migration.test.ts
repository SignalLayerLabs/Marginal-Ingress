import { describe, expect, it } from "vitest";

import { migrateIdempotencySchema } from "../src/coordinator";

class LegacySql {
  public readonly statements: string[] = [];
  private columns: string[];

  public constructor(
    private tableSql: string,
    hasStatus: boolean,
  ) {
    this.columns = ["digest", "expires_at", "target", "blob_sha"];
    if (hasStatus) this.columns.push("status");
  }

  public exec(statement: string): Iterable<{ name?: string; sql?: string }> & {
    one(): { sql: string | null } | null;
  } {
    this.statements.push(statement);
    const rows = statement.startsWith("PRAGMA table_info")
      ? this.columns.map((name) => ({ name }))
      : statement.startsWith("SELECT sql FROM sqlite_master")
        ? [{ sql: this.tableSql }]
        : [];
    if (statement.startsWith("ALTER TABLE idempotency ADD COLUMN")) {
      this.columns.push("status");
      this.tableSql =
        "CREATE TABLE idempotency (status CHECK(status IN ('pending', 'in_flight', 'completed')))";
    }
    if (statement.startsWith("ALTER TABLE idempotency_rebuilt RENAME")) {
      this.tableSql =
        "CREATE TABLE idempotency (status CHECK(status IN ('pending', 'in_flight', 'completed')))";
    }
    return Object.assign(rows, {
      one: () => (rows[0] as { sql: string } | undefined) ?? null,
    });
  }
}

class LegacyStorage {
  public transactions = 0;

  public constructor(public readonly sql: LegacySql) {}

  public transactionSync<T>(operation: () => T): T {
    this.transactions += 1;
    return operation();
  }
}

describe("SQLite idempotency migration", () => {
  it("upgrades the d3c0f26 four-column table once with a pending status default", () => {
    const sql = new LegacySql("CREATE TABLE idempotency (...)", false);
    const storage = new LegacyStorage(sql);
    migrateIdempotencySchema(storage as never);
    migrateIdempotencySchema(storage as never);

    expect(
      sql.statements.filter((statement) => statement.startsWith("ALTER TABLE")),
    ).toEqual([
      expect.stringContaining(
        "ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'",
      ),
    ]);
  });

  it("transactionally rebuilds a legacy five-column uncertain CHECK once", () => {
    const sql = new LegacySql(
      "CREATE TABLE idempotency (... status TEXT CHECK(status IN ('pending', 'uncertain', 'completed')))",
      true,
    );
    const storage = new LegacyStorage(sql);
    migrateIdempotencySchema(storage as never);
    migrateIdempotencySchema(storage as never);

    expect(sql.statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CREATE TABLE idempotency_rebuilt"),
        expect.stringContaining("CASE status"),
        "DROP TABLE idempotency",
        "ALTER TABLE idempotency_rebuilt RENAME TO idempotency",
      ]),
    );
    expect(storage.transactions).toBe(1);
    expect(sql.statements).not.toContain("BEGIN IMMEDIATE");
    expect(sql.statements).not.toContain("COMMIT");
  });
});
