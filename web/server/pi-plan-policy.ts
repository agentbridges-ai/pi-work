export type PiAgentMode = "agent" | "plan";

export interface PiToolPolicyInput {
  mode: PiAgentMode;
  toolName: string;
  args: unknown;
  mcpReadOnly?: boolean;
}

export interface PiToolPolicyDecision {
  allowed: boolean;
  reason?: string;
  patchedArgs?: Record<string, unknown>;
}

export interface PiPlanBashDecision {
  allowed: boolean;
  reason?: string;
  commands?: string[][];
}

type OptionValueKind = "non-empty" | "non-negative-integer" | "positive-integer";

interface ReadOnlyCommandPolicy {
  shortFlags?: string;
  shortValues?: Readonly<Record<string, OptionValueKind>>;
  longFlags?: readonly string[];
  longValues?: Readonly<Record<string, OptionValueKind>>;
  minOperands?: number;
  maxOperands?: number;
}

/*
 * This is an allowlist, not a list of known-dangerous exceptions. Any option
 * that has not been reviewed here is rejected even when the executable itself
 * is read-only in its usual invocation.
 */
const READ_ONLY_COMMAND_POLICIES: Readonly<Record<string, ReadOnlyCommandPolicy>> = {
  pwd: {
    shortFlags: "LP",
    longFlags: ["logical", "physical"],
    maxOperands: 0,
  },
  ls: {
    shortFlags: "1AaCdfFghiLlnopqRrstux",
  },
  cat: {
    shortFlags: "AbEnstTuv",
    longFlags: [
      "number-nonblank",
      "show-ends",
      "number",
      "squeeze-blank",
      "show-tabs",
      "show-nonprinting",
      "show-all",
    ],
  },
  head: {
    shortFlags: "qv",
    shortValues: { c: "non-empty", n: "non-empty" },
    longFlags: ["quiet", "silent", "verbose"],
    longValues: { bytes: "non-empty", lines: "non-empty" },
  },
  tail: {
    shortFlags: "qv",
    shortValues: { c: "non-empty", n: "non-empty" },
    longFlags: ["quiet", "silent", "verbose"],
    longValues: { bytes: "non-empty", lines: "non-empty" },
  },
  wc: {
    shortFlags: "cLlmw",
    longFlags: ["bytes", "chars", "lines", "max-line-length", "words"],
  },
  stat: {
    shortFlags: "Lft",
    shortValues: { c: "non-empty" },
    longFlags: ["dereference", "file-system", "terse"],
    longValues: { format: "non-empty", printf: "non-empty" },
    minOperands: 1,
  },
  file: {
    shortFlags: "bikL",
    longFlags: ["brief", "keep-going", "mime", "dereference"],
    minOperands: 1,
  },
  du: {
    shortFlags: "achkLmPsx",
    shortValues: { d: "non-negative-integer" },
    longFlags: [
      "all",
      "total",
      "human-readable",
      "kilobytes",
      "dereference-command-line",
      "count-links",
      "megabytes",
      "no-dereference",
      "summarize",
      "one-file-system",
    ],
    longValues: { "max-depth": "non-negative-integer" },
  },
  df: {
    shortFlags: "ahHiklPT",
    longFlags: [
      "all",
      "human-readable",
      "si",
      "inodes",
      "kilobytes",
      "local",
      "portability",
      "print-type",
    ],
  },
  grep: {
    shortFlags: "EFGHhIiLlnoqRrsvVwxZz",
    shortValues: {
      A: "non-negative-integer",
      B: "non-negative-integer",
      C: "non-negative-integer",
      e: "non-empty",
      f: "non-empty",
      m: "positive-integer",
    },
    longFlags: [
      "basic-regexp",
      "extended-regexp",
      "fixed-strings",
      "perl-regexp",
      "with-filename",
      "no-filename",
      "ignore-case",
      "files-with-matches",
      "files-without-match",
      "line-number",
      "only-matching",
      "quiet",
      "silent",
      "recursive",
      "dereference-recursive",
      "no-messages",
      "invert-match",
      "line-regexp",
      "word-regexp",
      "null",
      "null-data",
    ],
    longValues: {
      "after-context": "non-negative-integer",
      "before-context": "non-negative-integer",
      context: "non-negative-integer",
      regexp: "non-empty",
      file: "non-empty",
      "max-count": "positive-integer",
    },
    minOperands: 1,
  },
  rg: {
    shortFlags: "FHILlnNqsuUvwx",
    shortValues: {
      A: "non-negative-integer",
      B: "non-negative-integer",
      C: "non-negative-integer",
      e: "non-empty",
      f: "non-empty",
      g: "non-empty",
      m: "positive-integer",
      t: "non-empty",
      T: "non-empty",
    },
    longFlags: [
      "files",
      "files-with-matches",
      "files-without-match",
      "fixed-strings",
      "hidden",
      "ignore-case",
      "invert-match",
      "line-number",
      "no-filename",
      "no-ignore",
      "no-messages",
      "only-matching",
      "quiet",
      "smart-case",
      "text",
      "trim",
      "unrestricted",
      "with-filename",
      "word-regexp",
    ],
    longValues: {
      "after-context": "non-negative-integer",
      "before-context": "non-negative-integer",
      context: "non-negative-integer",
      regexp: "non-empty",
      file: "non-empty",
      glob: "non-empty",
      "max-count": "positive-integer",
      type: "non-empty",
      "type-not": "non-empty",
    },
  },
  tree: {
    shortFlags: "adfhipsDF",
    shortValues: { L: "non-negative-integer" },
    longFlags: ["dirsfirst", "noreport"],
    longValues: {
      charset: "non-empty",
      filelimit: "non-negative-integer",
    },
  },
  sort: {
    shortFlags: "bdfghiMnrRsuVz",
    shortValues: { k: "non-empty", t: "non-empty" },
    longFlags: [
      "dictionary-order",
      "general-numeric-sort",
      "human-numeric-sort",
      "ignore-case",
      "ignore-leading-blanks",
      "ignore-nonprinting",
      "month-sort",
      "numeric-sort",
      "random-sort",
      "reverse",
      "stable",
      "unique",
      "version-sort",
      "zero-terminated",
    ],
    longValues: {
      "field-separator": "non-empty",
      key: "non-empty",
    },
  },
  uniq: {
    shortFlags: "cdiuDz",
    shortValues: {
      f: "non-negative-integer",
      s: "non-negative-integer",
      w: "positive-integer",
    },
    longFlags: ["count", "repeated", "all-repeated", "ignore-case", "unique", "zero-terminated"],
    longValues: {
      "skip-fields": "non-negative-integer",
      "skip-chars": "non-negative-integer",
      "check-chars": "positive-integer",
    },
    maxOperands: 1,
  },
  cut: {
    shortFlags: "nsz",
    shortValues: {
      b: "non-empty",
      c: "non-empty",
      d: "non-empty",
      f: "non-empty",
    },
    longFlags: ["complement", "only-delimited", "zero-terminated"],
    longValues: {
      bytes: "non-empty",
      characters: "non-empty",
      delimiter: "non-empty",
      fields: "non-empty",
      "output-delimiter": "non-empty",
    },
  },
  tr: {
    shortFlags: "cCdst",
    longFlags: ["complement", "delete", "squeeze-repeats", "truncate-set1"],
    minOperands: 1,
    maxOperands: 2,
  },
  basename: {
    shortFlags: "az",
    shortValues: { s: "non-empty" },
    longFlags: ["multiple", "zero"],
    longValues: { suffix: "non-empty" },
    minOperands: 1,
  },
  dirname: {
    shortFlags: "z",
    longFlags: ["zero"],
    minOperands: 1,
  },
  realpath: {
    shortFlags: "eLmPqsz",
    longFlags: [
      "canonicalize-existing",
      "canonicalize-missing",
      "logical",
      "physical",
      "quiet",
      "strip",
      "zero",
    ],
    longValues: {
      "relative-to": "non-empty",
      "relative-base": "non-empty",
    },
    minOperands: 1,
  },
  readlink: {
    shortFlags: "efmnqsvz",
    longFlags: [
      "canonicalize",
      "canonicalize-existing",
      "canonicalize-missing",
      "no-newline",
      "quiet",
      "silent",
      "verbose",
      "zero",
    ],
    minOperands: 1,
  },
};

