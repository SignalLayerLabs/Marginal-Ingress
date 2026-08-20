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
    const response = await this.fetcher(this.urlFor(target), {
      headers: this.headers(),
    });
    let currentSha: string | undefined;
    let document = emptyDocument(envelope.model_namespace);
    if (response.status === 200) {
      const contents = (await response.json()) as {
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
    const response = await this.fetcher(this.urlFor(plan.descriptor.target), {
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
    const response = await this.fetcher(this.urlFor(descriptor.target), {
      headers: this.headers(),
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error("GitHub reconciliation failed");
    const contents = (await response.json()) as { sha?: unknown };
    if (typeof contents.sha !== "string")
      throw new Error("invalid aggregate document");
    return contents.sha === descriptor.blobSha;
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

  private urlFor(target: string): string {
    return `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${target}`;
  }
}
