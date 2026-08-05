import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSessionPreparer } from "./pi-session-preparer.js";

const roots: string[] = [];
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots) {
    makeRemovable(root);
    rmSync(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

function makeRemovable(path: string): void {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) makeRemovable(join(path, entry));
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "piwork-pi-prepare-")));
  roots.push(root);
  const dataRoot = join(root, "data");
  const tenantRoot = join(dataRoot, "tenant");
  const sessionRoot = join(tenantRoot, "sessions", SESSION_ID);
  const internalSocketPath = join(root, "internal.sock");
  mkdirSync(tenantRoot, { recursive: true });
  return { root, dataRoot, tenantRoot, sessionRoot, internalSocketPath };
}

describe("PiSessionPreparer", () => {
  it("installs explicit managed Skills and keeps the internal capability out of SRT policy", () => {
    const paths = fixture();
    const prepared = new PiSessionPreparer(() => process.execPath).prepare({
      ...paths,
      sessionId: SESSION_ID,
      knowledgeDirs: [],
      domainLayers: [{ allowedDomains: ["api.example.com"], deniedDomains: [] }],
      runtimeReadPaths: [process.execPath],
      issueUserSpaceCapability: () => "session-only-capability",
      managedSkillFiles: [
        {
          packageId: "tenant-skill",
          path: "SKILL.md",
          content: "---\nname: tenant-skill\ndescription: Test\n---\n",
        },
      ],
    });

    expect(prepared.managedSkillPaths.map((path) => path.split("/").at(-1))).toEqual(
      expect.arrayContaining(["user-space", "onlyoffice", "tenant-skill"]),
    );
    expect(
      readFileSync(join(prepared.layout.managedSkillsDir, "user-space", "SKILL.md"), "utf8"),
    ).toContain("exactly these top-level commands");
    expect(existsSync(join(prepared.sessionBinDir, "user-space"))).toBe(true);
    expect(prepared.taskReadOnlyPaths).toContain(prepared.layout.piResourcesDir);
    expect(prepared.userSpaceCapability).toBe("session-only-capability");
    expect(prepared.toolEnvironment).not.toHaveProperty("PIWORK_USER_SPACE_API_TOKEN");
    expect(JSON.stringify(prepared.sandboxSettings)).not.toContain("session-only-capability");
    expect(prepared.sandboxSettings.network.allowUnixSockets).toContain(paths.internalSocketPath);
    expect(prepared.sandboxSettings.network.allowedDomains).toEqual(["api.example.com"]);
  });

  it("rejects unsafe governed and migrated Skill paths", () => {
    const paths = fixture();
    const common = {
      ...paths,
      sessionId: SESSION_ID,
      knowledgeDirs: [],
      domainLayers: [],
      runtimeReadPaths: [process.execPath],
      issueUserSpaceCapability: () => "capability",
    };
    expect(() =>
      new PiSessionPreparer(() => process.execPath).prepare({
        ...common,
        managedSkillFiles: [{ packageId: "skill", path: "../escape", content: "bad" }],
      }),
    ).toThrow(/path/);

    const migrated = join(paths.root, "migrated");
    const skill = join(migrated, "linked");
    const outside = join(paths.root, "outside");
    mkdirSync(skill, { recursive: true });
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(skill, "SKILL.md"));
    expect(() =>
      new PiSessionPreparer(() => process.execPath).prepare({
        ...common,
        migratedUserSkillsRoot: migrated,
      }),
    ).toThrow(/unsupported|unsafe/);
  });

  it("copies complete safe migrated Skill trees into managed resources", () => {
    const paths = fixture();
    const migrated = join(paths.root, "migrated");
    const skill = join(migrated, "personal-research");
    mkdirSync(join(skill, "references"), { recursive: true });
    writeFileSync(
      join(skill, "SKILL.md"),
      "---\nname: personal-research\ndescription: Personal research\n---\n",
    );
    writeFileSync(join(skill, "references", "policy.md"), "Read-only policy");

    const prepared = new PiSessionPreparer(() => process.execPath).prepare({
      ...paths,
      sessionId: SESSION_ID,
      knowledgeDirs: [],
      domainLayers: [],
      runtimeReadPaths: [process.execPath],
      issueUserSpaceCapability: () => "capability",
      migratedUserSkillsRoot: migrated,
    });

    const installed = prepared.managedSkills.find((item) => item.name === "personal-research");
    expect(installed?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      readFileSync(
        join(prepared.layout.managedSkillsDir, "personal-research", "references", "policy.md"),
        "utf8",
      ),
    ).toBe("Read-only policy");
  });

  it("rejects migrated Skill trees whose aggregate size exceeds the safety limit", () => {
    const paths = fixture();
    const migrated = join(paths.root, "large-migrated");
    const skill = join(migrated, "large-skill");
    mkdirSync(skill, { recursive: true });
    const chunk = "x".repeat(2 * 1024 * 1024 - 1);
    for (let index = 0; index < 9; index += 1) {
      writeFileSync(join(skill, "part-" + index + ".txt"), chunk);
    }
    expect(() =>
      new PiSessionPreparer(() => process.execPath).prepare({
        ...paths,
        sessionId: SESSION_ID,
        knowledgeDirs: [],
        domainLayers: [],
        runtimeReadPaths: [process.execPath],
        issueUserSpaceCapability: () => "capability",
        migratedUserSkillsRoot: migrated,
      }),
    ).toThrow(/size limit/);
  });

  it("purges stale private checkout bytes before each generation", () => {
    const paths = fixture();
    const options = {
      ...paths,
      sessionId: SESSION_ID,
      knowledgeDirs: [],
      domainLayers: [],
      runtimeReadPaths: [process.execPath],
      issueUserSpaceCapability: () => "capability",
    };
    const preparer = new PiSessionPreparer(() => process.execPath);
    const first = preparer.prepare(options);
    writeFileSync(join(first.layout.userSpaceCheckoutsDir, "stale.bin"), "secret");
    const second = preparer.prepare(options);
    expect(existsSync(join(second.layout.userSpaceCheckoutsDir, "stale.bin"))).toBe(false);
  });

  it("binds managed Skill digests to complete content rather than session paths", () => {
    const prepare = (content: string) => {
      const paths = fixture();
      const prepared = new PiSessionPreparer(() => process.execPath).prepare({
        ...paths,
        sessionId: SESSION_ID,
        knowledgeDirs: [],
        domainLayers: [],
        runtimeReadPaths: [process.execPath],
        issueUserSpaceCapability: () => "capability",
        managedSkillFiles: [
          {
            packageId: "governed",
            path: "SKILL.md",
            content: "---\nname: governed\ndescription: Test\n---\n",
          },
          {
            packageId: "governed",
            path: "references/policy.txt",
            content,
          },
        ],
      });
      return prepared.managedSkills.find((skill) => skill.name === "governed")!;
    };

    const first = prepare("same content");
    const second = prepare("same content");
    const changed = prepare("changed content");
    expect(first.path).not.toBe(second.path);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.sha256).toBe(second.sha256);
    expect(first.sha256).not.toBe(changed.sha256);
    expect(first.sha256).not.toBe(createHash("sha256").update(first.path).digest("hex"));
  });

  it("uses the neutral TLS/CONNECT route without proxying model domains", () => {
    const paths = fixture();
    const certificatePath = join(paths.root, "internal-file-transport.crt");
    writeFileSync(certificatePath, "test certificate", { mode: 0o600 });
    const prepared = new PiSessionPreparer(() => process.execPath).prepare({
      ...paths,
      internalSocketPath: undefined,
      internalTlsTransport: {
        baseUrl: "https://user-space.piwork.internal:41443",
        certificatePath,
        proxyUrl: "http://127.0.0.1:41080",
      },
      sessionId: SESSION_ID,
      knowledgeDirs: [],
      domainLayers: [{ allowedDomains: ["models.example.com"], deniedDomains: [] }],
      runtimeReadPaths: [process.execPath],
      issueUserSpaceCapability: () => "tls-capability",
    });

    expect(prepared.toolEnvironment).toMatchObject({
      NODE_EXTRA_CA_CERTS: certificatePath,
      PIWORK_USER_SPACE_API_BASE: `https://user-space.piwork.internal:41443/internal/user-space-transfer/${SESSION_ID}`,
    });
    expect(prepared.userSpaceCapability).toBe("tls-capability");
    expect(prepared.toolEnvironment).not.toHaveProperty("PIWORK_USER_SPACE_API_TOKEN");
    expect(prepared.toolEnvironment).not.toHaveProperty("PIWORK_USER_SPACE_API_UNIX");
    expect(prepared.sandboxSettings.network.parentProxy).toEqual({
      http: "http://127.0.0.1:41080",
      https: "http://127.0.0.1:41080",
      noProxy: "models.example.com",
    });
    expect(prepared.sandboxSettings.network.allowedDomains).toEqual([
      "models.example.com",
      "user-space.piwork.internal",
    ]);
  });

  it("fails closed for invalid authority, transport, capability, and governed Skills", () => {
    const paths = fixture();
    const prepare = (overrides: Record<string, unknown> = {}) =>
      new PiSessionPreparer(() => process.execPath).prepare({
        ...paths,
        sessionId: SESSION_ID,
        knowledgeDirs: [],
        domainLayers: [],
        runtimeReadPaths: [process.execPath],
        issueUserSpaceCapability: () => "capability",
        ...overrides,
      });

    expect(() => prepare({ sessionId: "not-a-session" })).toThrow(/Invalid session id/);
    expect(() => prepare({ internalSocketPath: "relative.sock" })).toThrow(/absolute socket/);
    expect(() =>
      prepare({ internalSocketPath: undefined, internalTlsTransport: undefined }),
    ).toThrow(/transport is required/);
    expect(() => prepare({ issueUserSpaceCapability: () => "" })).toThrow(
      /capability could not be issued/,
    );
    expect(() =>
      prepare({
        managedSkillFiles: [{ packageId: "../bad", path: "SKILL.md", content: "bad" }],
      }),
    ).toThrow(/package id/);
    expect(() =>
      prepare({
        managedSkillFiles: [{ packageId: "user-space", path: "SKILL.md", content: "bad" }],
      }),
    ).toThrow(/built-in Skill/);
    expect(() =>
      prepare({
        managedSkillFiles: [{ packageId: "missing-entry", path: "notes.txt", content: "bad" }],
      }),
    ).toThrow(/missing SKILL.md/);
    expect(() =>
      prepare({
        managedSkillFiles: [
          { packageId: "oversized", path: "SKILL.md", content: "x".repeat(2 * 1024 * 1024 + 1) },
        ],
      }),
    ).toThrow(/too large/);
  });

  it("rejects malformed neutral TLS endpoints and unsafe certificate paths", () => {
    const paths = fixture();
    const certificatePath = join(paths.root, "internal-file-transport.crt");
    writeFileSync(certificatePath, "certificate", { mode: 0o600 });
    const common = {
      ...paths,
      internalSocketPath: undefined,
      sessionId: SESSION_ID,
      knowledgeDirs: [],
      domainLayers: [],
      runtimeReadPaths: [process.execPath],
      issueUserSpaceCapability: () => "capability",
    };

    expect(() =>
      new PiSessionPreparer(() => process.execPath).prepare({
        ...common,
        internalTlsTransport: {
          baseUrl: "https://models.example.com:41443",
          certificatePath,
          proxyUrl: "http://127.0.0.1:41080",
        },
      }),
    ).toThrow(/TLS transport is invalid/);
    const certificateDirectory = join(paths.root, "certificate-directory");
    mkdirSync(certificateDirectory);
    expect(() =>
      new PiSessionPreparer(() => process.execPath).prepare({
        ...common,
        internalTlsTransport: {
          baseUrl: "https://user-space.piwork.internal:41443",
          certificatePath: certificateDirectory,
          proxyUrl: "http://127.0.0.1:41080",
        },
      }),
    ).toThrow(/certificate is unsafe/);
  });
});
