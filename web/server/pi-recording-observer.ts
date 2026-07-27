import type { PiRpcFrameObservation } from "./pi-runtime-observer.js";
import type { PiRuntimeObserver } from "./pi-runtime-observer.js";
import type { RecorderManager, RecordingLifecycleEvent } from "./recorder.js";

export interface PiRecordingObserverOptions {
  recorder: RecorderManager;
  /** Root product session whose recording owns root and managed-task frames. */
  recordingSessionId: string;
  cwd: string;
}

function isExtensionFrame(frame: PiRpcFrameObservation): boolean {
  return (
    frame.value.type === "extension_ui_request" ||
    frame.value.type === "extension_ui_response" ||
    frame.value.type === "extension_error"
  );
}

/**
 * Adapts neutral Pi runtime observations to the existing authenticated
 * recording store. Child task frames remain attributable while being archived
 * beneath the root product session.
 */
export function createPiRecordingObserver(options: PiRecordingObserverOptions): PiRuntimeObserver {
  return {
    onFrame: (frame, context) => {
      const meta = {
        runtimeSessionId: context.sessionId,
        generation: context.generation,
      };
      options.recorder.record(
        options.recordingSessionId,
        frame.direction,
        frame.raw,
        "pi-rpc",
        "pi",
        options.cwd,
        meta,
      );
      if (isExtensionFrame(frame)) {
        options.recorder.record(
          options.recordingSessionId,
          frame.direction,
          frame.raw,
          "extension",
          "pi",
          options.cwd,
          meta,
        );
      }
    },
    onLifecycle: (event, context) => {
      options.recorder.recordEvent(
        options.recordingSessionId,
        event.type as RecordingLifecycleEvent,
        "pi-rpc",
        {
          runtimeSessionId: context.sessionId,
          generation: context.generation,
          ...(event.meta ?? {}),
        },
        "pi",
        options.cwd,
      );
    },
  };
}
