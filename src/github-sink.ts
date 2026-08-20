import {
  EvidenceValidationError,
  parseEvidenceEnvelope,
  type CommonsEvidenceAtomV1,
  type CommonsEvidenceEnvelopeV1,
} from "./schema";

export const GITHUB_REPOSITORY = "SignalLayerLabs/Marginal-Commons";
export const GITHUB_COMMITTER = {
  name: "Marginal Ingress",
  email: "commons-bot@signallayerlabs.example",
} as const;
export const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

const HISTORY_LIMIT = 16;
const HISTORY_PAGE_LIMIT = 4;
const MAX_GITHUB_RESPONSE_BYTES = 128 * 1024;

type AggregateDocument = {
  schema_version: "1.0";
  model_namespace: CommonsEvidenceEnvelopeV1["model_namespace"];
  atoms: CommonsEvidenceAtomV1[];
};

export type PendingDescriptor = Readonly<{
  target: string;
  blobSha: string;
}>;

export type WritePlan = Readonly<{
  descriptor: PendingDescriptor;
  currentSha?: string;
  content: string;
}>;

export class GitHubConflictError extends Error {}

function targetFor(
  modelNamespace: CommonsEvidenceEnvelopeV1["model_namespace"],
): string {
  return `models/${modelNamespace}/aggregates.json`;
}

