import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const releaseVerifier: any = await import("../../scripts/" + "verify-onlyoffice-release.mjs");
const {
  validateOnlyOfficeDescriptor,
  validateOnlyOfficeIntegrationBase,
  validatePiworkReleaseInputs,
  verifyPublishedOnlyOfficeRelease,
} = releaseVerifier;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = JSON.parse(
  readFileSync(resolve(root, "release/onlyoffice-release-manifest.json"), "utf8"),
);
// The checked-in descriptor may intentionally be a staged candidate.  Keep
// published-release tests independent from that lifecycle so candidate PRs do
// not turn the supported-release fixture into an accidental production gate.
const supportedBase = {
  ...base,
  schemaVersion: 4,
  lifecycle: "supported",
  releaseManifest: {
    ...base.releaseManifest,
    releaseId: "v0.5.12-fd3fbc60abd50785",
  },
};
const rootPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const webPackage = JSON.parse(readFileSync(resolve(root, "web/package.json"), "utf8"));
const runtimeManifest = {
  version: 5,
  releaseId: supportedBase.releaseManifest.releaseId,
  packageVersion: supportedBase.npmPackage.version,
  hostBuildId: supportedBase.releaseManifest.hostBuildId,
  runtimeManifestSha256: supportedBase.runtimeIdentity.assetManifestDigest,
  x2t: {
    version: supportedBase.repositories["onlyoffice-x2t-wasm"].version,
    commit: supportedBase.repositories["onlyoffice-x2t-wasm"].commitSha,
    sha256: supportedBase.artifacts.find((entry: any) => entry.kind === "x2t-wasm").sha256,
  },
};
const pinned = {
  ...supportedBase,
  releaseManifest: {
    ...supportedBase.releaseManifest,
    sha256: createHash("sha256").update(JSON.stringify(runtimeManifest)).digest("hex"),
  },
};
const previousWorkerVersionId = "11111111-1111-4111-8111-111111111111";
const candidateWorkerVersionId = "22222222-2222-4222-8222-222222222222";
const finalWorkerDeploymentId = "33333333-3333-4333-8333-333333333333";

