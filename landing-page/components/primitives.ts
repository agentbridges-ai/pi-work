import { tv } from "tailwind-variants";

export const title = tv({
  base: "inline text-[length:var(--piwork-text-display-size)] font-semibold leading-[var(--piwork-text-display-line-height)] tracking-tight text-foreground",
  variants: {
    size: {
      sm: "text-xl leading-7",
      md: "text-[length:var(--piwork-text-display-size)] leading-[var(--piwork-text-display-line-height)]",
      lg: "text-4xl leading-tight",
    },
    fullWidth: {
      true: "w-full block",
    },
  },
  defaultVariants: {
    size: "md",
  },
});

export const subtitle = tv({
  base: "my-2 block w-full max-w-full text-base leading-6 text-muted-foreground md:w-1/2",
  variants: {
    fullWidth: {
      true: "!w-full",
    },
  },
  defaultVariants: {
    fullWidth: true,
  },
});
