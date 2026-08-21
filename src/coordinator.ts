import {
  GitHubConflictError,
  GitHubSink,
  type PendingDescriptor,
  type WritePlan,
} from "./github-sink";
import { type CommonsEvidenceEnvelopeV1 } from "./schema";
import type { Env } from "./env";
import { handleIngress } from "./application";
import { parseIngressRequest } from "./ingress";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type SubmissionResult = Readonly<{ accepted: true; duplicate: boolean }>;

export type IdempotencyRecord = Readonly<{
  digest: string;
  expiresAt: number;
  descriptor: PendingDescriptor;
  status: "pending" | "in_flight" | "completed";
}>;

export interface IdempotencyStore {
  get(digest: string): Promise<IdempotencyRecord | undefined>;
  put(record: IdempotencyRecord): Promise<void>;
  remove(digest: string): Promise<void>;
  purgeExpired(now: number): Promise<void>;
  nextExpiry(): Promise<number | undefined>;
}

interface AlarmAtomicIdempotencyStore extends IdempotencyStore {
  putAndSchedule(record: IdempotencyRecord): Promise<void>;
  purgeExpiredAndSchedule(now: number): Promise<void>;
}

export interface ExpiryScheduler {
  schedule(at: number | undefined): Promise<void>;
}

export function migrateIdempotencySchema(
  storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
): void {
  const schema =
    "digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, target TEXT NOT NULL, blob_sha TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_flight', 'completed'))";
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS idempotency (${schema})`);
  const columns = [
    ...storage.sql.exec<{ name: string }>("PRAGMA table_info(idempotency)"),
  ];
  if (!columns.some((column) => column.name === "status")) {
    storage.sql.exec(
      "ALTER TABLE idempotency ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_flight', 'completed'))",
    );
    return;
  }
  const table = storage.sql
    .exec<{
      sql: string | null;
    }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'idempotency'",
    )
    .one();
  if (table?.sql?.includes("'in_flight'") !== true) {
    storage.transactionSync(() => {
      storage.sql.exec(`CREATE TABLE idempotency_rebuilt (${schema})`);
      storage.sql.exec(
        "INSERT INTO idempotency_rebuilt (digest, expires_at, target, blob_sha, status) SELECT digest, expires_at, target, blob_sha, CASE status WHEN 'completed' THEN 'completed' WHEN 'pending' THEN 'pending' ELSE 'in_flight' END FROM idempotency",
      );
      storage.sql.exec("DROP TABLE idempotency");
      storage.sql.exec("ALTER TABLE idempotency_rebuilt RENAME TO idempotency");
    });
  }
}

class GitHubOutcomeInconclusiveError extends Error {
  public constructor() {
    super("GitHub write outcome is inconclusive");
  }
}

export class CoordinatorCore {
  private reconciliationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly store: IdempotencyStore,
    private readonly sink: GitHubSink,
    private readonly now: () => number = Date.now,
    private readonly scheduler: ExpiryScheduler = {
      schedule: async () => undefined,
    },
  ) {}

  public async submit(
    envelope: CommonsEvidenceEnvelopeV1,
    idempotencyKey: string,
  ): Promise<SubmissionResult> {
    return this.serialize(() =>
      this.submitSerialized(envelope, idempotencyKey),
    );
  }

  private async submitSerialized(
    envelope: CommonsEvidenceEnvelopeV1,
    idempotencyKey: string,
  ): Promise<SubmissionResult> {
    const digest = await digestIdempotencyKey(idempotencyKey);
    await this.expireNow();
    const now = this.now();
    const existing = await this.store.get(digest);
    if (existing !== undefined) {
      if (existing.status === "completed")
        return { accepted: true, duplicate: true };
      if (await this.sink.isApplied(existing.descriptor)) {
        await this.complete(existing);
        return { accepted: true, duplicate: true };
      }
      if (existing.status === "in_flight") {
        throw new GitHubOutcomeInconclusiveError();
      }
    }

    await this.commitWithOneConflictRetry(
      envelope,
      digest,
      now + IDEMPOTENCY_TTL_MS,
    );
    return { accepted: true, duplicate: false };
  }

  public async expire(): Promise<void> {
    return this.serialize(() => this.expireNow());
  }

  private async expireNow(): Promise<void> {
    const now = this.now();
    if (isAlarmAtomicStore(this.store)) {
      await this.store.purgeExpiredAndSchedule(now);
    } else {
      await this.store.purgeExpired(now);
      await this.rescheduleExpiry();
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.reconciliationTail.catch(() => undefined);
    let release: () => void = () => undefined;
    this.reconciliationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async commitWithOneConflictRetry(
    envelope: CommonsEvidenceEnvelopeV1,
    digest: string,
    expiresAt: number,
  ): Promise<void> {
    let plan = await this.sink.prepare(envelope);
    await this.rememberPlan(digest, expiresAt, plan);
    try {
      await this.markInFlight(digest, expiresAt, plan);
      await this.sink.commit(plan);
    } catch (error) {
      if (!(error instanceof GitHubConflictError)) {
        await this.markInFlight(digest, expiresAt, plan);
        throw error;
      }
      if (await this.reconcileConflict(digest, expiresAt, plan)) return;

      plan = await this.sink.prepare(envelope);
      await this.rememberPlan(digest, expiresAt, plan);
      try {
        await this.markInFlight(digest, expiresAt, plan);
        await this.sink.commit(plan);
      } catch (retryError) {
        if (retryError instanceof GitHubConflictError) {
          if (await this.reconcileConflict(digest, expiresAt, plan)) return;
          await this.rememberPlan(digest, expiresAt, plan);
          throw retryError;
        }
        await this.markInFlight(digest, expiresAt, plan);
        throw retryError;
      }
    }
    await this.complete({
      digest,
      expiresAt,
      descriptor: plan.descriptor,
      status: "pending",
    });
  }

  private async reconcileConflict(
    digest: string,
    expiresAt: number,
    plan: WritePlan,
  ): Promise<boolean> {
    if (await this.sink.isApplied(plan.descriptor)) {
      await this.complete({
        digest,
        expiresAt,
        descriptor: plan.descriptor,
        status: "pending",
      });
      return true;
    }
    return false;
  }

  private async rememberPlan(
    digest: string,
    expiresAt: number,
    plan: WritePlan,
  ): Promise<void> {
    await this.persist({
      digest,
      expiresAt,
      descriptor: plan.descriptor,
      status: "pending",
    });
    await this.rescheduleExpiry();
  }

  private async complete(record: IdempotencyRecord): Promise<void> {
    await this.persist({ ...record, status: "completed" });
  }

  private async markInFlight(
    digest: string,
    expiresAt: number,
    plan: WritePlan,
  ): Promise<void> {
    await this.persist({
      digest,
      expiresAt,
      descriptor: plan.descriptor,
      status: "in_flight",
    });
  }

  private async persist(record: IdempotencyRecord): Promise<void> {
    if (isAlarmAtomicStore(this.store)) {
      await this.store.putAndSchedule(record);
    } else {
      await this.store.put(record);
      await this.rescheduleExpiry();
    }
  }

  private async rescheduleExpiry(): Promise<void> {
    await this.scheduler.schedule(await this.store.nextExpiry());
  }
}

export class EvidenceCoordinator implements DurableObject {
  private readonly core: CoordinatorCore;

  public constructor(
    private readonly ctx: DurableObjectState,
    env: Env,
  ) {
    this.core = new CoordinatorCore(
      new SqliteIdempotencyStore(this.ctx.storage),
      new GitHubSink(env.GITHUB_TOKEN),
      Date.now,
      new DurableObjectAlarmScheduler(this.ctx.storage),
    );
  }

  public async fetch(value: unknown): Promise<Response> {
    const result = await handleIngress(await parseIngressRequest(value), {
      submit: (evidence, idempotencyKey) =>
        this.core.submit(evidence, idempotencyKey),
    });
    return json(result.body, result.status);
  }

  public async alarm(): Promise<void> {
    await this.core.expire();
  }
}

class SqliteIdempotencyStore implements IdempotencyStore {
  public constructor(private readonly storage: DurableObjectStorage) {
    migrateIdempotencySchema(this.storage);
  }

  public async get(digest: string): Promise<IdempotencyRecord | undefined> {
    const row = this.storage.transactionSync(() => {
      const rows = this.storage.sql.exec<{
        digest: string;
        expires_at: number;
        target: string;
        blob_sha: string;
        status: "pending" | "in_flight" | "completed";
      }>(
        "SELECT digest, expires_at, target, blob_sha, status FROM idempotency WHERE digest = ?",
        digest,
      );
      for (const row of rows) return row;
      return undefined;
    });
    return row === undefined
      ? undefined
      : {
          digest: row.digest,
          expiresAt: row.expires_at,
          descriptor: { target: row.target, blobSha: row.blob_sha },
          status: row.status,
        };
  }

  public async put(record: IdempotencyRecord): Promise<void> {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT OR REPLACE INTO idempotency (digest, expires_at, target, blob_sha, status) VALUES (?, ?, ?, ?, ?)",
        record.digest,
        record.expiresAt,
        record.descriptor.target,
        record.descriptor.blobSha,
        record.status,
      );
    });
  }

  public async putAndSchedule(record: IdempotencyRecord): Promise<void> {
    const next = this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT OR REPLACE INTO idempotency (digest, expires_at, target, blob_sha, status) VALUES (?, ?, ?, ?, ?)",
        record.digest,
        record.expiresAt,
        record.descriptor.target,
        record.descriptor.blobSha,
        record.status,
      );
      return this.nextExpirySync();
    });
    const alarm = this.applyAlarm(next);
    await alarm;
  }

  public async remove(digest: string): Promise<void> {
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM idempotency WHERE digest = ?", digest);
    });
  }

  public async purgeExpired(now: number): Promise<void> {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "DELETE FROM idempotency WHERE expires_at <= ?",
        now,
      );
    });
  }

  public async purgeExpiredAndSchedule(now: number): Promise<void> {
    const next = this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "DELETE FROM idempotency WHERE expires_at <= ?",
        now,
      );
      return this.nextExpirySync();
    });
    const alarm = this.applyAlarm(next);
    await alarm;
  }

  public async nextExpiry(): Promise<number | undefined> {
    return this.storage.transactionSync(() => this.nextExpirySync());
  }

  private nextExpirySync(): number | undefined {
    const row = this.storage.sql
      .exec<{
        expires_at: number | null;
      }>("SELECT MIN(expires_at) AS expires_at FROM idempotency")
      .one();
    return row === null || row.expires_at === null ? undefined : row.expires_at;
  }

  private applyAlarm(at: number | undefined): Promise<void> {
    return at === undefined
      ? this.storage.deleteAlarm()
      : this.storage.setAlarm(at);
  }
}

function isAlarmAtomicStore(
  store: IdempotencyStore,
): store is AlarmAtomicIdempotencyStore {
  return "putAndSchedule" in store && "purgeExpiredAndSchedule" in store;
}

class DurableObjectAlarmScheduler implements ExpiryScheduler {
  public constructor(private readonly storage: DurableObjectStorage) {}

  public async schedule(at: number | undefined): Promise<void> {
    if (at === undefined) {
      await this.storage.deleteAlarm();
    } else {
      await this.storage.setAlarm(at);
    }
  }
}

async function digestIdempotencyKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
