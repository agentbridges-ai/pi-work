/** @jsxImportSource react */
import {
  Surface as HeroSurface,
  Toolbar as HeroToolbar,
  type ToolbarProps as HeroToolbarProps,
} from "@heroui/react";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./utils";

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  variant?: "default" | "secondary" | "tertiary" | "transparent";
}

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { children, className, variant = "default", ...props },
  ref,
) {
  return (
    <HeroSurface
      {...props}
      ref={ref}
      className={cn("text-foreground", className)}
      variant={variant}
    >
      {children}
    </HeroSurface>
  );
});

export interface ToolbarProps extends Omit<HeroToolbarProps, "aria-label" | "className"> {
  className?: string;
  label: string;
}

export function Toolbar({
  children,
  className,
  label,
  orientation = "horizontal",
  ...props
}: ToolbarProps) {
  return (
    <HeroToolbar
      {...props}
      aria-label={label}
      className={cn(
        "flex min-h-10 items-center gap-1",
        orientation === "vertical" && "flex-col items-stretch",
        className,
      )}
      orientation={orientation}
    >
      {children}
    </HeroToolbar>
  );
}

export interface AppShellProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}

export const AppShell = forwardRef<HTMLElement, AppShellProps>(function AppShell(
  { children, className, id = "main-content", ...props },
  ref,
) {
  return (
    <main
      {...props}
      ref={ref}
      className={cn("min-h-dvh min-w-0 overflow-hidden bg-background text-foreground", className)}
      id={id}
    >
      {children}
    </main>
  );
});

type PanelAccessibleName =
  { label: string; labelledBy?: never } | { label?: never; labelledBy: string };

export type PanelProps = Omit<
  HTMLAttributes<HTMLElement>,
  "aria-label" | "aria-labelledby" | "children"
> &
  PanelAccessibleName & {
    children: ReactNode;
    variant?: "default" | "secondary" | "tertiary";
  };

const panelVariantClasses: Record<NonNullable<PanelProps["variant"]>, string> = {
  default: "bg-card",
  secondary: "bg-muted",
  tertiary: "bg-background",
};

export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel(
  { children, className, label, labelledBy, variant = "default", ...props },
  ref,
) {
  return (
    <section
      {...props}
      ref={ref}
      aria-label={label}
      aria-labelledby={labelledBy}
      className={cn(
        "min-h-0 min-w-0 overflow-hidden rounded-[var(--piwork-panel-radius)] border border-border text-foreground",
        panelVariantClasses[variant],
        className,
      )}
    >
      {children}
    </section>
  );
});

export interface ScrollAreaProps extends Omit<HTMLAttributes<HTMLDivElement>, "aria-label"> {
  className?: string;
  label: string;
  orientation?: "horizontal" | "vertical";
}

export function ScrollArea({
  children,
  className,
  label,
  orientation = "vertical",
  tabIndex = 0,
  ...props
}: ScrollAreaProps) {
  return (
    <div
      {...props}
      aria-label={label}
      className={cn(
        "min-h-0 min-w-0 overflow-auto outline-none",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        className,
      )}
      data-orientation={orientation}
      role="region"
      tabIndex={tabIndex}
    >
      {children}
    </div>
  );
}
