import { RUOK_FIXTURE_DIRECTORIES, RUOK_FIXTURE_FILES } from "./fixtures/user-space-ruok.js";

export type ShellSelfTestCase = {
  name: string;
  script: string;
  stdout?: string;
};

export const RUOK_COMMAND_MATRIX: ShellSelfTestCase[] = [
  { name: "echo", script: "echo echo-ok", stdout: "echo-ok" },
  { name: "cat", script: "cat matrix/text.txt", stdout: "alpha" },
  { name: "printf", script: "printf 'printf-ok\\n'", stdout: "printf-ok" },
  { name: "ls", script: "ls matrix", stdout: "text.txt" },
  { name: "mkdir", script: "mkdir -p matrix/mkdir/sub && ls matrix/mkdir", stdout: "sub" },
  { name: "rmdir", script: "mkdir -p matrix/rmdir-empty && rmdir matrix/rmdir-empty" },
  {
    name: "touch",
    script: "touch matrix/touched.txt && ls matrix/touched.txt",
    stdout: "matrix/touched.txt",
  },
  { name: "cp", script: "cp matrix/text.txt matrix/cp.txt && cat matrix/cp.txt", stdout: "beta" },
  {
    name: "mv",
    script:
      "printf move-ok > matrix/mv-src.txt && mv matrix/mv-src.txt matrix/mv-dst.txt && cat matrix/mv-dst.txt",
    stdout: "move-ok",
  },
  {
    name: "ln",
    script: "ln -s text.txt matrix/link.txt && readlink matrix/link.txt",
    stdout: "text.txt",
  },
  { name: "chmod", script: "chmod 644 matrix/text.txt" },
  { name: "pwd", script: "pwd", stdout: "/" },
  {
    name: "readlink",
    script: "ln -s text.txt matrix/readlink.txt && readlink matrix/readlink.txt",
    stdout: "text.txt",
  },
  { name: "head", script: "head -n 1 matrix/text.txt", stdout: "alpha" },
  { name: "tail", script: "tail -n 1 matrix/text.txt", stdout: "gamma" },
  { name: "wc", script: "wc -l matrix/text.txt", stdout: "matrix/text.txt" },
  { name: "stat", script: "stat matrix/text.txt", stdout: "matrix/text.txt" },
  {
    name: "grep",
    script: "grep -n grep-markdown-ok matrix/notes.md",
    stdout: "3:grep-markdown-ok",
  },
  { name: "fgrep", script: "fgrep beta matrix/text.txt", stdout: "beta" },
  { name: "egrep", script: "egrep 'alpha|delta' matrix/text.txt", stdout: "alpha" },
  { name: "sed", script: "printf 'hello\\n' | sed 's/hello/sed-ok/'", stdout: "sed-ok" },
  { name: "awk", script: "printf '1 2\\n' | awk '{print $1 + $2}'", stdout: "3" },
  { name: "sort", script: "printf 'b\\na\\n' | sort", stdout: "a\nb" },
  { name: "uniq", script: "printf 'a\\na\\nb\\n' | uniq", stdout: "a\nb" },
  { name: "comm", script: "comm matrix/comm-a.txt matrix/comm-b.txt", stdout: "a" },
  { name: "cut", script: "printf 'a:b\\n' | cut -d: -f2", stdout: "b" },
  { name: "paste", script: "paste matrix/comm-a.txt matrix/comm-b.txt", stdout: "a\tb" },
  { name: "tr", script: "printf 'abc' | tr a-z A-Z", stdout: "ABC" },
  { name: "rev", script: "printf 'abc\\n' | rev", stdout: "cba" },
  { name: "nl", script: "printf 'line\\n' | nl", stdout: "line" },
  { name: "fold", script: "printf 'abcdef\\n' | fold -w 3", stdout: "abc\ndef" },
  { name: "expand", script: "printf 'a\\tb\\n' | expand -t 4", stdout: "a   b" },
  { name: "unexpand", script: "printf 'a   b\\n' | unexpand -a -t 4", stdout: "a\tb" },
  { name: "strings", script: "printf 'hello\\0world\\n' | strings", stdout: "hello" },
  {
    name: "split",
    script: "printf 'abcdef' | split -b 3 - matrix/split- && cat matrix/split-aa matrix/split-ab",
    stdout: "abcdef",
  },
  { name: "column", script: "printf 'a b\\ncc dd\\n' | column -t", stdout: "cc" },
  { name: "join", script: "join matrix/join-a.txt matrix/join-b.txt", stdout: "1 one uno" },
  { name: "tee", script: "printf 'tee-ok\\n' | tee matrix/tee.txt", stdout: "tee-ok" },
  { name: "find", script: "find matrix -type f -name '*.md'", stdout: "matrix/notes.md" },
  { name: "basename", script: "basename matrix/text.txt", stdout: "text.txt" },
  { name: "dirname", script: "dirname matrix/text.txt", stdout: "matrix" },
  { name: "tree", script: "tree -L 1 matrix", stdout: "text.txt" },
  { name: "du", script: "du matrix", stdout: "matrix" },
  { name: "env", script: "env MATRIX_ENV=ok printenv MATRIX_ENV", stdout: "ok" },
  { name: "printenv", script: "printenv HOME", stdout: "/" },
  {
    name: "alias",
    script: "alias hi='echo alias-ok'\nalias hi",
    stdout: "alias hi='echo alias-ok'",
  },
  { name: "unalias", script: "alias bye='echo bye'\nunalias bye\ntrue" },
  { name: "history", script: "echo history-ok\nhistory", stdout: "history" },
  { name: "true", script: "true" },
  { name: "false", script: "false || echo false-ok", stdout: "false-ok" },
  { name: "clear", script: "clear", stdout: "\u001b[2J\u001b[H" },
  { name: "bash", script: "bash -c 'echo bash-ok'", stdout: "bash-ok" },
  { name: "sh", script: "sh -c 'echo sh-ok'", stdout: "sh-ok" },
  { name: "jq", script: "jq .name matrix/data.json", stdout: '"nexo"' },
  { name: "base64", script: "printf 'base64-ok' | base64", stdout: "YmFzZTY0LW9r" },
  { name: "diff", script: "diff matrix/text.txt matrix/text-copy.txt" },
  { name: "date", script: "date", stdout: "UTC" },
  { name: "sleep", script: "sleep 0 && echo sleep-ok", stdout: "sleep-ok" },
  { name: "timeout", script: "timeout 2 echo timeout-ok", stdout: "timeout-ok" },
  { name: "time", script: "time echo time-ok", stdout: "time-ok" },
  { name: "seq", script: "seq 1 3", stdout: "1\n2\n3" },
  { name: "expr", script: "expr 1 + 2", stdout: "3" },
  {
    name: "md5sum",
    script: "printf 'hash-ok' | md5sum",
    stdout: "97eeac6703d1882b638dab67bee4de2b",
  },
  {
    name: "sha1sum",
    script: "printf 'hash-ok' | sha1sum",
    stdout: "0195e79cc02332602ea47a7a4b3d4125c45632c3",
  },
  {
    name: "sha256sum",
    script: "printf 'hash-ok' | sha256sum",
    stdout: "b653becc3302186e314d0b44675c52bc1d3ef7886c3e737836ba089672cddd4b",
  },
  { name: "file", script: "file matrix/text.txt", stdout: "UTF-8 text" },
  { name: "html-to-markdown", script: "html-to-markdown matrix/page.html", stdout: "# Hi" },
  { name: "help", script: "help echo", stdout: "echo" },
  { name: "which", script: "which echo", stdout: "echo" },
  { name: "tac", script: "printf 'a\\nb\\n' | tac", stdout: "b\na" },
  { name: "hostname", script: "hostname", stdout: "localhost" },
  { name: "whoami", script: "whoami", stdout: "user" },
  { name: "od", script: "printf A | od -An -t x1", stdout: "41" },
  { name: "gzip", script: "printf 'gzip-ok\\n' | gzip | gunzip", stdout: "gzip-ok" },
  { name: "gunzip", script: "printf 'gunzip-ok\\n' | gzip | gunzip", stdout: "gunzip-ok" },
  { name: "zcat", script: "printf 'zcat-ok\\n' | gzip | zcat", stdout: "zcat-ok" },
  {
    name: "rm",
    script: "printf doomed > matrix/rm.txt && rm matrix/rm.txt && test ! -e matrix/rm.txt",
  },
];