function response(body: unknown, headers: Record<string, string> = {}, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

function provenanceStatement({
  gitHead = pinned.npmPackage.gitHead,
  workflowPath = ".github/workflows/release-npm.yml",
} = {}) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: `pkg:npm/${pinned.npmPackage.name.split("/").map(encodeURIComponent).join("/")}@${pinned.npmPackage.version}`,
        digest: {
          sha512: Buffer.from(pinned.npmPackage.integrity.slice(7), "base64").toString("hex"),
        },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "https://github.com/agentbridges-ai/onlyoffice-browser",
            path: workflowPath,
            ref: `refs/tags/v${pinned.npmPackage.version}`,
          },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/agentbridges-ai/onlyoffice-browser@refs/tags/v${pinned.npmPackage.version}`,
            digest: { gitCommit: gitHead },
          },
        ],
      },
    },
  };
}

function encodeStatement(statement: unknown) {
  return Buffer.from(JSON.stringify(statement)).toString("base64");
}

function publishedFetch({
  integrity = pinned.npmPackage.integrity,
  csp = "frame-ancestors https://piwork.getpi.work",
  hostWorkerVersion = candidateWorkerVersionId,
  runtime = runtimeManifest,
  statement = provenanceStatement(),
  attestations = [
    {
      predicateType: "https://slsa.dev/provenance/v1",
      bundle: { dsseEnvelope: { payload: encodeStatement(statement) } },
    },
  ],
} = {}) {
  return async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("registry.npmjs.org/") && url.includes("onlyoffice-browser"))
      return response({
        version: pinned.npmPackage.version,
        gitHead: pinned.npmPackage.gitHead,
        dist: {
          integrity,
          attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/test" },
        },
      });
    if (url === "https://registry.npmjs.org/-/npm/v1/attestations/test")
      return response({ attestations });
    if (url.endsWith("/channels/stable-v5.json"))
      return response(
        { releaseId: "different-current-stable", manifestSha256: "f".repeat(64) },
        { "cache-control": "no-store" },
      );
    if (url.includes(`/releases/${pinned.releaseManifest.releaseId}/manifest.json`))
      return response(runtime, {
        "cache-control": "public, max-age=31536000, immutable",
      });
    if (url.includes(`/r/${pinned.releaseManifest.releaseId}/office-host.html`))
      return response("host", {
        "content-type": "text/html",
        "x-onlyoffice-asset-version": pinned.releaseManifest.releaseId,
        "origin-agent-cluster": "?1",
        "cache-control": "public, max-age=31536000, immutable",
        "content-security-policy": csp,
        "x-onlyoffice-worker-version": hostWorkerVersion,
      });
    return response("missing", {}, 404);
  };
}

describe("published OnlyOffice descriptor verification", () => {
  it("binds the integration base to local ancestry and the pull request merge base", () => {
    const integrationBase = base.repositories.Piwork.integrationBaseCommit;
    const eventBase = "a".repeat(40);
    const eventHead = "b".repeat(40);
    const checkedOutMerge = "c".repeat(40);
    const ancestors = new Set([
      `${integrationBase}:${checkedOutMerge}`,
      `${eventBase}:${checkedOutMerge}`,
      `${eventHead}:${checkedOutMerge}`,
    ]);
    expect(
      validateOnlyOfficeIntegrationBase(base, {
        headCommit: checkedOutMerge,
        eventBaseCommit: eventBase,
        eventHeadCommit: eventHead,
        isAncestor: (ancestor: string, descendant: string) =>
          ancestors.has(`${ancestor}:${descendant}`),
        mergeBase: () => integrationBase,
      }),
    ).toBe(integrationBase);
    expect(() =>
      validateOnlyOfficeIntegrationBase(base, {
        headCommit: checkedOutMerge,
        eventBaseCommit: eventBase,
        eventHeadCommit: eventHead,
        isAncestor: () => true,
        mergeBase: () => "d".repeat(40),
      }),
    ).toThrow("pull request merge base");
    expect(
      validateOnlyOfficeIntegrationBase(base, {
        headCommit: eventHead,
        eventBaseCommit: eventBase,
        eventHeadCommit: eventHead,
        isAncestor: (ancestor: string, descendant: string) =>
          ancestor === integrationBase && descendant === eventHead,
        mergeBase: () => integrationBase,
      }),
    ).toBe(integrationBase);
    expect(() =>
      validateOnlyOfficeIntegrationBase(base, {
        headCommit: checkedOutMerge,
        eventBaseCommit: eventBase,
        eventHeadCommit: eventHead,
        isAncestor: (ancestor: string) => ancestor === integrationBase,
        mergeBase: () => integrationBase,
      }),
    ).toThrow("neither the pull request head nor its synthetic merge commit");
    expect(() =>
      validateOnlyOfficeIntegrationBase(base, {
        headCommit: checkedOutMerge,
        isAncestor: () => false,
      }),
    ).toThrow("not an ancestor");
    expect(() =>
      validateOnlyOfficeIntegrationBase(
        {
          ...base,
          promotionReceipt: { piworkIntegrationCommit: "d".repeat(40) },
        },
        {
          headCommit: checkedOutMerge,
          isAncestor: (ancestor: string) => ancestor === integrationBase,
        },
      ),
    ).toThrow("promotion receipt Piwork integration commit");
  });

  it("requires the Piwork lockfile pin and rejects the removed self commit", () => {
    expect(() => validatePiworkReleaseInputs({ ...base, lockfiles: [] }, root)).toThrow(
      "web/bun.lock",
    );
    expect(() =>
      validatePiworkReleaseInputs(
        {
          ...base,
          lockfiles: base.lockfiles.map((entry: any) =>
            entry.repository === "Piwork" ? { ...entry, sha256: "f".repeat(64) } : entry,
          ),
        },
        root,
      ),
    ).toThrow("digest mismatch");
    expect(() =>
      validateOnlyOfficeDescriptor(
        {
          ...base,
          repositories: {
            ...base.repositories,
            Piwork: { ...base.repositories.Piwork, commitSha: "f".repeat(40) },
          },
        },
        { rootPackage, webPackage },
      ),
    ).toThrow("self-referential");
  });

  it("separates the npm proxy source from the Host runtime source", () => {
    const candidateRuntimeCommit = "f".repeat(40);
    const candidate = {
      ...base,
      schemaVersion: 5,
      lifecycle: "candidate",
      repositories: {
        ...base.repositories,
        "onlyoffice-browser": {
          ...base.repositories["onlyoffice-browser"],
          commitSha: candidateRuntimeCommit,
        },
      },
      runtimeIdentity: { ...base.runtimeIdentity, sourceCommit: candidateRuntimeCommit },
    };
    expect(
      validateOnlyOfficeDescriptor(candidate, { rootPackage, webPackage, allowCandidate: true }),
    ).toMatchObject({ npmPackage: { sourceCommit: base.npmPackage.gitHead } });
    expect(() =>
      validateOnlyOfficeDescriptor(
        {
          ...candidate,
          runtimeIdentity: { ...candidate.runtimeIdentity, sourceCommit: "e".repeat(40) },
        },
        { rootPackage, webPackage, allowCandidate: true },
      ),
    ).toThrow("runtime Host source commit");
    expect(() =>
      validateOnlyOfficeDescriptor(
        { ...candidate, npmPackage: { ...candidate.npmPackage, sourceCommit: "e".repeat(40) } },
        { rootPackage, webPackage, allowCandidate: true },
      ),
    ).toThrow("npm gitHead");
  });
  it("allows candidate integration checks only when explicitly requested", () => {
    const candidate = { ...base, schemaVersion: 5, lifecycle: "candidate" };
    expect(() => validateOnlyOfficeDescriptor(candidate, { rootPackage, webPackage })).toThrow(
      "supported release",
    );
    expect(
      validateOnlyOfficeDescriptor(candidate, {
        rootPackage,
        webPackage,
        allowCandidate: true,
      }).lifecycle,
    ).toBe("candidate");
    const workflow = readFileSync(resolve(root, ".github/workflows/deep-verify.yml"), "utf8");
    const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
    expect(workflow).toContain("onlyoffice_candidate_integration");
    expect(workflow).toContain("onlyoffice_candidate_release_id");
    expect(workflow).toContain("--online --allow-candidate --candidate-integration");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("GITHUB_TOKEN: ${{ github.token }}");
    expect(workflow).toContain('candidate_base_sha="$(git rev-parse refs/remotes/origin/main)"');
    expect(workflow).toContain('ONLYOFFICE_INTEGRATION_EVENT_BASE_SHA="${candidate_base_sha}"');
    expect(workflow).toContain('ONLYOFFICE_INTEGRATION_EVENT_HEAD_SHA="${EXPECTED_HEAD_SHA}"');
    expect(workflow).not.toMatch(/pull_request[\s\S]{0,300}--allow-candidate/);
    expect(makefile).toMatch(/^verify:.*verify-onlyoffice-release/m);
    for (const path of [".github/workflows/deep-verify.yml", ".github/workflows/verify.yml"]) {
      const source = readFileSync(resolve(root, path), "utf8");
      const pullRequestTrigger = source.slice(
        source.indexOf("  pull_request:"),
        source.indexOf("  push:"),
      );
      expect(pullRequestTrigger).not.toContain("paths-ignore");
    }
  });

  it("keeps schema 4 supported releases compatible and reserves receipts for schema 5", () => {
    expect(
      validateOnlyOfficeDescriptor(supportedBase, { rootPackage, webPackage }).schemaVersion,
    ).toBe(4);
    expect(() =>
      validateOnlyOfficeDescriptor(
        {
          ...supportedBase,
          releaseManifest: {
            ...supportedBase.releaseManifest,
            releaseId: "future-without-receipt",
          },
        },
        { rootPackage, webPackage },
      ),
    ).toThrow("allowlisted legacy");
    expect(
      validateOnlyOfficeDescriptor(
        { ...supportedBase, schemaVersion: 5, lifecycle: "candidate" },
        { rootPackage, webPackage, allowCandidate: true },
      ).lifecycle,
    ).toBe("candidate");
    expect(() =>
      validateOnlyOfficeDescriptor(
        { ...supportedBase, schemaVersion: 5 },
        { rootPackage, webPackage },
      ),
    ).toThrow("promotion receipt");
    expect(
      validateOnlyOfficeDescriptor(
        {
          ...supportedBase,
          schemaVersion: 5,
          promotionReceipt: {
            version: 1,
            path: `/promotions/${supportedBase.releaseManifest.releaseId}/${supportedBase.runtimeIdentity.sourceCommit}-${"f".repeat(64)}.json`,
            sha256: "f".repeat(64),
            piworkIntegrationCommit: supportedBase.repositories.Piwork.integrationBaseCommit,
            deepVerifyRunId: 101,
            deepVerifyRunAttempt: 1,
            stagingRunId: 102,
            productionRunId: 103,
          },
        },
        { rootPackage, webPackage },
      ).schemaVersion,
    ).toBe(5);
  });
  it("verifies a schema 5 promotion receipt as immutable release evidence", async () => {
    const piworkIntegrationCommit = pinned.repositories.Piwork.integrationBaseCommit;
    const promotedRuntimeManifest = {
      ...runtimeManifest,
      sourceCommit: pinned.runtimeIdentity.sourceCommit,
    };
    const promotedManifestSha256 = createHash("sha256")
      .update(JSON.stringify(promotedRuntimeManifest))
      .digest("hex");
    const receipt = {
      version: 1,
      trustRoot: "protected-production-workflow-and-r2-cas",
      channel: pinned.releaseManifest.channel,
      candidate: { commit: pinned.runtimeIdentity.sourceCommit, runId: 201 },
      staging: { runId: 202 },
      piwork: {
        commit: piworkIntegrationCommit,
        deepVerifyRunId: 203,
        deepVerifyRunAttempt: 2,
      },
      previousStable: {
        releaseId: "v0.5.11-previous",
        manifestUrl: "/releases/v0.5.11-previous/manifest.json",
        manifestSha256: "e".repeat(64),
      },
      runtime: {
        releaseId: pinned.releaseManifest.releaseId,
        manifestUrl: `/releases/${pinned.releaseManifest.releaseId}/manifest.json`,
        manifestSha256: promotedManifestSha256,
        runtimeManifestSha256: pinned.runtimeIdentity.assetManifestDigest,
      },
      worker: {
        name: "onlyoffice-browser-runtime",
        previousVersionId: previousWorkerVersionId,
        candidateVersionId: candidateWorkerVersionId,
        finalDeploymentId: finalWorkerDeploymentId,
      },
      runtimeRoot: { mode: "stable-v5-release-cas" },
      production: {
        repository: "agentbridges-ai/onlyoffice-browser",
        runId: 204,
        runAttempt: 1,
      },
    };
    const receiptSha256 = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
    const promoted = {
      ...pinned,
      schemaVersion: 5,
      releaseManifest: {
        ...pinned.releaseManifest,
        sha256: promotedManifestSha256,
      },
      promotionReceipt: {
        version: 1,
        path: `/promotions/${pinned.releaseManifest.releaseId}/${pinned.runtimeIdentity.sourceCommit}-${receiptSha256}.json`,
        sha256: receiptSha256,
        piworkIntegrationCommit,
        deepVerifyRunId: receipt.piwork.deepVerifyRunId,
        deepVerifyRunAttempt: receipt.piwork.deepVerifyRunAttempt,
        stagingRunId: receipt.staging.runId,
        productionRunId: receipt.production.runId,
      },
    };
    const productionRun = {
      id: receipt.production.runId,
      run_attempt: receipt.production.runAttempt,
      conclusion: "success",
      event: "workflow_dispatch",
      head_sha: pinned.runtimeIdentity.sourceCommit,
      head_branch: "main",
      repository: { full_name: "agentbridges-ai/onlyoffice-browser" },
      path: ".github/workflows/deploy-r2.yml",
    };
    const productionAttemptPath = `/actions/runs/${receipt.production.runId}/attempts/${receipt.production.runAttempt}`;
    const productionLatestPath = `/actions/runs/${receipt.production.runId}`;
    const deepVerifyAttemptPath = `/actions/runs/${receipt.piwork.deepVerifyRunId}/attempts/${receipt.piwork.deepVerifyRunAttempt}`;
    const deepVerifyJobsPath = `${deepVerifyAttemptPath}/jobs?per_page=100`;
    const deepVerifyRun = {
      id: receipt.piwork.deepVerifyRunId,
      run_attempt: receipt.piwork.deepVerifyRunAttempt,
      conclusion: "success",
      event: "workflow_dispatch",
      head_sha: piworkIntegrationCommit,
      head_branch: "misakago/onlyoffice-integration",
      repository: { full_name: "agentbridges-ai/pi-work" },
      path: ".github/workflows/deep-verify.yml",
    };
    const deepVerifyJobs = {
      total_count: 2,
      jobs: [
        {
          run_id: receipt.piwork.deepVerifyRunId,
          head_sha: piworkIntegrationCommit,
          status: "completed",
          conclusion: "success",
          name: "verify",
        },
        {
          run_id: receipt.piwork.deepVerifyRunId,
          head_sha: piworkIntegrationCommit,
          status: "completed",
          conclusion: "success",
          name: `OnlyOffice candidate integration / ${pinned.releaseManifest.releaseId}`,
        },
      ],
    };
    const publishedFallback = publishedFetch({ runtime: promotedRuntimeManifest });
    const promotionEvidenceFetch = (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(deepVerifyJobsPath)) return response(deepVerifyJobs);
      if (url.endsWith(deepVerifyAttemptPath)) return response(deepVerifyRun);
      if (url.endsWith(productionAttemptPath)) return response(productionRun);
      return publishedFallback(input);
    };
    const requestAuthorizations: Array<{ authorization: string | null; url: string }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requestAuthorizations.push({
        authorization: new Headers(init?.headers).get("authorization"),
        url,
      });
      if (url.endsWith(promoted.promotionReceipt.path))
        return response(receipt, { "cache-control": "public, max-age=31536000, immutable" });
      return promotionEvidenceFetch(input);
    };
    validateOnlyOfficeDescriptor(promoted, { rootPackage, webPackage });
    expect(() =>
      validateOnlyOfficeDescriptor(
        {
          ...promoted,
          promotionReceipt: {
            ...promoted.promotionReceipt,
            deepVerifyRunAttempt: undefined,
          },
        },
        { rootPackage, webPackage },
      ),
    ).toThrow("deep verify run attempt");
    expect(() =>
      validateOnlyOfficeDescriptor(
        {
          ...promoted,
          promotionReceipt: {
            ...promoted.promotionReceipt,
            path: promoted.promotionReceipt.path.replace(
              pinned.runtimeIdentity.sourceCommit,
              "f".repeat(40),
            ),
          },
        },
        { rootPackage, webPackage },
      ),
    ).toThrow("path candidate");
    await expect(
      verifyPublishedOnlyOfficeRelease(promoted, fetchImpl as never, {
        githubToken: "github-actions-token",
      }),
    ).resolves.toMatchObject({ releaseId: promoted.releaseManifest.releaseId });
    expect(
      requestAuthorizations.find(({ url }) => url.endsWith(productionAttemptPath))?.authorization,
    ).toBe("Bearer github-actions-token");
    expect(
      requestAuthorizations.find(({ url }) => url.endsWith(deepVerifyAttemptPath))?.authorization,
    ).toBe("Bearer github-actions-token");
    expect(
      requestAuthorizations.find(({ url }) => url.endsWith(deepVerifyJobsPath))?.authorization,
    ).toBe("Bearer github-actions-token");
    expect(
      requestAuthorizations
        .filter(({ url }) => !url.startsWith("https://api.github.com/"))
        .every(({ authorization }) => authorization === null),
    ).toBe(true);
    const failedDeepVerifyFetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(promoted.promotionReceipt.path))
        return response(receipt, { "cache-control": "public, max-age=31536000, immutable" });
      if (url.endsWith(deepVerifyAttemptPath))
        return response({ ...deepVerifyRun, conclusion: "failure" });
      return promotionEvidenceFetch(input);
    };
    await expect(
      verifyPublishedOnlyOfficeRelease(promoted, failedDeepVerifyFetch as never),
    ).rejects.toThrow("deep verify workflow run identity or conclusion");
    const wrongCandidateJobFetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(promoted.promotionReceipt.path))
        return response(receipt, { "cache-control": "public, max-age=31536000, immutable" });
      if (url.endsWith(deepVerifyJobsPath))
        return response({
          ...deepVerifyJobs,
          jobs: deepVerifyJobs.jobs.map((job) =>
            job.name.startsWith("OnlyOffice candidate integration")
              ? { ...job, name: "OnlyOffice candidate integration / another-release" }
              : job,
          ),
        });
      return promotionEvidenceFetch(input);
    };
    await expect(
      verifyPublishedOnlyOfficeRelease(promoted, wrongCandidateJobFetch as never),
    ).rejects.toThrow("candidate integration job identity or conclusion");
    const mismatchedHostFallback = publishedFetch({
      hostWorkerVersion: previousWorkerVersionId,
      runtime: promotedRuntimeManifest,
    });
    const mismatchedHostFetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(promoted.promotionReceipt.path))
        return response(receipt, { "cache-control": "public, max-age=31536000, immutable" });
      if (url.startsWith("https://api.github.com/")) return promotionEvidenceFetch(input);
      return mismatchedHostFallback(input);
    };
    await expect(
      verifyPublishedOnlyOfficeRelease(promoted, mismatchedHostFetch as never),
    ).rejects.toThrow("Host Worker version does not match the promotion receipt");
    const requestedRunUrls: string[] = [];
    const rerunFetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(promoted.promotionReceipt.path))
        return response(receipt, { "cache-control": "public, max-age=31536000, immutable" });
      if (url.endsWith(productionAttemptPath)) {
        requestedRunUrls.push(url);
        return response(productionRun);
      }
      if (url.endsWith(productionLatestPath)) {
        requestedRunUrls.push(url);
        return response({ ...productionRun, run_attempt: 2, conclusion: "failure" });
      }
      return promotionEvidenceFetch(input);
    };
    await expect(
      verifyPublishedOnlyOfficeRelease(promoted, rerunFetch as never),
    ).resolves.toMatchObject({ releaseId: promoted.releaseManifest.releaseId });
    expect(requestedRunUrls).toEqual([
      `https://api.github.com/repos/agentbridges-ai/onlyoffice-browser${productionAttemptPath}`,
    ]);
    const failedRunFetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(promoted.promotionReceipt.path))
        return response(receipt, { "cache-control": "public, max-age=31536000, immutable" });
      if (url.endsWith(productionAttemptPath))
        return response({ ...productionRun, conclusion: "failure" });
      return promotionEvidenceFetch(input);
    };
    await expect(
      verifyPublishedOnlyOfficeRelease(promoted, failedRunFetch as never),
    ).rejects.toThrow("promotion workflow run identity or conclusion");
    const invalidReceipt = {
      ...receipt,
      production: { ...receipt.production, repository: "someone/else" },
    };
    const invalidSha256 = createHash("sha256").update(JSON.stringify(invalidReceipt)).digest("hex");
    const invalidPromoted = {
      ...promoted,
      promotionReceipt: {
        ...promoted.promotionReceipt,
        path: `/promotions/${pinned.releaseManifest.releaseId}/${pinned.runtimeIdentity.sourceCommit}-${invalidSha256}.json`,
        sha256: invalidSha256,
      },
    };
    const invalidFetch = async (input: string | URL | Request) => {
      if (String(input).endsWith(invalidPromoted.promotionReceipt.path))
        return response(invalidReceipt, {
          "cache-control": "public, max-age=31536000, immutable",
        });
      return promotionEvidenceFetch(input);
    };
    await expect(
      verifyPublishedOnlyOfficeRelease(invalidPromoted, invalidFetch as never),
    ).rejects.toThrow("production workflow");
    const invalidWorkerReceipt = {
      ...receipt,
      worker: { ...receipt.worker, candidateVersionId: "not-a-uuid" },
    };
    const invalidWorkerSha256 = createHash("sha256")
      .update(JSON.stringify(invalidWorkerReceipt))
      .digest("hex");
    const invalidWorkerPromoted = {
      ...promoted,
      promotionReceipt: {
        ...promoted.promotionReceipt,
        path: `/promotions/${pinned.releaseManifest.releaseId}/${pinned.runtimeIdentity.sourceCommit}-${invalidWorkerSha256}.json`,
        sha256: invalidWorkerSha256,
      },
    };
    const invalidWorkerFetch = async (input: string | URL | Request) => {
      if (String(input).endsWith(invalidWorkerPromoted.promotionReceipt.path))
        return response(invalidWorkerReceipt, {
          "cache-control": "public, max-age=31536000, immutable",
        });
      return promotionEvidenceFetch(input);
    };
    await expect(
      verifyPublishedOnlyOfficeRelease(invalidWorkerPromoted, invalidWorkerFetch as never),
    ).rejects.toThrow("candidate Worker version ID");
    const invalidRootReceipt = {
      ...receipt,
      runtimeRoot: { mode: "mutable-bucket-root" },
    };
    const invalidRootSha256 = createHash("sha256")
      .update(JSON.stringify(invalidRootReceipt))
      .digest("hex");
    const invalidRootPromoted = {
      ...promoted,
      promotionReceipt: {
        ...promoted.promotionReceipt,
        path: `/promotions/${pinned.releaseManifest.releaseId}/${pinned.runtimeIdentity.sourceCommit}-${invalidRootSha256}.json`,
        sha256: invalidRootSha256,
      },
    };
    const invalidRootFetch = async (input: string | URL | Request) => {
      if (String(input).endsWith(invalidRootPromoted.promotionReceipt.path))
        return response(invalidRootReceipt, {
          "cache-control": "public, max-age=31536000, immutable",
        });
      return promotionEvidenceFetch(input);
    };
    await expect(
      verifyPublishedOnlyOfficeRelease(invalidRootPromoted, invalidRootFetch as never),
    ).rejects.toThrow("runtime root mode");
  });
  it("accepts a pinned immutable release when stable has advanced", async () => {
    const result = await verifyPublishedOnlyOfficeRelease(pinned, publishedFetch() as never);
    expect(result.observedStableReleaseId).toBe("different-current-stable");
  });
  it("requires schema 5 immutable manifests to bind the Host source commit", async () => {
    const candidate = { ...pinned, schemaVersion: 5, lifecycle: "candidate" };
    await expect(
      verifyPublishedOnlyOfficeRelease(candidate, publishedFetch() as never),
    ).rejects.toThrow("schema 5 runtime manifest source commit");

    const declaredRuntime = {
      ...runtimeManifest,
      sourceCommit: candidate.runtimeIdentity.sourceCommit,
    };
    const declaredCandidate = {
      ...candidate,
      releaseManifest: {
        ...candidate.releaseManifest,
        sha256: createHash("sha256").update(JSON.stringify(declaredRuntime)).digest("hex"),
      },
    };
    await expect(
      verifyPublishedOnlyOfficeRelease(
        declaredCandidate,
        publishedFetch({ runtime: declaredRuntime }) as never,
      ),
    ).resolves.toMatchObject({ releaseId: candidate.releaseManifest.releaseId });
  });
  it("rejects a runtime manifest that declares a different Host source commit", async () => {
    const declaredRuntime = { ...runtimeManifest, sourceCommit: "f".repeat(40) };
    const declaredPinned = {
      ...pinned,
      releaseManifest: {
        ...pinned.releaseManifest,
        sha256: createHash("sha256").update(JSON.stringify(declaredRuntime)).digest("hex"),
      },
    };
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(`/releases/${pinned.releaseManifest.releaseId}/manifest.json`))
        return response(declaredRuntime, {
          "cache-control": "public, max-age=31536000, immutable",
        });
      return publishedFetch()(input);
    };
    await expect(
      verifyPublishedOnlyOfficeRelease(declaredPinned, fetchImpl as never),
    ).rejects.toThrow("runtime manifest source commit");
  });
  it("rejects a runtime x2t WASM digest that differs from the descriptor", async () => {
    const mismatchedRuntime = {
      ...runtimeManifest,
      x2t: { ...runtimeManifest.x2t, sha256: "f".repeat(64) },
    };
    const mismatchedPinned = {
      ...pinned,
      releaseManifest: {
        ...pinned.releaseManifest,
        sha256: createHash("sha256").update(JSON.stringify(mismatchedRuntime)).digest("hex"),
      },
    };
    await expect(
      verifyPublishedOnlyOfficeRelease(
        mismatchedPinned,
        publishedFetch({ runtime: mismatchedRuntime }) as never,
      ),
    ).rejects.toThrow("x2t WASM digest");
  });
  it("rejects npm integrity and provenance failures", async () => {
    await expect(
      verifyPublishedOnlyOfficeRelease(
        pinned,
        publishedFetch({ integrity: "sha512-bad" }) as never,
      ),
    ).rejects.toThrow("integrity");
    await expect(
      verifyPublishedOnlyOfficeRelease(pinned, publishedFetch({ attestations: [] }) as never),
    ).rejects.toThrow("SLSA attestation");
    await expect(
      verifyPublishedOnlyOfficeRelease(
        pinned,
        publishedFetch({ statement: provenanceStatement({ gitHead: "f".repeat(40) }) }) as never,
      ),
    ).rejects.toThrow("signed tag");
  });
  it("rejects immutable Host identity and embedding policy failures", async () => {
    await expect(
      verifyPublishedOnlyOfficeRelease(
        pinned,
        publishedFetch({
          csp: "default-src https://piwork.getpi.work; frame-ancestors 'none'",
        }) as never,
      ),
    ).rejects.toThrow("CSP");
  });
});