function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string): string {
  const binary = atob(value.replace(/\s/g, ""));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

function sameDimensions(
  left: CommonsEvidenceAtomV1,
  right: CommonsEvidenceAtomV1,
): boolean {
  return (
    left.record_type === right.record_type &&
    left.action_kind === right.action_kind &&
    left.cost_bucket === right.cost_bucket &&
    left.gain_bucket === right.gain_bucket &&
    left.recommendation === right.recommendation &&
    left.applied_decision === right.applied_decision &&
    left.reason_code === right.reason_code &&
    left.outcome_class === right.outcome_class &&
    left.minimum_group_size === right.minimum_group_size
  );
}

function mergeAtoms(
  existing: CommonsEvidenceAtomV1[],
  submitted: readonly CommonsEvidenceAtomV1[],
): CommonsEvidenceAtomV1[] {
  const merged = existing.map((atom) => ({ ...atom }));
  for (const submittedAtom of submitted) {
    const found = merged.find((existingAtom) =>
      sameDimensions(existingAtom, submittedAtom),
    );
    if (found === undefined) {
      merged.push({ ...submittedAtom });
    } else {
      found.count = Math.min(1000, found.count + submittedAtom.count);
    }
  }
  return merged;
}

function stableDocument(document: AggregateDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function emptyDocument(
  modelNamespace: CommonsEvidenceEnvelopeV1["model_namespace"],
): AggregateDocument {
  return { schema_version: "1.0", model_namespace: modelNamespace, atoms: [] };
}

export class GitHubSink {
  public constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async prepare(
    envelope: CommonsEvidenceEnvelopeV1,
  ): Promise<WritePlan> {
    const target = targetFor(envelope.model_namespace);
    const { response, body } = await this.requestJson(this.urlFor(target), {
      headers: this.headers(),
    });
    let currentSha: string | undefined;
    let document = emptyDocument(envelope.model_namespace);
    if (response.status === 200) {
      const contents = body as {
        content?: unknown;
        sha?: unknown;
      };
      if (
        typeof contents.content !== "string" ||
        typeof contents.sha !== "string"
      ) {
        throw new Error("invalid aggregate document");
      }
      currentSha = contents.sha;
      document = this.parseDocument(
        base64Decode(contents.content),
        envelope.model_namespace,
      );
    } else if (response.status !== 404) {
      throw new Error("GitHub read failed");
    }

    const content = stableDocument({
      ...document,
      atoms: mergeAtoms(document.atoms, envelope.atoms),
    });
    return {
      descriptor: { target, blobSha: await gitBlobSha(content) },
      ...(currentSha === undefined ? {} : { currentSha }),
      content,
    };
  }

  public async commit(plan: WritePlan): Promise<void> {
    const response = await this.request(this.urlFor(plan.descriptor.target), {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Update anonymous MARGINAL aggregate",
        content: base64Encode(plan.content),
        ...(plan.currentSha === undefined ? {} : { sha: plan.currentSha }),
        committer: GITHUB_COMMITTER,
      }),
    });
    if (response.status === 409) throw new GitHubConflictError();
    if (!response.ok) throw new Error("GitHub write failed");
  }

  public async isApplied(descriptor: PendingDescriptor): Promise<boolean> {
    const current = await this.requestJson(this.urlFor(descriptor.target), {
      headers: this.headers(),
    });
    if (current.response.ok) {
      const contents = current.body as { sha?: unknown };
      if (typeof contents.sha !== "string")
        throw new Error("invalid aggregate document");
      if (contents.sha === descriptor.blobSha) return true;
    } else if (current.response.status !== 404) {
      throw new Error("GitHub reconciliation failed");
    }

    let historyUrl: string | undefined = this.historyUrl(descriptor.target);
    for (
      let page = 0;
      page < HISTORY_PAGE_LIMIT && historyUrl !== undefined;
      page += 1
    ) {
      const historyResponse = await this.requestJson(historyUrl, {
        headers: this.headers(),
      });
      if (!historyResponse.response.ok)
        throw new Error("GitHub reconciliation failed");
      const commitShas = this.commitShas(historyResponse.body);
      const historicalContents = await Promise.all(
        commitShas.map((commitSha) =>
          this.historicalBlobSha(descriptor.target, commitSha),
        ),
      );
      if (historicalContents.includes(descriptor.blobSha)) return true;
      historyUrl = this.nextHistoryUrl(
        historyResponse.response.headers.get("Link"),
      );
    }
    if (historyUrl !== undefined)
      throw new Error("GitHub reconciliation window is incomplete");
    return false;
  }

  private parseDocument(
    value: string,
    modelNamespace: CommonsEvidenceEnvelopeV1["model_namespace"],
  ): AggregateDocument {
    try {
      const parsed = parseEvidenceEnvelope(JSON.parse(value));
      if (parsed.model_namespace !== modelNamespace)
        throw new EvidenceValidationError();
      return {
        schema_version: parsed.schema_version,
        model_namespace: parsed.model_namespace,
        atoms: [...parsed.atoms],
      };
    } catch {
      throw new Error("invalid aggregate document");
    }
  }

  private headers(): HeadersInit {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private async historicalBlobSha(
    target: string,
    commitSha: string,
  ): Promise<string | undefined> {
    const historical = await this.requestJson(this.urlFor(target, commitSha), {
      headers: this.headers(),
    });
    if (historical.response.status === 404) return undefined;
    if (!historical.response.ok)
      throw new Error("GitHub reconciliation failed");
    const contents = historical.body as { sha?: unknown };
    if (typeof contents.sha !== "string")
      throw new Error("invalid aggregate document");
    return contents.sha;
  }

  private commitShas(value: unknown): string[] {
    if (!Array.isArray(value)) throw new Error("invalid GitHub history");
    return value.map((commit) => {
      if (
        typeof commit !== "object" ||
        commit === null ||
        !("sha" in commit) ||
        typeof commit.sha !== "string"
      ) {
        throw new Error("invalid GitHub history");
      }
      return commit.sha;
    });
  }

  private async requestJson(
    input: string,
    init: RequestInit,
  ): Promise<{ response: Response; body: unknown }> {
    return this.withDeadline(async (signal) => {
      const response = await this.fetcher(input, { ...init, signal });
      return { response, body: await this.readJson(response, signal) };
    });
  }

  private async request(input: string, init: RequestInit): Promise<Response> {
    return this.withDeadline((signal) =>
      this.fetcher(input, { ...init, signal }),
    );
  }

  private async withDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let rejectDeadline: (reason: Error) => void = () => undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
      controller.abort();
      rejectDeadline(new Error("GitHub request timed out"));
    }, GITHUB_REQUEST_TIMEOUT_MS);
    try {
      return await Promise.race([operation(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readJson(
    response: Response,
    signal: AbortSignal,
  ): Promise<unknown> {
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("invalid GitHub response");
    const cancel = () => {
      void reader.cancel();
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_GITHUB_RESPONSE_BYTES)
          throw new Error("GitHub response too large");
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  private urlFor(target: string, ref?: string): string {
    const base = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${target}`;
    return ref === undefined ? base : `${base}?ref=${encodeURIComponent(ref)}`;
  }

  private historyUrl(target: string): string {
    return `https://api.github.com/repos/${GITHUB_REPOSITORY}/commits?path=${encodeURIComponent(target)}&per_page=${HISTORY_LIMIT}`;
  }

  private nextHistoryUrl(link: string | null): string | undefined {
    if (link === null) return undefined;
    const match = /<([^>]+)>;\s*rel="next"/.exec(link);
    if (match?.[1] === undefined) return undefined;
    const next = new URL(match[1]);
    const expected = `/repos/${GITHUB_REPOSITORY}/commits`;
    if (
      next.origin !== "https://api.github.com" ||
      next.pathname !== expected
    ) {
      throw new Error("invalid GitHub history link");
    }
    return next.toString();
  }
}
