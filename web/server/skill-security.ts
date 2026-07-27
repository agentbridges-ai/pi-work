import { createHash } from "node:crypto";

export interface SkillFileSnapshot {
  path: string;
  content: string;
}
export interface SkillFinding {
  severity: "info" | "warning" | "block";
  code: string;
  path: string;
  detail: string;
}

const BLOCKED_FILE = /(^|\/)(\.env|id_rsa|credentials?|secrets?)(\.|$)/i;
const EXECUTABLE_EXT = /\.(sh|bash|zsh|ps1|exe|dll|dylib|so|wasm|py|js|mjs|cjs)$/i;
const NETWORK_OR_EXEC =
  /\b(curl|wget|nc|ncat|ssh|scp|child_process|subprocess|os\.system|eval\s*\(|exec\s*\()\b/i;
const SECRET_PROMPT = /\b(api[_ -]?key|password|private[_ -]?key|credential|token)\b/i;

export function scanSkillSnapshot(files: SkillFileSnapshot[]) {
  const normalized = files
    .map((file) => ({
      path: file.path.replace(/\\/g, "/").replace(/^\.\//, ""),
      content: file.content,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const findings: SkillFinding[] = [];
  for (const file of normalized) {
    if (!file.path || file.path.startsWith("/") || file.path.split("/").includes("..")) {
      findings.push({
        severity: "block",
        code: "path_escape",
        path: file.path,
        detail: "File path escapes the skill root.",
      });
      continue;
    }
    if (BLOCKED_FILE.test(file.path))
      findings.push({
        severity: "block",
        code: "secret_material",
        path: file.path,
        detail: "Skill packages cannot contain secret material.",
      });
    if (EXECUTABLE_EXT.test(file.path))
      findings.push({
        severity: "warning",
        code: "executable_content",
        path: file.path,
        detail: "Executable content requires administrator review.",
      });
    if (NETWORK_OR_EXEC.test(file.content))
      findings.push({
        severity: "warning",
        code: "network_or_exec",
        path: file.path,
        detail: "Skill requests network or process execution.",
      });
    if (SECRET_PROMPT.test(file.content))
      findings.push({
        severity: "warning",
        code: "secret_request",
        path: file.path,
        detail: "Skill mentions credentials or secrets.",
      });
  }
  if (!normalized.some((file) => /(^|\/)SKILL\.md$/i.test(file.path))) {
    findings.push({
      severity: "block",
      code: "missing_manifest",
      path: "",
      detail: "SKILL.md is required.",
    });
  }
  const digest = createHash("sha256");
  for (const file of normalized) digest.update(`${file.path}\0${file.content}\0`);
  return {
    digest: digest.digest("hex"),
    findings,
    passed: !findings.some((item) => item.severity === "block"),
  };
}
