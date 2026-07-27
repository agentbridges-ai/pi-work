import { describe, expect, it } from "vitest";
import { classifyPlanBash, evaluatePiToolPolicy } from "./pi-plan-policy.js";

describe("Pi Plan policy", () => {
  it("allows a small literal read-only pipeline", () => {
    expect(classifyPlanBash("rg 'needle' src | head -n 20")).toMatchObject({
      allowed: true,
      commands: [
        ["rg", "needle", "src"],
        ["head", "-n", "20"],
      ],
    });
    expect(classifyPlanBash("find . -type f")).toMatchObject({ allowed: true });
    expect(classifyPlanBash("find . -name '*.ts' -maxdepth 3 -print")).toMatchObject({
      allowed: true,
    });
    expect(classifyPlanBash("cat -- --literal-option-filename")).toMatchObject({
      allowed: true,
    });
  });

  it.each([
    "cat file > out",
    "echo $(touch out)",
    "cat `whoami`",
    "rg $PATTERN .",
    "cat a && rm a",
    "python -c pass",
    "./reader file",
    "find . -delete",
    "find . -exec cat {} ;",
    "find . -fls /tmp/plan-output",
    "find . -fprint /tmp/plan-output",
    "find . -fprintf /tmp/plan-output '%p'",
    "tree -o /tmp/plan-output .",
    "tree --output=/tmp/plan-output .",
    "file -C -m /tmp/magic source.txt",
    "file --compile source.txt",
    "file --magic-file=/tmp/magic source.txt",
    "file -z archive.gz",
    "file --uncompress archive.gz",
    "sort -o result file",
    "sort --output=result file",
    "sort --out=result file",
    "sort --compress-program=sh file",
    "sort --compress-prog=sh file",
    "rg --pre ./decode pattern file",
    "rg --hostname-bin ./hostname pattern file",
    "uniq input output",
    "cat --future-option file",
    "ls --color=always",
    "cat *.txt",
    "sort *",
    "sort ?",
    "sort [ab]*",
    "cat {a,b}",
    "cat ~/secret",
    "cat file # hidden shell syntax",
    "cat (file)",
    String.raw`cat 'nonexistent\' ; echo PLAN_POLICY_BYPASS # '`,
    "cat a |",
    'cat "unterminated',
  ])("rejects ambiguous, dynamic, or mutating bash: %s", (command) => {
    expect(classifyPlanBash(command).allowed).toBe(false);
  });

  it.each([
    "user-space read office/notes/plan.md",
    "user-space read 'Project Archive/notes/plan.md' --offset 1 --limit 200",
    "user-space bash --capabilities",
    "user-space bash --command 'pwd'",
    "user-space bash --command 'ls -la office'",
    "user-space bash --command 'stat office/notes/plan.md'",
    "user-space bash --command 'file office/notes/plan.md'",
    "user-space bash --command 'du office/notes'",
    `user-space bash --command "find office -maxdepth 2 -type f -name '*.md' -print"`,
    "user-space bash --command 'tree -ad -L 2 office'",
    "user-space bash --command 'readlink office/current'",
    "user-space bash --command 'basename office/notes/plan.md'",
    "user-space bash --command 'dirname office/notes/plan.md'",
  ])("allows independently-authorized User Space read or metadata: %s", (command) => {
    expect(classifyPlanBash(command), command).toMatchObject({ allowed: true });
  });

  it.each([
    "user-space write office/notes/plan.md --content changed",
    "user-space edit office/notes/plan.md --edits []",
    "user-space metadata office/notes/plan.md",
    "user-space bash --command 'cat office/notes/plan.md'",
    "user-space bash --command 'grep needle office/notes/plan.md'",
    "user-space bash --command 'checkout office/archive.zip'",
    "user-space bash --command 'checkin shared/result.zip office/result.zip'",
    "user-space bash --command 'find office -fls /tmp/output'",
    "user-space bash --command 'tree -o /tmp/output office'",
    "user-space bash --command 'file -C office/notes/plan.md'",
    "user-space bash --command 'ls office | head -n 1'",
    "user-space bash --command 'ls office > listing.txt'",
    String.raw`user-space bash --command "cat 'nonexistent\' ; echo PLAN_POLICY_BYPASS # '"`,
    `user-space bash --command "find office -name *.md"`,
    "user-space bash --command 'pwd' --timeout 5",
    "user-space read office/notes/plan.md | head -n 1",
    "user-space read office/notes/plan.md && cat secret",
    "user-space read /office/notes/plan.md",
    "user-space read office/../secret",
    "user-space read office/notes/plan.md --offset 0",
    "user-space read office/notes/plan.md --limit -1",
    "user-space read office/notes/plan.md --offset 1 --offset 2",
    "user-space read office/notes/plan.md --unknown 1",
    "user-space read office/notes/plan.md --limit=1",
  ])("rejects unsafe or malformed User Space Plan access: %s", (command) => {
    expect(classifyPlanBash(command), command).toMatchObject({ allowed: false });
  });

  it("blocks write/edit and unknown tools while forcing tasks read-only", () => {
    expect(evaluatePiToolPolicy({ mode: "plan", toolName: "write", args: {} })).toMatchObject({
      allowed: false,
    });
    expect(evaluatePiToolPolicy({ mode: "plan", toolName: "edit", args: {} })).toMatchObject({
      allowed: false,
    });
    expect(
      evaluatePiToolPolicy({ mode: "plan", toolName: "task", args: { readOnly: false } }),
    ).toEqual({ allowed: true, patchedArgs: { readOnly: true } });
    expect(evaluatePiToolPolicy({ mode: "plan", toolName: "future_tool", args: {} })).toMatchObject(
      { allowed: false },
    );
    expect(
      evaluatePiToolPolicy({
        mode: "plan",
        toolName: "bash",
        args: { command: "user-space read office/notes/plan.md --limit 20" },
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluatePiToolPolicy({
        mode: "plan",
        toolName: "bash",
        args: { command: "user-space write office/notes/plan.md --content changed" },
      }),
    ).toMatchObject({ allowed: false });
  });

  it("allows only explicitly read-only MCP tools in Plan mode", () => {
    expect(
      evaluatePiToolPolicy({
        mode: "plan",
        toolName: "mcp__docs__search",
        args: {},
        mcpReadOnly: true,
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluatePiToolPolicy({
        mode: "plan",
        toolName: "mcp__docs__delete",
        args: {},
        mcpReadOnly: false,
      }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluatePiToolPolicy({
        mode: "plan",
        toolName: "mcp__docs__unknown",
        args: {},
      }),
    ).toMatchObject({ allowed: false });
  });

  it("does not restrict Agent mode", () => {
    expect(
      evaluatePiToolPolicy({
        mode: "agent",
        toolName: "write",
        args: {},
      }),
    ).toEqual({ allowed: true });
  });
});
