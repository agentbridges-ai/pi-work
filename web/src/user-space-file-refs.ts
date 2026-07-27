export interface UserSpaceFileReference {
  rootName?: string;
  path: string;
  name: string;
}

interface PreviewRequest {
  seq: number;
  ref: UserSpaceFileReference;
}

const refsBySession = new Map<string, UserSpaceFileReference[]>();
const previewRequestsBySession = new Map<string, PreviewRequest>();
const listeners = new Set<() => void>();
const emptyRefs: UserSpaceFileReference[] = [];
const USER_SPACE_REF_TOKEN_RE = /\[user-space:\/([^\]\r\n]+)\]/g;
let previewSeq = 0;

export type UserSpaceReferenceTextSegment =
  { kind: "text"; text: string } | { kind: "ref"; ref: UserSpaceFileReference };

export function subscribeUserSpaceFileRefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUserSpaceFileRefs(sessionId: string): UserSpaceFileReference[] {
  return refsBySession.get(sessionId) || emptyRefs;
}

export function addUserSpaceFileRef(sessionId: string, ref: UserSpaceFileReference): void {
  const current = refsBySession.get(sessionId) || [];
  if (current.some((item) => item.path === ref.path)) return;
  refsBySession.set(sessionId, [...current, ref]);
  notify();
}

export function removeUserSpaceFileRef(sessionId: string, ref: UserSpaceFileReference): void {
  const current = refsBySession.get(sessionId) || [];
  refsBySession.set(
    sessionId,
    current.filter((item) => item.path !== ref.path),
  );
  notify();
}

export function clearUserSpaceFileRefs(sessionId: string): void {
  if (!refsBySession.has(sessionId) && !previewRequestsBySession.has(sessionId)) return;
  refsBySession.delete(sessionId);
  previewRequestsBySession.delete(sessionId);
  notify();
}

export function requestUserSpaceFilePreview(sessionId: string, ref: UserSpaceFileReference): void {
  previewRequestsBySession.set(sessionId, { seq: ++previewSeq, ref });
  notify();
}

export function getUserSpaceFilePreviewRequest(sessionId: string): PreviewRequest | null {
  return previewRequestsBySession.get(sessionId) || null;
}

export function formatUserSpaceFileRefsForPrompt(refs: UserSpaceFileReference[]): string {
  if (refs.length === 0) return "";
  const lines = refs.map(
    (ref, index) =>
      `${index + 1}. ${ref.name} — CLI path: ${formatUserSpaceCommandPath(ref)} (${formatUserSpaceCliPath(ref)})`,
  );
  const examplePath = JSON.stringify(formatUserSpaceCommandPath(refs[0]));
  return [
    "Referenced user-space files:",
    ...lines,
    "",
    `Use the bash tool (tool name exactly \`bash\`) to run the injected CLI, for example \`user-space read ${examplePath} [--offset N] [--limit N]\`. The path must include the user-space root name shown above and must not start with \`/\`.`,
    `\`user-space\` is a CLI binary, not a Pi tool or Skill invocation. Never emit a tool call named \`user-space read\`, and never use Agent Space read/bash/find for these paths. Never pipe user-space read through sed/head/tail. Text stays remote without checkout. For a non-text blob, use \`user-space bash --command "checkout ${examplePath}"\`; then leave user-space bash and use normal Agent Space tools on the exact session-relative \`shared/...\` path returned by checkout. Return it with \`checkin shared/... ${examplePath}\`; do not use \`/shared\` inside user-space bash or search host paths.`,
  ].join("\n");
}

export function getVisibleUserSpaceReferenceContent(
  content: string,
  displayContent?: string,
): string {
  if (displayContent !== undefined) return displayContent;
  return content;
}

export function formatUserSpaceVisibleContent(
  text: string,
  refs: UserSpaceFileReference[],
): string {
  if (refs.length === 0) return text;
  const tokens = refs.map((ref) => `[${formatUserSpaceCliPath(ref)}]`).join(" ");
  return text.trim().length > 0 ? `${tokens} ${text}` : tokens;
}

export function parseUserSpaceReferenceText(content: string): {
  segments: UserSpaceReferenceTextSegment[];
  refs: UserSpaceFileReference[];
} {
  const segments: UserSpaceReferenceTextSegment[] = [];
  const refs: UserSpaceFileReference[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(USER_SPACE_REF_TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ kind: "text", text: content.slice(lastIndex, index) });
    }

    const path = match[1].replace(/^\/+/, "");
    if (path) {
      const ref = {
        path,
        name: basenameUserSpacePath(path),
      };
      segments.push({ kind: "ref", ref });
      refs.push(ref);
    }
    lastIndex = index + match[0].length;
  }

  if (lastIndex < content.length) {
    segments.push({ kind: "text", text: content.slice(lastIndex) });
  }
  if (segments.length === 0) segments.push({ kind: "text", text: content });

  return { segments, refs: dedupeUserSpaceRefs(refs) };
}

export function formatUserSpaceCommandPath(
  ref: Pick<UserSpaceFileReference, "path" | "rootName">,
): string {
  const normalizedPath = ref.path.replace(/^\/+/, "");
  const normalizedRoot = (ref.rootName || "").replace(/^\/+|\/+$/g, "");
  if (
    !normalizedRoot ||
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  ) {
    return normalizedPath;
  }
  return normalizedPath ? `${normalizedRoot}/${normalizedPath}` : normalizedRoot;
}

export function formatUserSpaceCliPath(
  ref: Pick<UserSpaceFileReference, "path" | "rootName">,
): string {
  const normalizedPath = formatUserSpaceCommandPath(ref);
  return `user-space:/${normalizedPath}`;
}

function dedupeUserSpaceRefs(refs: UserSpaceFileReference[]): UserSpaceFileReference[] {
  const seen = new Set<string>();
  const out: UserSpaceFileReference[] = [];
  for (const ref of refs) {
    const key = ref.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function basenameUserSpacePath(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const name = normalized.split("/").filter(Boolean).pop();
  return name || normalized || path;
}

function notify(): void {
  for (const listener of listeners) listener();
}