const PLAN_NATIVE_TOOLS = new Set(["read", "bash", "ask", "todo_write", "task", "propose_plan"]);

function reject(reason: string): PiPlanBashDecision {
  return { allowed: false, reason };
}

/**
 * Tokenize only the deliberately tiny shell subset accepted in Plan mode.
 * The sole operator is a pipeline. Substitution, variables, redirection,
 * command lists, backgrounding, and ambiguous quoting fail closed.
 */
function tokenizeReadOnlyShell(command: string): PiPlanBashDecision {
  if (
    typeof command !== "string" ||
    command.trim().length === 0 ||
    command.includes("\0") ||
    command.includes("\n") ||
    command.includes("\r")
  ) {
    return reject("Plan mode bash requires one non-empty command line.");
  }
  const commands: string[][] = [[]];
  let token = "";
  let quote: "'" | '"' | null = null;
  const pushToken = (): void => {
    if (token.length > 0) {
      commands.at(-1)!.push(token);
      token = "";
    }
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (char === "\\") {
      return reject("Plan mode bash forbids backslash escaping.");
    }
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && (char === "$" || char === "`")) {
        return reject("Plan mode bash forbids dynamic expansion.");
      }
      token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      pushToken();
      continue;
    }
    if (char === "|") {
      pushToken();
      if (command[index + 1] === "|") {
        return reject("Plan mode bash forbids conditional command lists.");
      }
      if (commands.at(-1)!.length === 0) {
        return reject("Plan mode bash contains an empty pipeline command.");
      }
      commands.push([]);
      continue;
    }
    if (
      char === ">" ||
      char === "<" ||
      char === ";" ||
      char === "&" ||
      char === "`" ||
      char === "$" ||
      char === "(" ||
      char === ")" ||
      char === "{" ||
      char === "}" ||
      char === "#" ||
      char === "!" ||
      char === "*" ||
      char === "?" ||
      char === "[" ||
      char === "]" ||
      char === "~"
    ) {
      return reject(
        "Plan mode bash forbids redirection, expansion, and unclassified shell syntax.",
      );
    }
    token += char;
  }
  if (quote) return reject("Plan mode bash contains ambiguous quoting.");
  pushToken();
  if (commands.at(-1)!.length === 0) {
    return reject("Plan mode bash contains an empty pipeline command.");
  }
  return { allowed: true, commands };
}

