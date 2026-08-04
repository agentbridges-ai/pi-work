import React, { useId, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "./utils";

export interface FormSectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  actions?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  title: ReactNode;
}

export function FormSection({
  actions,
  children,
  className,
  description,
  title,
  ...props
}: FormSectionProps) {
  const titleId = useId();
  return (
    <section
      {...props}
      aria-labelledby={titleId}
      className={cx(
        "grid min-w-0 gap-[var(--piwork-space-4)] rounded-[var(--piwork-panel-radius)] border border-border bg-card p-[var(--piwork-space-4)] md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 id={titleId} className="text-base font-semibold leading-6 text-foreground">
          {title}
        </h2>
        {description ? (
          <div className="mt-1 text-sm leading-5 text-muted-foreground">{description}</div>
        ) : null}
      </div>
      <div className="min-w-0 space-y-[var(--piwork-space-4)]">
        {children}
        {actions ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-[var(--piwork-space-4)]">
            {actions}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export interface FilterBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "aria-label"> {
  actions?: ReactNode;
  children: ReactNode;
  label: string;
}

export function FilterBar({ actions, children, className, label, ...props }: FilterBarProps) {
  return (
    <div
      {...props}
      aria-label={label}
      className={cx(
        "flex min-w-0 flex-col gap-[var(--piwork-space-3)] rounded-[var(--piwork-panel-radius)] border border-border bg-card p-[var(--piwork-space-3)] sm:flex-row sm:items-end",
        className,
      )}
      role="search"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-end gap-[var(--piwork-space-3)]">
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
