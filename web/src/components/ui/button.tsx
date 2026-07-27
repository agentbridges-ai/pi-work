import { Button as HeroButton, type ButtonProps as HeroButtonProps } from "@heroui/react";
import { LoaderCircle } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import { cn } from "./utils.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
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
  ghost: "bg-transparent text-foreground hover:bg-muted",
  danger: "bg-danger text-danger-foreground hover:bg-danger/90",
};

const heroSize: Record<ButtonSize, NonNullable<HeroButtonProps["size"]>> = {
  sm: "sm",
  md: "md",
  touch: "lg",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { children, className, isDisabled, loading = false, size = "md", variant = "primary", ...props },
  ref,
) {
  return (
    <HeroButton
      {...props}
      ref={ref}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--piwork-control-radius)] font-semibold",
        "transition-[background-color,border-color,color,opacity,transform] duration-[var(--piwork-duration-feedback)] ease-[var(--piwork-ease-out)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "data-[pressed]:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
        sizeClasses[size],
        variantClasses[variant],
        className,
      )}
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
