import {
  InlineUserSpaceRuntime,
  type UserSpaceMetadataIndexAdapter,
  type UserSpaceWorkerRequest,
  type UserSpaceWorkerResponse,
} from "./user-space-runtime.js";
import { TsUserSpaceMetadataIndex } from "./user-space-ts-index.js";

let runtime: InlineUserSpaceRuntime | null = null;

self.addEventListener("message", (event: MessageEvent<UserSpaceWorkerRequest>) => {
  void handleRequest(event.data);
});

async function handleRequest(request: UserSpaceWorkerRequest): Promise<void> {
  try {
    switch (request.type) {
      case "init":
        runtime = new InlineUserSpaceRuntime(
          request.root,
          await createWorkerIndex(request.mountId),
        );
        respond(request.requestId, true, { ok: true });
        return;
      case "rebuild":
        respond(request.requestId, true, await requireRuntime().rebuild());
        return;
      case "addEntries":
        await requireRuntime().addEntries(request.entries);
        respond(request.requestId, true, { ok: true });
        return;
      case "removePath":
        await requireRuntime().removePath(request.path);
        respond(request.requestId, true, { ok: true });
        return;
      case "indexSubtree":
        respond(
          request.requestId,
          true,
          await requireRuntime().indexSubtree(request.path, request.maxDepth),
        );
        return;
      case "clear":
        await requireRuntime().clearIndex();
        respond(request.requestId, true, { ok: true });
        return;
      case "listDir":
        respond(
          request.requestId,
          true,
          await requireRuntime().listDir(
            request.path,
            request.limit,
            request.cursor,
            request.includeHidden,
          ),
        );
        return;
      case "searchPaths":
        respond(
          request.requestId,
          true,
          await requireRuntime().searchPaths(
            request.query,
            request.limit,
            request.cursor,
            request.includeHidden,
          ),
        );
        return;
      case "walkTree":
        respond(
          request.requestId,
          true,
          await requireRuntime().walkTree(request.path, request.options),
        );
        return;
      case "searchContent":
        respond(request.requestId, true, await requireRuntime().searchContent(request.input));
        return;
      case "drop":
        requireRuntime().drop();
        runtime = null;
        respond(request.requestId, true, { ok: true });
        return;
    }
  } catch (error) {
    respond(request.requestId, false, error instanceof Error ? error.message : String(error));
  }
}

function requireRuntime(): InlineUserSpaceRuntime {
  if (!runtime) throw new Error("User space worker is not initialized.");
  return runtime;
}

async function createWorkerIndex(mountId: string): Promise<UserSpaceMetadataIndexAdapter> {
  return TsUserSpaceMetadataIndex.create(mountId);
}

function respond(requestId: number, ok: true, result: unknown): void;
function respond(requestId: number, ok: false, error: string): void;
function respond(requestId: number, ok: boolean, payload: unknown): void {
  const response: UserSpaceWorkerResponse = ok
    ? { requestId, ok: true, result: payload }
    : { requestId, ok: false, error: String(payload) };
  self.postMessage(response);
}
