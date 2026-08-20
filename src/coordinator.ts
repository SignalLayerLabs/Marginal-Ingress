import {
  GitHubConflictError,
  GitHubSink,
  type PendingDescriptor,
  type WritePlan,
} from "./github-sink";
import {
  parseEvidenceEnvelope,
  parseIdempotencyKey,
  type CommonsEvidenceEnvelopeV1,
} from "./schema";
import type { Env } from "./env";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type SubmissionResult = Readonly<{ accepted: true; duplicate: boolean }>;

export type IdempotencyRecord = Readonly<{
  digest: string;
  expiresAt: number;
  descriptor: PendingDescriptor;
  status: "pending" | "completed";
}>;

export interface IdempotencyStore {
  get(digest: string): Promise<IdempotencyRecord | undefined>;
  put(record: IdempotencyRecord): Promise<void>;
  remove(digest: string): Promise<void>;
  purgeExpired(now: number): Promise<void>;
  nextExpiry(): Promise<number | undefined>;
}

export interface ExpiryScheduler {
  schedule(at: number | undefined): Promise<void>;
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
    await this.store.purgeExpired(this.now());
    await this.rescheduleExpiry();
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
      await this.sink.commit(plan);
      await this.complete({
        digest,
        expiresAt,
        descriptor: plan.descriptor,
        status: "pending",
      });
      return;
    } catch (error) {
      if (!(error instanceof GitHubConflictError)) throw error;
    }

    plan = await this.sink.prepare(envelope);
    await this.rememberPlan(digest, expiresAt, plan);
    await this.sink.commit(plan);
    await this.complete({
      digest,
      expiresAt,
      descriptor: plan.descriptor,
      status: "pending",
    });
  }

  private async rememberPlan(
    digest: string,
    expiresAt: number,
    plan: WritePlan,
  ): Promise<void> {
    await this.store.put({
      digest,
      expiresAt,
      descriptor: plan.descriptor,
      status: "pending",
    });
    await this.rescheduleExpiry();
  }

  private async complete(record: IdempotencyRecord): Promise<void> {
    await this.store.put({ ...record, status: "completed" });
    await this.rescheduleExpiry();
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

  public async fetch(request: Request): Promise<Response> {
    return this.handle(request);
  }

  public async alarm(): Promise<void> {
    await this.core.expire();
  }

  private async handle(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return json({ accepted: false, error: "not_found" }, 404);
    try {
      const evidence = parseEvidenceEnvelope(await request.json());
      const idempotencyKey = parseIdempotencyKey(
        request.headers.get("Idempotency-Key"),
      );
      return json(await this.core.submit(evidence, idempotencyKey), 202);
    } catch {
      return json({ accepted: false, error: "sink_unavailable" }, 502);
    }
  }
}

class SqliteIdempotencyStore implements IdempotencyStore {
  public constructor(private readonly storage: DurableObjectStorage) {
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS idempotency (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, target TEXT NOT NULL, blob_sha TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending', 'completed')))",
    );
  }

  public async get(digest: string): Promise<IdempotencyRecord | undefined> {
    const row = this.storage.transactionSync(() =>
      this.storage.sql
        .exec<{
          digest: string;
          expires_at: number;
          target: string;
          blob_sha: string;
          status: "pending" | "completed";
        }>(
          "SELECT digest, expires_at, target, blob_sha, status FROM idempotency WHERE digest = ?",
          digest,
        )
        .one(),
    );
    return row === null
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

  public async nextExpiry(): Promise<number | undefined> {
    const row = this.storage.transactionSync(() =>
      this.storage.sql
        .exec<{
          expires_at: number | null;
        }>("SELECT MIN(expires_at) AS expires_at FROM idempotency")
        .one(),
    );
    return row === null || row.expires_at === null ? undefined : row.expires_at;
  }
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