export const RUOK_SHELL_LIKE_MATRIX: ShellSelfTestCase[] = [
  { name: "pipeline", script: "printf 'c\\nb\\na\\n' | sort | head -n 1", stdout: "a" },
  {
    name: "redirection and append",
    script:
      "printf 'one\\n' > shell-like.txt\nprintf 'two\\n' >> shell-like.txt\ncat shell-like.txt",
    stdout: "one\ntwo",
  },
  { name: "here string", script: "cat <<< 'here-string-ok'", stdout: "here-string-ok" },
  { name: "heredoc", script: "cat <<'EOF'\nheredoc-ok\nEOF", stdout: "heredoc-ok" },
  {
    name: "and-or lists",
    script: "false || echo or-ok\ntrue && echo and-ok",
    stdout: "or-ok\nand-ok",
  },
  {
    name: "variables and export",
    script: 'NAME=nexo\nexport NAME\necho "$NAME"\nprintenv NAME',
    stdout: "nexo\nnexo",
  },
  { name: "command substitution", script: 'echo "sub-$(printf ok)"', stdout: "sub-ok" },
  {
    name: "glob expansion",
    script:
      "mkdir -p glob\nprintf a > glob/a.txt\nprintf b > glob/b.txt\nprintf '%s\\n' glob/*.txt | sort",
    stdout: "glob/a.txt\nglob/b.txt",
  },
  { name: "subshell", script: "(cd src && pwd) && pwd", stdout: "/src\n/" },
  {
    name: "bash -c positional args",
    script: "bash -c 'echo \"$1-$2\"' -- alpha beta",
    stdout: "alpha-beta",
  },
];

