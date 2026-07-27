import { useState } from "react";
import { createClientMessageId, sendToSession } from "../ws.js";
import { uiCopy } from "../ui-copy.js";

export function TaskStopButton({ sessionId, taskId }: { sessionId: string; taskId: string }) {
  const [stopping, setStopping] = useState(false);

  const stopTask = () => {
    if (stopping) return;
    setStopping(true);
    const sent = sendToSession(sessionId, {
      type: "stop_task",
      taskId,
      clientMsgId: createClientMessageId(),
    });
    if (!sent) setStopping(false);
  };

  return (
    <button
      type="button"
      disabled={stopping}
      onClick={stopTask}
      className="rounded-[var(--piwork-control-radius)] border border-danger/40 px-2 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
    >
      {stopping ? uiCopy.timeline.stoppingTask : uiCopy.timeline.stopTask}
    </button>
  );
}
