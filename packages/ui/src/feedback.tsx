/** @jsxImportSource react */
import {
  Alert as HeroAlert,
  Chip as HeroChip,
  EmptyState as HeroEmptyState,
  Skeleton as HeroSkeleton,
  type SkeletonProps as HeroSkeletonProps,
} from "@heroui/react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./utils";

export type FeedbackStatus = "info" | "success" | "warning" | "danger";

const alertClasses: Record<FeedbackStatus, string> = {
  info: "border-info bg-info-muted",
  success: "border-success bg-success-muted",
  warning: "border-warning bg-warning-muted",
  danger: "border-danger bg-danger-muted",
};

const statusTextClasses: Record<FeedbackStatus, string> = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

const defaultStatusIcons: Record<FeedbackStatus, ReactNode> = {
  info: <Info aria-hidden="true" className="h-5 w-5" />,
  success: <CircleCheck aria-hidden="true" className="h-5 w-5" />,
  warning: <TriangleAlert aria-hidden="true" className="h-5 w-5" />,
  danger: <CircleAlert aria-hidden="true" className="h-5 w-5" />,
};

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "title"> {
  action?: ReactNode;
  icon?: ReactNode;
  status?: FeedbackStatus;
  title: ReactNode;
}

export function Alert({
  action,
  className,
  icon,
  role,
  status = "info",
  title,
  ...props
}: AlertProps) {
  return (
    <HeroAlert
      {...props}
      aria-live={role === "alert" || status === "danger" ? "assertive" : "polite"}
      className={cn(
        "flex items-start gap-3 rounded-[var(--piwork-panel-radius)] border p-4 text-foreground",
        alertClasses[status],
        className,
      )}
      role={role ?? (status === "danger" ? "alert" : "status")}
      status={status === "info" ? "accent" : status}
    >
      <HeroAlert.Indicator className={cn("mt-0.5 shrink-0", statusTextClasses[status])}>
        {icon === undefined ? defaultStatusIcons[status] : icon}
      </HeroAlert.Indicator>
      <HeroAlert.Content className="min-w-0 flex-1">
        <HeroAlert.Title className="text-sm font-semibold leading-5 text-foreground">
          {title}
        </HeroAlert.Title>
      </HeroAlert.Content>
      {action ? <div className="shrink-0">{action}</div> : null}
    </HeroAlert>
  );
}

export type StatusBadgeStatus = "neutral" | FeedbackStatus;

const badgeClasses: Record<StatusBadgeStatus, string> = {
  neutral: "border-border bg-muted text-foreground",
  info: "border-info bg-info-muted text-info",
  success: "border-success bg-success-muted text-success",
  warning: "border-warning bg-warning-muted text-warning",
  danger: "border-danger bg-danger-muted text-danger",
};

export interface StatusBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  children: ReactNode;
  status?: StatusBadgeStatus;
}

export function StatusBadge({
  children,
  className,
  status = "neutral",
  ...props
}: StatusBadgeProps) {
  return (
    <HeroChip
      {...props}
      className={cn(
        "inline-flex min-h-6 items-center rounded-full border px-2 py-0.5 text-xs font-semibold leading-4",
        badgeClasses[status],
        className,
      )}
      color={status === "info" ? "accent" : status === "neutral" ? "default" : status}
      size="sm"
      variant="soft"
    >
      <HeroChip.Label>{children}</HeroChip.Label>
    </HeroChip>
  );
}

export interface EmptyStateProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "title"
> {
  actions?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
}

export function EmptyState({
  actions,
  className,
  description,
  icon,
  title,
  ...props
}: EmptyStateProps) {
  return (
    <HeroEmptyState
      {...props}
      className={cn(
        "flex min-h-48 flex-col items-start justify-center gap-3 rounded-[var(--piwork-panel-radius)] px-6 py-8",
        "border border-dashed border-border bg-muted text-left",
        className,
      )}
    >
      {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      <div className="max-w-prose">
        <h2 className="text-lg font-semibold leading-6 text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2 pt-1">{actions}</div> : null}
    </HeroEmptyState>
  );
}

export interface SkeletonProps extends Omit<HeroSkeletonProps, "className"> {
  className?: string;
  label: string;
}

export function Skeleton({ className, label, ...props }: SkeletonProps) {
  return (
    <HeroSkeleton
      {...props}
      aria-busy="true"
      aria-label={label}
      className={cn("rounded-[var(--piwork-control-radius)] bg-muted", className)}
      role="status"
    />
  );
}