function optionValueAllowed(value: string, kind: OptionValueKind): boolean {
  if (kind === "non-empty") return value.length > 0;
  const pattern = kind === "positive-integer" ? /^[1-9]\d*$/u : /^(?:0|[1-9]\d*)$/u;
  return pattern.test(value) && Number.isSafeInteger(Number(value));
}

function rejectOption(executable: string, option: string): PiPlanBashDecision {
  return reject(`Plan mode bash rejects unknown or unsafe option "${option}" for "${executable}".`);
}

function validatePolicyOptions(
  executable: string,
  args: readonly string[],
  policy: ReadOnlyCommandPolicy,
): PiPlanBashDecision {
  let operands = 0;
  let optionsEnded = false;

  const acceptValue = (
    option: string,
    kind: OptionValueKind,
    inlineValue: string | undefined,
    index: number,
  ): { decision?: PiPlanBashDecision; nextIndex: number } => {
    const value = inlineValue ?? args[index + 1];
    const nextIndex = inlineValue === undefined ? index + 1 : index;
    if (value === undefined || !optionValueAllowed(value, kind)) {
      return {
        decision: reject(
          `Plan mode bash requires a valid ${kind.replaceAll("-", " ")} value for "${option}".`,
        ),
        nextIndex,
      };
    }
    return { nextIndex };
  };

  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || token === "-" || !token.startsWith("-")) {
      operands++;
      continue;
    }
    if (token.startsWith("--")) {
      const separator = token.indexOf("=");
      const name = token.slice(2, separator === -1 ? undefined : separator);
      const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
      if (policy.longFlags?.includes(name)) {
        if (inlineValue !== undefined) return rejectOption(executable, token);
        continue;
      }
      const kind = policy.longValues?.[name];
      if (!kind) return rejectOption(executable, token);
      const accepted = acceptValue(`--${name}`, kind, inlineValue, index);
      if (accepted.decision) return accepted.decision;
      index = accepted.nextIndex;
      continue;
    }

    const cluster = token.slice(1);
    if (!cluster) {
      operands++;
      continue;
    }
    for (let position = 0; position < cluster.length; position++) {
      const flag = cluster[position]!;
      if (policy.shortFlags?.includes(flag)) continue;
      const kind = policy.shortValues?.[flag];
      if (!kind) return rejectOption(executable, `-${flag}`);
      const remainder = cluster.slice(position + 1);
      const accepted = acceptValue(`-${flag}`, kind, remainder || undefined, index);
      if (accepted.decision) return accepted.decision;
      index = accepted.nextIndex;
      break;
    }
  }

  if (operands < (policy.minOperands ?? 0) || operands > (policy.maxOperands ?? Infinity)) {
    return reject(`Plan mode bash rejects the operand count for "${executable}".`);
  }
  return { allowed: true };
}

