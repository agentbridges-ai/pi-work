import { describe, expect, it } from "vitest";
import type { CurrentUser } from "../api.js";
import type { InteractionRequest, PiSessionInfo, UserSpaceMount } from "../types.js";
import {
  getLifecycleState,
  getSessionDisplayMeta,
  getSessionSortPriority,
  getSessionSystemState,
  getUserInitials,
  sameUserSpaceMounts,
  toUserSpaceMetadata,
  userSpaceSyncKey,
} from "./chat-view-session-utils.js";

describe("chat session view helpers", () => {
  it("derives lifecycle and display state", () => {
    const session = { state: "exited" } as PiSessionInfo;
    expect(getLifecycleState(session)).toBe("closed");
    expect(
      getSessionSystemState(session, {
        isRunning: false,
        needsConfirmation: false,
        isCompacting: false,
      }),
    ).toBe("idle");
  });

  it("prioritizes running and confirmation sessions", () => {
    const interactions = new Map<string, Map<string, InteractionRequest>>([
      [
        "question",
        new Map([
          [
            "request",
            {
              id: "request",
              kind: "ask",
              toolCallId: "tool-1",
              questions: [
                {
                  id: "question-0",
                  question: "Choose",
                  options: [],
                  allowMultiple: false,
                  allowFreeText: true,
                },
              ],
            },
          ],
        ]),
      ],
    ]);
    const confirmation = getSessionDisplayMeta("question", new Map(), interactions, new Map());
    const running = getSessionDisplayMeta(
      "running",
      new Map(),
      new Map(),
      new Map([["running", true]]),
    );
    expect(confirmation.needsConfirmation).toBe(true);
    expect(getSessionSortPriority(running)).toBeLessThan(getSessionSortPriority(confirmation));
  });

  it("formats user initials", () => {
    expect(getUserInitials({ displayName: "测试用户" } as CurrentUser)).toBe("测试");
    expect(getUserInitials({ displayName: "", username: "alice" } as CurrentUser)).toBe("AL");
  });

  it("normalizes User Space metadata and comparison keys", () => {
    const mount = {
      mountId: "mount-1",
      name: "Files",
      rootName: "Files",
      status: "mounted",
      access: "readwrite",
      canRead: true,
      canWrite: true,
      permissionState: "granted",
      includeHidden: true,
    } as UserSpaceMount;
    expect(toUserSpaceMetadata([mount])).toMatchObject({ mountId: "mount-1", includeHidden: true });
    expect(sameUserSpaceMounts([mount], [{ ...mount }])).toBe(true);
    expect(userSpaceSyncKey([mount])).toBe("mount-1:mounted:readwrite");
  });
});
