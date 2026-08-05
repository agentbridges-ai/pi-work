import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

type IsolateSrtSeccompShell = (args: string[], commandIndex: number) => void;

const wrapperPath = resolve(import.meta.dirname, "../../compose/runtime/piwork-bwrap-wrapper.js");
const wrapperSource = readFileSync(wrapperPath, "utf8");
const functionStart = wrapperSource.indexOf("function isolateSrtSeccompShell");
const functionEnd = wrapperSource.indexOf("\n\nfor (let index", functionStart);
if (functionStart < 0 || functionEnd < 0) {
  throw new Error("Could not locate the SRT shell isolation helper in the bwrap wrapper");
}
const isolateSrtSeccompShell = vm.runInNewContext(
  `${wrapperSource.slice(functionStart, functionEnd)}; isolateSrtSeccompShell`,
) as IsolateSrtSeccompShell;

function transform(script: string): string[] {
  const args = ["--", "/usr/bin/bash", "-c", script];
  isolateSrtSeccompShell(args, 0);
  return args;
}

describe("compose bwrap wrapper SRT shell isolation", () => {
  it.each([
    [
      "network bridge",
      "/usr/bin/bash -c 'socat TCP-LISTEN:3128,fork,reuseaddr UNIX-CONNECT:/tmp/piwork-pi-test/proxy/claude-http-123.sock >/dev/null 2>&1 &\ntrap \"kill %1 %2 2>/dev/null; exit\" EXIT\n/workspace/apply-seccomp /usr/bin/bash -c 'printf %s user-command'",
    ],
    ["direct seccomp", "/workspace/apply-seccomp /usr/bin/bash -c 'printf %s user-command'"],
  ])("starts the generated %s shell in a new session", (_label, script) => {
    const transformed = transform(script);

    expect(transformed.slice(0, 5)).toEqual([
      "--",
      "/usr/bin/setsid",
      "--wait",
      "/usr/bin/bash",
      "-c",
    ]);
    expect(transformed[5]).toContain("/usr/bin/setsid --wait /usr/bin/bash -c");
    expect(transformed[5]).toContain("'printf %s user-command'");
  });

  it("does not rewrite a user shell that merely mentions apply-seccomp", () => {
    const script = "/usr/bin/bash -c 'printf %s apply-seccomp /usr/bin/bash -c payload'";

    expect(transform(script)).toEqual(["--", "/usr/bin/bash", "-c", script]);
  });
});