export function createRuokSetupScript(baseName: string): string {
  return [
    ...RUOK_FIXTURE_DIRECTORIES.map((path) => `mkdir -p ${joinShellFixturePath(baseName, path)}`),
    ...RUOK_FIXTURE_FILES.map(
      (file) =>
        `printf ${shellPrintfFormat(file.content)} > ${joinShellFixturePath(baseName, file.path)}`,
    ),
  ].join("\n");
}

export function createRuokCleanupCase(baseName: string): ShellSelfTestCase {
  return {
    name: "rm",
    script: createRuokCleanupScript(baseName),
  };
}

export function createRuokCleanupScript(baseName: string): string {
  const target = shellArgQuote(baseName);
  return `rm -rf ${target}\ntest ! -e ${target}`;
}

function joinShellFixturePath(baseName: string, path: string): string {
  return `${baseName}/${path}`.replace(/\/+/g, "/");
}

function shellArgQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellPrintfFormat(value: string): string {
  return `'${value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "%%")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/'/g, "'\\''")}'`;
}

export function truncateRuokOutput(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 500)}...`;
}

export function formatRuokCaseReport(input: {
  group: string;
  index: number;
  total: number;
  item: ShellSelfTestCase;
  ok: boolean;
  durationMs: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  verbose?: boolean;
}): string {
  const status = input.ok ? "PASS" : "FAIL";
  const lines = [
    `ruok: [${input.group} ${input.index + 1}/${input.total}] ${input.item.name} ${status} (${input.durationMs}ms)`,
    `  input: ${formatRuokValue(input.item.script)}`,
  ];
  if (input.item.stdout !== undefined)
    lines.push(`  expect stdout contains: ${formatRuokValue(input.item.stdout)}`);
  if (input.exitCode !== undefined) lines.push(`  exit: ${input.exitCode}`);
  if (input.error) lines.push(`  error: ${formatRuokValue(input.error)}`);
  if (!input.ok || input.verbose) {
    lines.push(`  stdout: ${formatRuokValue(input.stdout || "")}`);
    lines.push(`  stderr: ${formatRuokValue(input.stderr || "")}`);
  } else {
    lines.push(`  stdout: ${formatRuokValue(truncateRuokOutput(input.stdout || ""))}`);
    if (input.stderr) lines.push(`  stderr: ${formatRuokValue(truncateRuokOutput(input.stderr))}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatRuokStats(input: {
  total: number;
  passed: number;
  failed: number;
  commandTotal: number;
  commandPassed: number;
  shellLikeTotal: number;
  shellLikePassed: number;
  durationMs: number;
}): string {
  return (
    [
      "ruok: stats",
      `  total: ${input.total}`,
      `  passed: ${input.passed}`,
      `  failed: ${input.failed}`,
      `  commands: ${input.commandPassed}/${input.commandTotal}`,
      `  shell-like: ${input.shellLikePassed}/${input.shellLikeTotal}`,
      `  durationMs: ${input.durationMs}`,
    ].join("\n") + "\n"
  );
}

function formatRuokValue(value: string): string {
  return JSON.stringify(value.length <= 1000 ? value : `${value.slice(0, 1000)}...`);
}