function validateFind(args: readonly string[]): PiPlanBashDecision {
  let parsingExpression = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!parsingExpression && !token.startsWith("-")) continue;
    parsingExpression = true;
    if (token === "-print" || token === "-print0") continue;
    if (token === "-maxdepth" || token === "-mindepth") {
      const value = args[++index];
      if (value === undefined || !optionValueAllowed(value, "non-negative-integer")) {
        return reject(`Plan mode bash requires a non-negative integer for "${token}".`);
      }
      continue;
    }
    if (token === "-type") {
      const value = args[++index];
      if (value !== "f" && value !== "d" && value !== "l") {
        return reject('Plan mode bash permits only "-type f", "-type d", or "-type l".');
      }
      continue;
    }
    if (token === "-name" || token === "-iname" || token === "-path" || token === "-ipath") {
      const value = args[++index];
      if (!value) return reject(`Plan mode bash requires a non-empty value for "${token}".`);
      continue;
    }
    return rejectOption("find", token);
  }
  return { allowed: true };
}

const USER_SPACE_METADATA_POLICIES: Readonly<Record<string, ReadOnlyCommandPolicy>> = {
  pwd: { maxOperands: 0 },
  ls: {
    shortFlags: "1aAdFhlrRSt",
    longFlags: [
      "all",
      "almost-all",
      "directory",
      "classify",
      "human-readable",
      "recursive",
      "reverse",
    ],
  },
  stat: { minOperands: 1 },
  file: { minOperands: 1 },
  du: { minOperands: 1 },
  tree: {
    shortFlags: "adf",
    shortValues: { L: "non-negative-integer" },
  },
  readlink: { minOperands: 1 },
  basename: { minOperands: 1, maxOperands: 1 },
  dirname: { minOperands: 1, maxOperands: 1 },
};

function isRootQualifiedUserSpacePath(value: string): boolean {
  if (
    !value ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.startsWith("user-space:/") ||
    value.includes("\\") ||
    /^[^/]+:\//u.test(value)
  ) {
    return false;
  }
  const parts = value.split("/");
  return (
    parts.length >= 2 && parts.every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function validateUserSpaceRead(args: readonly string[]): PiPlanBashDecision {
  const path = args[0];
  if (path === undefined || !isRootQualifiedUserSpacePath(path)) {
    return reject("Plan mode requires a root-qualified User Space read path.");
  }
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      (option !== "--offset" && option !== "--limit") ||
      seen.has(option) ||
      value === undefined ||
      !optionValueAllowed(value, "positive-integer")
    ) {
      return reject("Plan mode rejects unsupported User Space read arguments.");
    }
    seen.add(option);
  }
  return { allowed: true };
}

