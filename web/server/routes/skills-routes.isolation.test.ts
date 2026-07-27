import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { registerSkillRoutes } from "./skills-routes.js";

describe("skill route canonical path isolation", () => {
  let root: string;
  let claudeRoot: string;
  let skillsDir: string;
  let outside: string;
  let app: Hono;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "piwork-skills-scope-"));
    claudeRoot = join(root, "claude-config-source");
    skillsDir = join(claudeRoot, "skills");
    outside = mkdtempSync(join(tmpdir(), "piwork-skills-outside-"));
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "# host secret\n");
    app = new Hono();
    registerSkillRoutes(app, { skillsDir });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("does not read or update a SKILL.md symlink that escapes the user config root", async () => {
    const skillDir = join(skillsDir, "escaped");
    mkdirSync(skillDir);
    symlinkSync(join(outside, "SKILL.md"), join(skillDir, "SKILL.md"));

    expect((await app.request("/skills/escaped")).status).toBe(400);
    expect(
      (
        await app.request("/skills/escaped", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "overwrite" }),
        })
      ).status,
    ).toBe(400);

    const list = await app.request("/skills");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
  });

  it("rejects a SKILL.md symlink to sibling settings inside the same user config root", async () => {
    const settings = join(claudeRoot, "settings.json");
    const skillDir = join(skillsDir, "settings-alias");
    writeFileSync(settings, '{"env":{"ANTHROPIC_API_KEY":"secret"}}\n');
    mkdirSync(skillDir);
    symlinkSync("../../settings.json", join(skillDir, "SKILL.md"));

    expect((await app.request("/skills/settings-alias")).status).toBe(400);
    expect(
      (
        await app.request("/skills/settings-alias", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "overwrite" }),
        })
      ).status,
    ).toBe(400);
    expect(await (await app.request("/skills")).json()).toEqual([]);
    expect(readFileSync(settings, "utf-8")).toContain("ANTHROPIC_API_KEY");
  });

  it("rejects a SKILL.md hardlink and leaves its other name unchanged", async () => {
    const settings = join(claudeRoot, "settings.json");
    const skillDir = join(skillsDir, "settings-hardlink");
    writeFileSync(settings, "host settings\n");
    mkdirSync(skillDir);
    linkSync(settings, join(skillDir, "SKILL.md"));

    expect((await app.request("/skills/settings-hardlink")).status).toBe(400);
    expect(
      (
        await app.request("/skills/settings-hardlink", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "overwrite" }),
        })
      ).status,
    ).toBe(400);
    expect(await (await app.request("/skills")).json()).toEqual([]);
    expect(readFileSync(settings, "utf-8")).toBe("host settings\n");
  });

  it("rejects an oversized SKILL.md instead of buffering it into the API process", async () => {
    const skillDir = join(skillsDir, "oversized");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), Buffer.alloc(1024 * 1024 + 1, 0x61));

    expect((await app.request("/skills/oversized")).status).toBe(400);
    expect(await (await app.request("/skills")).json()).toEqual([]);
  });

  it("rejects a skill directory symlink for reads, writes, and deletion", async () => {
    symlinkSync(outside, join(skillsDir, "directory-alias"));

    expect((await app.request("/skills/directory-alias")).status).toBe(400);
    expect(
      (
        await app.request("/skills/directory-alias", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "overwrite" }),
        })
      ).status,
    ).toBe(400);
    expect((await app.request("/skills/directory-alias", { method: "DELETE" })).status).toBe(400);
    expect(readFileSync(join(outside, "SKILL.md"), "utf-8")).toBe("# host secret\n");
  });

  it("does not follow nested symlinks while deleting a real skill directory", async () => {
    const skillDir = join(skillsDir, "deletable");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "# deletable\n");
    symlinkSync(outside, join(skillDir, "outside-alias"));

    expect((await app.request("/skills/deletable", { method: "DELETE" })).status).toBe(200);
    expect(existsSync(skillDir)).toBe(false);
    expect(readFileSync(join(outside, "SKILL.md"), "utf-8")).toBe("# host secret\n");
  });

  it("rejects an entire skills directory symlinked outside the user config root", async () => {
    rmSync(skillsDir, { recursive: true, force: true });
    symlinkSync(outside, skillsDir);

    expect((await app.request("/skills/escaped")).status).toBe(400);
    expect(
      (
        await app.request("/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "New Skill", content: "unsafe" }),
        })
      ).status,
    ).toBe(400);
  });
});
