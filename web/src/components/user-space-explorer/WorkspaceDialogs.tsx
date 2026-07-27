import { useEffect, useId, useRef, useState } from "react";
import {
  AlertDialogEngine as AlertDialog,
  ButtonEngine as Button,
  ModalEngine as Modal,
} from "../ui/index.js";
import { uiCopy } from "../../ui-copy.js";
import type { WorkspaceDeleteActionDialog, WorkspaceNameActionDialog } from "./model.js";
import { validateWorkspaceEntryName } from "./workspace-paths.js";

const workspaceCopy = uiCopy.userSpace;
const WORKSPACE_CONTROL_RADIUS_CLASS = "rounded-[var(--piwork-control-radius)]";
const WORKSPACE_PANEL_RADIUS_CLASS = "rounded-[var(--piwork-panel-radius)]";

function WorkspaceConfirmDialog({
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
  busy = false,
  secondaryCancel = false,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
  secondaryCancel?: boolean;
}) {
  const descriptionId = useId();
  return (
    <AlertDialog
      isOpen
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <AlertDialog.Backdrop
        variant="opaque"
        className="z-[var(--piwork-z-modal)]"
        isDismissable={!busy}
        isKeyboardDismissDisabled={busy}
      >
        <AlertDialog.Container placement="center" size="sm">
          <AlertDialog.Dialog
            aria-describedby={descriptionId}
            className={`piwork-superellipse-panel ${WORKSPACE_PANEL_RADIUS_CLASS} border border-border bg-card text-foreground`}
          >
            <AlertDialog.Header>
              <AlertDialog.Heading>{title}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body id={descriptionId} className="text-muted-foreground">
              {description}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                slot="close"
                type="button"
                variant="outline"
                isDisabled={busy}
                className={`flex-1 ${WORKSPACE_CONTROL_RADIUS_CLASS} ${
                  secondaryCancel
                    ? "border border-border bg-secondary text-foreground hover:bg-accent"
                    : ""
                }`}
              >
                {uiCopy.common.cancel}
              </Button>
              <Button
                type="button"
                variant="danger"
                isDisabled={busy}
                onPress={() => void onConfirm()}
                className={`flex-1 ${WORKSPACE_CONTROL_RADIUS_CLASS}`}
              >
                {confirmLabel}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}

export function UnsavedPreviewCloseDialog({
  count,
  fileName,
  onCancel,
  onConfirm,
}: {
  count: number;
  fileName?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const title =
    count > 1 ? workspaceCopy.unsavedClose.titleMany(count) : workspaceCopy.unsavedClose.titleOne;
  const description = fileName
    ? workspaceCopy.unsavedClose.descriptionOne(fileName)
    : workspaceCopy.unsavedClose.descriptionMany(count);
  return (
    <WorkspaceConfirmDialog
      title={title}
      description={description}
      confirmLabel={workspaceCopy.unsavedClose.continueClose}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function MountSwitchConfirmDialog({
  targetName,
  count,
  onCancel,
  onConfirm,
}: {
  targetName: string;
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <WorkspaceConfirmDialog
      title={workspaceCopy.switchConfirm.title}
      description={workspaceCopy.switchConfirm.description(targetName, count)}
      confirmLabel={workspaceCopy.switchConfirm.continueSwitch}
      onCancel={onCancel}
      onConfirm={onConfirm}
      secondaryCancel
    />
  );
}

export function MountUnmountConfirmDialog({
  targetName,
  onCancel,
  onConfirm,
}: {
  targetName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <WorkspaceConfirmDialog
      title={workspaceCopy.unmountConfirm.title}
      description={workspaceCopy.unmountConfirm.description(targetName)}
      confirmLabel={workspaceCopy.unmountConfirm.confirm}
      onCancel={onCancel}
      onConfirm={onConfirm}
      secondaryCancel
    />
  );
}

export function MountNameConflictDialog({
  name,
  existingNames,
  onCancel,
  onConfirm,
}: {
  name: string;
  existingNames: readonly string[];
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const feedbackId = useId();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const nextName = draft.trim();
  const validation = draft ? validateWorkspaceEntryName(nextName) : "";
  const duplicate = existingNames.some(
    (item) => item.trim().toLocaleLowerCase() === nextName.toLocaleLowerCase(),
  );
  const isInvalid = Boolean(validation) || (Boolean(nextName) && duplicate);
  const isAvailable = Boolean(nextName) && !isInvalid;
  const inputAvailabilityClass = isInvalid
    ? "border-danger focus:border-danger focus:ring-danger/25"
    : isAvailable
      ? "border-success focus:border-success focus:ring-success/25"
      : "border-border focus:border-primary focus:ring-primary/25";

  const submit = () => {
    if (!isAvailable) return;
    onConfirm(nextName);
  };

  return (
    <Modal isOpen onOpenChange={(open) => !open && onCancel()}>
      <Modal.Backdrop variant="opaque">
        <Modal.Container placement="center" size="sm">
          <Modal.Dialog
            aria-label={workspaceCopy.mountNameConflictDialog.renameTitle}
            className={`piwork-superellipse-panel w-full max-w-sm overflow-hidden ${WORKSPACE_PANEL_RADIUS_CLASS} border border-border bg-card !p-0 text-foreground`}
          >
            <Modal.Header className="block border-b border-border px-5 py-4">
              <div className="text-sm font-semibold">
                {workspaceCopy.mountNameConflictDialog.renameTitle}
              </div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                {workspaceCopy.mountNameConflictDialog.renameDescription(name)}
              </div>
            </Modal.Header>
            <Modal.Body className="px-5 py-4">
              <label className="sr-only" htmlFor="user-space-mount-name-input">
                {workspaceCopy.mountNameConflictDialog.nameLabel}
              </label>
              <input
                ref={inputRef}
                id="user-space-mount-name-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && isAvailable) submit();
                }}
                aria-label={workspaceCopy.mountNameConflictDialog.nameLabel}
                aria-invalid={isInvalid ? true : undefined}
                aria-describedby={validation || !nextName ? feedbackId : undefined}
                className={`h-9 w-full ${WORKSPACE_CONTROL_RADIUS_CLASS} border bg-background px-3 text-sm font-medium text-foreground outline-none transition-colors focus:ring-2 ${inputAvailabilityClass}`}
              />
              {(validation || !nextName) && (
                <div
                  id={feedbackId}
                  className={`mt-2 text-xs font-medium ${
                    validation ? "text-danger" : "text-muted-foreground"
                  }`}
                  role={validation ? "alert" : "status"}
                  aria-live="polite"
                >
                  {validation || workspaceCopy.mountNameConflictDialog.enterName}
                </div>
              )}
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
              <Button
                slot="close"
                type="button"
                variant="outline"
                className={`${WORKSPACE_CONTROL_RADIUS_CLASS} border border-border bg-secondary text-foreground hover:bg-accent`}
              >
                {uiCopy.common.cancel}
              </Button>
              <Button
                type="button"
                onPress={submit}
                isDisabled={!isAvailable}
                className={WORKSPACE_CONTROL_RADIUS_CLASS}
              >
                {workspaceCopy.mountNameConflictDialog.confirmRename}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

export function WorkspaceNameDialog({
  dialog,
  saving,
  onCancel,
  onConfirm,
}: {
  dialog: WorkspaceNameActionDialog;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (name: string) => void | Promise<void>;
}) {
  const [name, setName] = useState(dialog.initialName);
  const [localError, setLocalError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const errorId = useId();
  const title =
    dialog.kind === "create-folder"
      ? workspaceCopy.createDialog.folderTitle
      : workspaceCopy.createDialog.fileTitle;
  const description = dialog.parentPath
    ? workspaceCopy.createDialog.locationPath(dialog.parentPath)
    : workspaceCopy.createDialog.locationRoot;
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const submit = () => {
    const validation = validateWorkspaceEntryName(name);
    if (validation) {
      setLocalError(validation);
      return;
    }
    void onConfirm(name);
  };
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Modal.Backdrop variant="opaque" isDismissable={!saving}>
        <Modal.Container placement="center" size="sm">
          <Modal.Dialog
            aria-label={title}
            className={`piwork-superellipse-panel w-full max-w-sm overflow-hidden ${WORKSPACE_PANEL_RADIUS_CLASS} border border-border bg-card !p-0 text-foreground`}
          >
            <Modal.Header className="block border-b border-border px-5 py-4">
              <div className="text-sm font-semibold">{title}</div>
              <div
                className="mt-1 truncate text-xs leading-5 text-muted-foreground"
                title={description}
              >
                {description}
              </div>
            </Modal.Header>
            <Modal.Body className="px-5 py-4">
              <label className="sr-only" htmlFor="workspace-entry-name-input">
                {workspaceCopy.createDialog.nameLabel}
              </label>
              <input
                ref={inputRef}
                id="workspace-entry-name-input"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (localError) setLocalError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submit();
                }}
                disabled={saving}
                aria-invalid={localError ? true : undefined}
                aria-describedby={localError ? errorId : undefined}
                className={`h-9 w-full ${WORKSPACE_CONTROL_RADIUS_CLASS} border border-border bg-background px-3 text-sm font-medium text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/25 disabled:opacity-60`}
              />
              {localError && (
                <div id={errorId} className="mt-2 text-xs font-medium text-danger" role="alert">
                  {localError}
                </div>
              )}
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
              <Button
                slot="close"
                type="button"
                variant="outline"
                isDisabled={saving}
                className={`${WORKSPACE_CONTROL_RADIUS_CLASS} border border-border bg-secondary text-foreground hover:bg-accent`}
              >
                {uiCopy.common.cancel}
              </Button>
              <Button
                type="button"
                onPress={submit}
                isDisabled={saving}
                className={WORKSPACE_CONTROL_RADIUS_CLASS}
              >
                {saving ? workspaceCopy.createDialog.processing : uiCopy.common.create}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

export function WorkspaceExtensionRenameConfirmDialog({
  currentName,
  nextName,
  onCancel,
  onConfirm,
}: {
  currentName: string;
  nextName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <WorkspaceConfirmDialog
      title={workspaceCopy.rename.extensionChangeTitle}
      description={workspaceCopy.rename.extensionChangeDescription(currentName, nextName)}
      confirmLabel={workspaceCopy.rename.extensionChangeConfirm}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function WorkspaceDeleteDialog({
  dialog,
  saving,
  onCancel,
  onConfirm,
}: {
  dialog: WorkspaceDeleteActionDialog;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const deleteEntries = dialog.entries?.length
    ? dialog.entries
    : [{ mountId: dialog.mountId, entry: dialog.entry }];
  const title =
    deleteEntries.length > 1
      ? workspaceCopy.deleteDialog.selectionTitle
      : dialog.entry.kind === "directory"
        ? workspaceCopy.deleteDialog.folderTitle
        : workspaceCopy.deleteDialog.fileTitle;
  const description =
    deleteEntries.length > 1
      ? workspaceCopy.deleteDialog.selectionDescription(deleteEntries.length)
      : dialog.entry.kind === "directory"
        ? workspaceCopy.deleteDialog.folderDescription(dialog.entry.path)
        : workspaceCopy.deleteDialog.fileDescription(dialog.entry.path);
  return (
    <WorkspaceConfirmDialog
      title={title}
      description={description}
      confirmLabel={saving ? uiCopy.common.deleting : uiCopy.common.delete}
      onCancel={onCancel}
      onConfirm={onConfirm}
      busy={saving}
      secondaryCancel
    />
  );
}