function validateUserSpaceMetadata(command: string): PiPlanBashDecision {
  const parsed = tokenizeReadOnlyShell(command);
  if (!parsed.allowed || !parsed.commands) return parsed;
  if (parsed.commands.length !== 1) {
    return reject("Plan mode User Space metadata forbids pipelines and compound shell.");
  }
  const [tokens] = parsed.commands;
  const executable = tokens?.[0];
  if (
    !executable ||
    executable.includes("/") ||
    executable.includes("\\") ||
    executable === "find"
  ) {
    return executable === "find"
      ? validateFind(tokens.slice(1))
      : reject("Plan mode does not recognize this User Space metadata command.");
  }
  const policy = USER_SPACE_METADATA_POLICIES[executable];
  return policy
    ? validatePolicyOptions(executable, tokens.slice(1), policy)
    : reject(`Plan mode does not recognize "${executable}" as User Space metadata.`);
}

function validateUserSpaceCommand(tokens: readonly string[]): PiPlanBashDecision {
  const action = tokens[1];
  const args = tokens.slice(2);
  if (action === "read") return validateUserSpaceRead(args);
  if (action !== "bash") {
    return reject("Plan mode permits only User Space read and metadata traversal.");
  }
  if (args.length === 1 && args[0] === "--capabilities") return { allowed: true };
  if (args.length !== 2 || args[0] !== "--command" || !args[1]) {
    return reject("Plan mode permits only a literal User Space metadata command.");
  }
  return validateUserSpaceMetadata(args[1]);
}

function validateCommand(tokens: string[]): PiPlanBashDecision {
  const executable = tokens[0]!;
  if (executable.includes("/") || executable.includes("\\") || executable.includes("=")) {
    return reject(`Plan mode bash does not recognize "${executable}" as read-only.`);
  }
  if (executable === "user-space") return validateUserSpaceCommand(tokens);
  if (executable === "find") return validateFind(tokens.slice(1));
  const policy = READ_ONLY_COMMAND_POLICIES[executable];
  if (!policy) {
    return reject(`Plan mode bash does not recognize "${executable}" as read-only.`);
  }
  return validatePolicyOptions(executable, tokens.slice(1), policy);
}

export function classifyPlanBash(command: string): PiPlanBashDecision {
  const parsed = tokenizeReadOnlyShell(command);
  if (!parsed.allowed || !parsed.commands) return parsed;
  if (
    parsed.commands.some((tokens) => tokens[0] === "user-space") &&
    parsed.commands.length !== 1
  ) {
    return reject("Plan mode User Space commands cannot be piped or combined.");
  }
  for (const tokens of parsed.commands) {
    const decision = validateCommand(tokens);
    if (!decision.allowed) return decision;
  }
  return { allowed: true, commands: parsed.commands };
}

function blocked(reason: string): PiToolPolicyDecision {
  return { allowed: false, reason };
}

export function evaluatePiToolPolicy(input: PiToolPolicyInput): PiToolPolicyDecision {
  if (input.mode === "agent") return { allowed: true };
  if (input.mode !== "plan") return blocked("Unknown Agent mode.");

  if (input.toolName === "write" || input.toolName === "edit") {
    return blocked(`${input.toolName} is disabled in Plan mode.`);
  }
  if (input.toolName.startsWith("mcp__")) {
    return input.mcpReadOnly === true
      ? { allowed: true }
      : blocked("Plan mode permits only explicitly read-only MCP tools.");
  }
  if (!PLAN_NATIVE_TOOLS.has(input.toolName)) {
    return blocked("Tool is not classified as read-only in Plan mode.");
  }
  if (input.toolName === "task") {
    return { allowed: true, patchedArgs: { readOnly: true } };
  }
  if (input.toolName === "bash") {
    const args =
      typeof input.args === "object" && input.args !== null
        ? (input.args as Record<string, unknown>)
        : null;
    if (!args || typeof args.command !== "string") {
      return blocked("Plan mode bash requires a literal command.");
    }
    const decision = classifyPlanBash(args.command);
    return decision.allowed
      ? { allowed: true }
      : blocked(decision.reason ?? "Plan mode bash command is not read-only.");
  }
  return { allowed: true };
}
