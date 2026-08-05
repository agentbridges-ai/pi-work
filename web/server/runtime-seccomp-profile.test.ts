import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Compose Runtime seccomp profile", () => {
  it("keeps the default deny policy while allowing Bash process-group discovery", () => {
    const profile = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../compose/runtime/seccomp.json"), "utf8"),
    ) as {
      defaultAction?: string;
      syscalls?: Array<{ names?: string[]; action?: string }>;
    };
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    const allow = profile.syscalls?.find((entry) => entry.action === "SCMP_ACT_ALLOW");
    expect(allow?.names).toEqual(expect.arrayContaining(["getpgid", "getpgrp", "setsid"]));
  });
});
