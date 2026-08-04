import { Button as HeroButton, type ButtonProps as HeroButtonProps } from "@heroui/react";
import { LoaderCircle } from "lucide-react";
import React, { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";
import { cn } from "./utils";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "touch";

export interface ButtonProps extends Omit<
  HeroButtonProps,
  "children" | "className" | "isPending" | "size" | "variant"
> {
  children: ReactNode;
  className?: string;
  loading?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 min-h-8 px-3 text-sm",
  md: "h-10 min-h-10 px-4 text-sm",
  touch: "h-11 min-h-11 px-4 text-sm",
};

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "border border-input bg-card text-foreground hover:bg-muted",
  tertiary: "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
  ghost: "bg-transparent text-foreground hover:bg-muted",
  danger: "bg-danger text-danger-foreground hover:bg-danger/90",
};

const heroSize: Record<ButtonSize, NonNullable<HeroButtonProps["size"]>> = {
  sm: "sm",
  md: "md",
  touch: "lg",
};

function buttonClassName(size: ButtonSize, variant: ButtonVariant, className?: string): string {
  return cn(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--piwork-control-radius)] font-semibold",
    "transition-[background-color,border-color,color,opacity,transform] duration-[var(--piwork-duration-feedback)] ease-[var(--piwork-ease-out)]",
    "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "data-[pressed]:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
    sizeClasses[size],
    variantClasses[variant],
    className,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { children, className, isDisabled, loading = false, size = "md", variant = "primary", ...props },
  ref,
) {
  return (
    <HeroButton
      {...props}
      ref={ref}
      className={buttonClassName(size, variant, className)}
      isDisabled={isDisabled || loading}
      isPending={loading}
      size={heroSize[size]}
      variant={variant}
    >
      {loading ? (
        <LoaderCircle aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" />
      ) : null}
      {children}
    </HeroButton>
  );
});

export interface ButtonLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children"> {
  children: ReactNode;
  disabled?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  {
    children,
    className,
    disabled = false,
    href,
    onClick,
    size = "md",
    tabIndex,
    variant = "primary",
    ...props
  },
  ref,
) {
  return (
    <a
      {...props}
      ref={ref}
      aria-disabled={disabled || undefined}
      className={cn(
        buttonClassName(size, variant, className),
        disabled && "pointer-events-none cursor-not-allowed opacity-50",
      )}
      href={disabled ? undefined : href}
      onClick={disabled ? undefined : onClick}
      tabIndex={disabled ? -1 : tabIndex}
    >
      {children}
    </a>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, "aria-label" | "children"> {
  children: ReactNode;
  label: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { children, className, label, size = "md", ...props },
  ref,
) {
  return (
    <Button
      {...props}
      ref={ref}
      aria-label={label}
      className={cn(
        size === "sm" ? "w-8 px-0" : size === "touch" ? "w-11 px-0" : "w-10 px-0",
        className,
      )}
      isIconOnly
      size={size}
    >
      {children}
    </Button>
  );
});
