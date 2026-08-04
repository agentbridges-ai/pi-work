import { Switch as HeroSwitch, type SwitchProps as HeroSwitchProps } from "@heroui/react";
import React, { forwardRef, useId, type ComponentRef, type ReactNode } from "react";
import { cn } from "./utils";

export interface SwitchProps extends Omit<
  HeroSwitchProps,
  "aria-describedby" | "aria-label" | "aria-labelledby" | "children" | "className"
> {
  className?: string;
  description?: ReactNode;
  label: ReactNode;
}

export const Switch = forwardRef<ComponentRef<typeof HeroSwitch>, SwitchProps>(function Switch(
  { className, description, label, size = "md", ...props },
  ref,
) {
  const labelId = useId();
  const descriptionId = useId();

  return (
    <HeroSwitch
      {...props}
      ref={ref}
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={labelId}
      className={cn(
        "piwork-switch-contrast group flex min-h-10 items-center justify-between gap-4 rounded-[var(--piwork-control-radius)]",
        "outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[focus-visible]:ring-offset-2 data-[focus-visible]:ring-offset-background",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        className,
      )}
      size={size}
    >
      <HeroSwitch.Content className="min-w-0 flex-1">
        <span id={labelId} className="block text-sm font-semibold leading-5 text-foreground">
          {label}
        </span>
        {description ? (
          <span id={descriptionId} className="mt-0.5 block text-xs leading-4 text-muted-foreground">
            {description}
          </span>
        ) : null}
      </HeroSwitch.Content>
      <HeroSwitch.Control className="shrink-0 border border-input">
        <HeroSwitch.Thumb />
      </HeroSwitch.Control>
    </HeroSwitch>
  );
});
