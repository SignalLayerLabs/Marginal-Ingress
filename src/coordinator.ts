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

type IdempotencyRecord = Readonly<{
  digest: string;
  expiresAt: number;
  descriptor: PendingDescriptor;
}>;

export interface IdempotencyStore {
  get(digest: string): Promise<IdempotencyRecord | undefined>;
  put(record: IdempotencyRecord): Promise<void>;
  remove(digest: string): Promise<void>;
  purgeExpired(now: number): Promise<void>;
}

export class CoordinatorCore {
  public constructor(
    private readonly store: IdempotencyStore,
    private readonly sink: GitHubSink,
    private readonly now: () => number = Date.now,
  ) {}

  public async submit(
    envelope: CommonsEvidenceEnvelopeV1,
    idempotencyKey: string,
  ): Promise<SubmissionResult> {
    const digest = await digestIdempotencyKey(idempotencyKey);
    const now = this.now();
    await this.store.purgeExpired(now);
    const existing = await this.store.get(digest);
    if (existing !== undefined) {
      if (await this.sink.isApplied(existing.descriptor))
        return { accepted: true, duplicate: true };
      await this.store.remove(digest);
    }

    await this.commitWithOneConflictRetry(
      envelope,
      digest,
      now + IDEMPOTENCY_TTL_MS,
    );
    return { accepted: true, duplicate: false };
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
      return;
    } catch (error) {
      if (!(error instanceof GitHubConflictError)) throw error;
    }

    plan = await this.sink.prepare(envelope);
    await this.rememberPlan(digest, expiresAt, plan);
    await this.sink.commit(plan);
  }

  private async rememberPlan(
    digest: string,
    expiresAt: number,
    plan: WritePlan,
  ): Promise<void> {
    await this.store.put({ digest, expiresAt, descriptor: plan.descriptor });
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
    );
  }

  public async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(() => this.handle(request));
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
      "CREATE TABLE IF NOT EXISTS idempotency (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, target TEXT NOT NULL, blob_sha TEXT NOT NULL)",
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
        }>(
          "SELECT digest, expires_at, target, blob_sha FROM idempotency WHERE digest = ?",
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
        };
  }

  public async put(record: IdempotencyRecord): Promise<void> {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT OR REPLACE INTO idempotency (digest, expires_at, target, blob_sha) VALUES (?, ?, ?, ?)",
        record.digest,
        record.expiresAt,
        record.descriptor.target,
        record.descriptor.blobSha,
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
