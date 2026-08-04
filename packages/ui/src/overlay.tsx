/** @jsxImportSource react */
import { Drawer as HeroDrawer, Modal as HeroModal } from "@heroui/react";
import { X } from "lucide-react";
import { useEffect, useId, useRef, type ElementType, type ReactNode, type RefObject } from "react";
import { cn } from "./utils";

export type DialogSize = "sm" | "md" | "lg";

interface OverlayContentProps {
  bodyClassName?: string;
  children: ReactNode;
  className?: string;
  closeLabel: string;
  description?: ReactNode;
  footer?: ReactNode;
  headerClassName?: string;
  headerTextClassName?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  isDismissable?: boolean;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title: ReactNode;
}

function useInitialFocus(
  isOpen: boolean,
  initialFocusRef: RefObject<HTMLElement | null> | undefined,
) {
  useEffect(() => {
    if (!isOpen || !initialFocusRef) return;
    const frame = window.requestAnimationFrame(() => initialFocusRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [initialFocusRef, isOpen]);
}

function useRestoreFocus(isOpen: boolean) {
  const restoreTargetRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  if (isOpen && !wasOpenRef.current && typeof document !== "undefined") {
    restoreTargetRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpenRef.current = isOpen;

  useEffect(() => {
    if (!isOpen && restoreTargetRef.current) {
      restoreTargetRef.current?.focus();
      restoreTargetRef.current = null;
    }
  }, [isOpen]);

  useEffect(
    () => () => {
      if (wasOpenRef.current) restoreTargetRef.current?.focus();
    },
    [],
  );
}

function useAriaModalAttribute(dialogId: string, isOpen: boolean) {
  useEffect(() => {
    if (!isOpen) return;
    // React Aria makes the surrounding document inert but intentionally omits
    // aria-modal from its Dialog node. Keep the product contract explicit.
    document.getElementById(dialogId)?.setAttribute("aria-modal", "true");
  }, [dialogId, isOpen]);
}

function CloseIcon({ label }: { label: string }) {
  return (
    <>
      <span className="sr-only">{label}</span>
      <X aria-hidden="true" className="h-4 w-4" strokeWidth={1.9} />
    </>
  );
}

const OVERLAY_HEADER_CLASS_NAME =
  "flex flex-row shrink-0 items-start gap-4 border-b border-border px-5 py-4";
const OVERLAY_BODY_CLASS_NAME = "min-h-0 flex-1 overflow-y-auto px-5 py-4";
const OVERLAY_FOOTER_CLASS_NAME =
  "flex shrink-0 flex-wrap justify-end gap-2 border-t border-border bg-card px-5 py-3";
const OVERLAY_CLOSE_TRIGGER_CLASS_NAME = cn(
  "flex h-10 w-10 shrink-0 items-center justify-center bg-transparent! hover:bg-transparent!",
  "text-muted-foreground outline-none transition-colors duration-[var(--piwork-duration-feedback)] ease-[var(--piwork-ease-out)] hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
);

interface OverlayHeaderContentProps {
  closeLabel: string;
  closeTriggerComponent: ElementType;
  description?: ReactNode;
  descriptionId: string;
  headingComponent: ElementType;
  textClassName?: string;
  title: ReactNode;
  titleId: string;
}

function OverlayHeaderContent({
  closeLabel,
  closeTriggerComponent: CloseTrigger,
  description,
  descriptionId,
  headingComponent: Heading,
  textClassName,
  title,
  titleId,
}: OverlayHeaderContentProps) {
  return (
    <>
      <div className={cn("min-w-0 flex-1", textClassName)}>
        <Heading id={titleId} className="text-lg font-semibold leading-6 text-foreground">
          {title}
        </Heading>
        {description ? (
          <p id={descriptionId} className="mt-1 text-sm leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <CloseTrigger
        aria-label={closeLabel}
        className={OVERLAY_CLOSE_TRIGGER_CLASS_NAME}
        type="button"
      >
        <CloseIcon label={closeLabel} />
      </CloseTrigger>
    </>
  );
}

export interface DialogProps extends OverlayContentProps {
  size?: DialogSize;
}

export function Dialog({
  bodyClassName,
  children,
  className,
  closeLabel,
  description,
  footer,
  headerClassName,
  headerTextClassName,
  initialFocusRef,
  isDismissable = true,
  isOpen,
  onOpenChange,
  size = "md",
  title,
}: DialogProps) {
  const descriptionId = useId();
  const dialogId = useId();
  const titleId = useId();
  useInitialFocus(isOpen, initialFocusRef);
  useRestoreFocus(isOpen);
  useAriaModalAttribute(dialogId, isOpen);

  return (
    <HeroModal.Backdrop
      className="fixed inset-0 z-[var(--piwork-z-modal)] flex items-center justify-center bg-overlay px-4 py-6"
      isDismissable={isDismissable}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      variant="opaque"
    >
      <HeroModal.Container placement="center" scroll="inside" size={size}>
        <HeroModal.Dialog
          aria-describedby={description ? descriptionId : undefined}
          aria-labelledby={titleId}
          className={cn(
            "flex max-h-[calc(100dvh-3rem)] w-full flex-col overflow-hidden",
            "rounded-[var(--piwork-panel-radius)] border border-border bg-card text-foreground",
            className,
          )}
          id={dialogId}
        >
          <HeroModal.Header className={cn(OVERLAY_HEADER_CLASS_NAME, headerClassName)}>
            <OverlayHeaderContent
              closeLabel={closeLabel}
              closeTriggerComponent={HeroModal.CloseTrigger}
              description={description}
              descriptionId={descriptionId}
              headingComponent={HeroModal.Heading}
              textClassName={headerTextClassName}
              title={title}
              titleId={titleId}
            />
          </HeroModal.Header>
          <HeroModal.Body className={cn(OVERLAY_BODY_CLASS_NAME, bodyClassName)}>
            {children}
          </HeroModal.Body>
          {footer ? (
            <HeroModal.Footer className={OVERLAY_FOOTER_CLASS_NAME}>{footer}</HeroModal.Footer>
          ) : null}
        </HeroModal.Dialog>
      </HeroModal.Container>
    </HeroModal.Backdrop>
  );
}

export type SheetSide = "left" | "right";

export interface SheetProps extends OverlayContentProps {
  side?: SheetSide;
}

export function Sheet({
  bodyClassName,
  children,
  className,
  closeLabel,
  description,
  footer,
  headerClassName,
  headerTextClassName,
  initialFocusRef,
  isDismissable = true,
  isOpen,
  onOpenChange,
  side = "right",
  title,
}: SheetProps) {
  const descriptionId = useId();
  const dialogId = useId();
  const titleId = useId();
  useInitialFocus(isOpen, initialFocusRef);
  useRestoreFocus(isOpen);
  useAriaModalAttribute(dialogId, isOpen);

  return (
    <HeroDrawer.Backdrop
      className="fixed inset-0 z-[var(--piwork-z-overlay)] bg-overlay"
      isDismissable={isDismissable}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      variant="opaque"
    >
      <HeroDrawer.Content
        className={cn("fixed inset-y-0 w-full max-w-xl", side === "right" ? "right-0" : "left-0")}
        placement={side}
      >
        <HeroDrawer.Dialog
          aria-describedby={description ? descriptionId : undefined}
          aria-labelledby={titleId}
          className={cn(
            "flex h-full w-full flex-col overflow-hidden bg-card text-foreground",
            side === "right" ? "border-l border-border" : "border-r border-border",
            className,
          )}
          id={dialogId}
        >
          <HeroDrawer.Header className={cn(OVERLAY_HEADER_CLASS_NAME, headerClassName)}>
            <OverlayHeaderContent
              closeLabel={closeLabel}
              closeTriggerComponent={HeroDrawer.CloseTrigger}
              description={description}
              descriptionId={descriptionId}
              headingComponent={HeroDrawer.Heading}
              textClassName={headerTextClassName}
              title={title}
              titleId={titleId}
            />
          </HeroDrawer.Header>
          <HeroDrawer.Body className={cn(OVERLAY_BODY_CLASS_NAME, bodyClassName)}>
            {children}
          </HeroDrawer.Body>
          {footer ? (
            <HeroDrawer.Footer className={OVERLAY_FOOTER_CLASS_NAME}>{footer}</HeroDrawer.Footer>
          ) : null}
        </HeroDrawer.Dialog>
      </HeroDrawer.Content>
    </HeroDrawer.Backdrop>
  );
}
