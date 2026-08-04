/** @jsxImportSource react */
import { Radio as HeroRadio, RadioGroup as HeroRadioGroup, Tabs as HeroTabs } from "@heroui/react";
import { type ReactNode } from "react";
import { cn } from "./utils";

export interface SegmentedControlItem {
  id: string;
  isDisabled?: boolean;
  label: ReactNode;
}

export interface SegmentedControlProps {
  ariaLabel: string;
  className?: string;
  isDisabled?: boolean;
  isEqualWidth?: boolean;
  items: readonly SegmentedControlItem[];
  onChange: (id: string) => void;
  orientation?: "horizontal" | "vertical";
  size?: "sm" | "md";
  value: string;
}

export function SegmentedControl({
  ariaLabel,
  className,
  isDisabled = false,
  isEqualWidth = false,
  items,
  onChange,
  orientation = "horizontal",
  size = "md",
  value,
}: SegmentedControlProps) {
  return (
    <HeroRadioGroup
      aria-label={ariaLabel}
      className={cn(
        "inline-flex border border-border bg-surface-weak",
        size === "sm"
          ? "gap-[3px] rounded-[var(--piwork-control-radius)] p-0.5"
          : "gap-[5px] rounded-[var(--piwork-panel-radius)] p-1",
        orientation === "vertical" && "flex-col",
        className,
      )}
      isDisabled={isDisabled}
      onChange={onChange}
      orientation={orientation}
      value={value}
      variant="primary"
    >
      {items.map((item) => (
        <HeroRadio
          key={item.id}
          className={cn(
            "inline-flex items-center justify-center rounded-[var(--piwork-control-radius)]",
            size === "sm" ? "h-7 min-w-7 px-2 text-xs" : "h-8 min-w-8 px-3 text-sm",
            "font-semibold text-muted-foreground outline-none transition-colors duration-[var(--piwork-duration-feedback)] ease-[var(--piwork-ease-out)]",
            "hover:bg-card hover:text-foreground data-[selected]:bg-card data-[selected]:text-foreground",
            "data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[focus-visible]:ring-offset-2 data-[focus-visible]:ring-offset-surface-weak",
            "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
            isEqualWidth && "flex-1 basis-0",
          )}
          isDisabled={item.isDisabled}
          value={item.id}
        >
          <HeroRadio.Content>{item.label}</HeroRadio.Content>
        </HeroRadio>
      ))}
    </HeroRadioGroup>
  );
}

export interface TabItem {
  content: ReactNode;
  id: string;
  isDisabled?: boolean;
  label: ReactNode;
}

export interface TabsProps {
  ariaLabel: string;
  className?: string;
  defaultSelectedKey?: string;
  items: readonly TabItem[];
  onSelectionChange?: (id: string) => void;
  orientation?: "horizontal" | "vertical";
  selectedKey?: string;
}

export function Tabs({
  ariaLabel,
  className,
  defaultSelectedKey,
  items,
  onSelectionChange,
  orientation = "horizontal",
  selectedKey,
}: TabsProps) {
  return (
    <HeroTabs
      className={cn(
        "flex min-h-0 min-w-0",
        orientation === "vertical" ? "flex-row gap-4" : "flex-col gap-3",
        className,
      )}
      defaultSelectedKey={defaultSelectedKey}
      onSelectionChange={(key) => onSelectionChange?.(String(key))}
      orientation={orientation}
      selectedKey={selectedKey}
      variant="primary"
    >
      <HeroTabs.List
        aria-label={ariaLabel}
        className={cn(
          "flex shrink-0 gap-1 border-border",
          orientation === "vertical" ? "flex-col border-r pr-2" : "border-b pb-1",
        )}
      >
        {items.map((item) => (
          <HeroTabs.Tab
            key={item.id}
            id={item.id}
            className={cn(
              "relative flex h-10 items-center justify-center rounded-[var(--piwork-control-radius)] px-3",
              "text-sm font-semibold text-muted-foreground outline-none transition-colors duration-[var(--piwork-duration-feedback)] ease-[var(--piwork-ease-out)]",
              "hover:bg-muted hover:text-foreground data-[selected]:bg-muted data-[selected]:text-foreground",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            isDisabled={item.isDisabled}
          >
            {item.label}
          </HeroTabs.Tab>
        ))}
      </HeroTabs.List>
      {items.map((item) => (
        <HeroTabs.Panel
          key={item.id}
          id={item.id}
          className="min-h-0 min-w-0 flex-1 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {item.content}
        </HeroTabs.Panel>
      ))}
    </HeroTabs>
  );
}
