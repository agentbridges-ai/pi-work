import React, { type HTMLAttributes, type ReactNode } from "react";
import { cx } from "./utils";

export type PageLayoutWidth = "content" | "wide" | "full";

export interface PageLayoutProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  width?: PageLayoutWidth;
}

const widthClasses: Record<PageLayoutWidth, string> = {
  content: "max-w-4xl",
  wide: "max-w-7xl",
  full: "max-w-none",
};

export function PageLayout({ children, className, width = "wide", ...props }: PageLayoutProps) {
  return (
    <div
      {...props}
      className={cx(
        "mx-auto flex w-full min-w-0 flex-col gap-[var(--piwork-space-6)] px-[var(--piwork-space-4)] py-[var(--piwork-space-6)]",
        widthClasses[width],
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  actions?: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
}

export function PageHeader({
  actions,
  className,
  description,
  eyebrow,
  title,
  ...props
}: PageHeaderProps) {
  return (
    <header
      {...props}
      className={cx(
        "flex min-w-0 flex-col gap-[var(--piwork-space-4)] border-b border-border pb-[var(--piwork-space-6)] sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0 max-w-3xl">
        {eyebrow ? (
          <div className="mb-[var(--piwork-space-2)] text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-[length:var(--piwork-text-display-size)] font-semibold leading-[var(--piwork-text-display-line-height)] tracking-tight text-foreground">
          {title}
        </h1>
        {description ? (
          <div className="mt-[var(--piwork-space-2)] text-base leading-6 text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}
