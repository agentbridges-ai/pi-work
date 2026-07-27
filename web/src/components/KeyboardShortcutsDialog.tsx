import { Dialog } from "./ui/index.js";
import { uiCopy } from "../ui-copy.js";

type Shortcut = {
  description?: string;
  id: string;
  label: string;
  keys: string[][];
};

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

function ShortcutKeys({ alternatives }: { alternatives: string[][] }) {
  return (
    <div className="flex shrink-0 flex-wrap justify-end gap-2" aria-hidden="true">
      {alternatives.map((keys) => (
        <kbd
          key={keys.join("+")}
          className="inline-flex min-h-7 items-center gap-1 rounded-[var(--piwork-control-radius)] border border-b-2 border-border bg-muted px-2 text-xs font-semibold leading-none text-muted-foreground"
        >
          {keys.map((key) => (
            <span key={key}>{key}</span>
          ))}
        </kbd>
      ))}
    </div>
  );
}

export function KeyboardShortcutsDialog({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const copy = uiCopy.chat.keyboardShortcuts;
  const commandKey = isMacPlatform() ? copy.keys.command : copy.keys.control;
  const sections = [
    {
      id: "workspace",
      title: copy.sections.workspace,
      shortcuts: [
        {
          id: "session-search",
          label: copy.actions.sessionSearch,
          keys: [[commandKey, copy.keys.k]],
        },
        {
          id: "file-search",
          label: copy.actions.fileSearch,
          keys: [[commandKey, copy.keys.shift, copy.keys.f]],
        },
        {
          id: "file-preview",
          label: copy.actions.toggleFilePreview,
          keys: [[commandKey, copy.keys.shift, copy.keys.p]],
        },
        {
          id: "session-panel",
          label: copy.actions.toggleSessionPanel,
          description: copy.conditions.filePreviewOpen,
          keys: [[commandKey, copy.keys.shift, copy.keys.b]],
        },
        {
          id: "space-panel",
          label: copy.actions.toggleSpacePanel,
          description: copy.conditions.filePreviewOpen,
          keys: [[commandKey, copy.keys.shift, copy.keys.u]],
        },
      ] satisfies Shortcut[],
    },
    {
      id: "chat",
      title: copy.sections.chat,
      shortcuts: [
        {
          id: "new-line",
          label: copy.actions.newLine,
          keys: [[copy.keys.enter]],
        },
        {
          id: "send-message",
          label: copy.actions.sendMessage,
          keys: [[copy.keys.shift, copy.keys.enter]],
        },
        {
          id: "plan-mode",
          label: copy.actions.togglePlanMode,
          keys: [[copy.keys.shift, copy.keys.tab]],
        },
        {
          id: "shortcut-reference",
          label: copy.actions.openShortcutReference,
          keys: [[commandKey, copy.keys.slash]],
        },
      ] satisfies Shortcut[],
    },
  ];

  return (
    <Dialog
      bodyClassName="px-4 pb-5 pt-4 sm:px-6 sm:pb-6"
      className="max-w-[52rem]"
      closeLabel={copy.close}
      headerClassName="border-b-0 px-4 pb-2 pt-5 sm:px-6 sm:pt-6"
      headerTextClassName="pt-1"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="lg"
      title={copy.title}
    >
      <div className="space-y-6" data-testid="keyboard-shortcuts-list">
        {sections.map((section) => (
          <section key={section.id} aria-labelledby={`keyboard-shortcuts-${section.id}`}>
            <h3
              id={`keyboard-shortcuts-${section.id}`}
              className="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
            >
              {section.title}
            </h3>
            <div className="divide-y divide-border/70">
              {section.shortcuts.map((shortcut) => (
                <div
                  key={shortcut.id}
                  className="flex min-h-12 items-center justify-between gap-4 rounded-[var(--piwork-control-radius)] px-1 py-2 sm:px-2"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">
                      {shortcut.label}
                    </span>
                    {shortcut.description ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {shortcut.description}
                      </span>
                    ) : null}
                  </span>
                  <ShortcutKeys alternatives={shortcut.keys} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
