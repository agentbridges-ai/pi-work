import {
  Description as HeroDescription,
  FieldError as HeroFieldError,
  Input as HeroInput,
  Label as HeroLabel,
  TextArea as HeroTextArea,
  TextField as HeroTextField,
  type InputProps as HeroInputProps,
  type TextAreaProps as HeroTextAreaProps,
  type TextFieldProps as HeroTextFieldProps,
} from "@heroui/react";
import React, { forwardRef, type ReactNode, type Ref } from "react";
import { cn } from "./utils";

interface FieldPresentationProps {
  className?: string;
  description?: ReactNode;
  error?: ReactNode;
  inputClassName?: string;
  isInvalid?: boolean;
  label: ReactNode;
  labelClassName?: string;
}

type FieldRootProps = Omit<HeroTextFieldProps, "children" | "className" | "isInvalid">;

const rootClassName = "flex w-full flex-col gap-1.5";
const labelClassName = "text-sm font-semibold text-foreground";
const inputClassName = cn(
  "w-full rounded-[var(--piwork-control-radius)] border border-input bg-card px-3 text-sm text-foreground",
  "placeholder:text-muted-foreground outline-none transition-colors duration-[var(--piwork-duration-feedback)] ease-[var(--piwork-ease-out)]",
  "hover:border-ring focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  "disabled:cursor-not-allowed disabled:bg-muted disabled:text-disabled-foreground",
  "data-[invalid]:border-danger data-[invalid]:focus-visible:ring-danger",
);

function FieldMessages({
  description,
  error,
}: Pick<FieldPresentationProps, "description" | "error">) {
  return (
    <>
      {description ? (
        <HeroDescription className="text-xs leading-4 text-muted-foreground">
          {description}
        </HeroDescription>
      ) : null}
      {error ? (
        <HeroFieldError className="text-xs leading-4 text-danger">{error}</HeroFieldError>
      ) : null}
    </>
  );
}

export interface TextFieldProps extends FieldRootProps, FieldPresentationProps {
  inputProps?: Omit<HeroInputProps, "className">;
  inputRef?: Ref<HTMLInputElement>;
}

export const TextField = forwardRef<HTMLDivElement, TextFieldProps>(function TextField(
  {
    className,
    description,
    error,
    inputClassName: inputClassNameProp,
    inputProps,
    inputRef,
    isDisabled,
    isInvalid,
    label,
    labelClassName: labelClassNameProp,
    ...props
  },
  ref,
) {
  return (
    <HeroTextField
      {...props}
      ref={ref}
      className={cn(rootClassName, className)}
      isDisabled={isDisabled}
      isInvalid={Boolean(error) || isInvalid}
    >
      <HeroLabel className={cn(labelClassName, labelClassNameProp)}>{label}</HeroLabel>
      <HeroInput
        {...inputProps}
        ref={inputRef}
        className={cn(inputClassName, "h-10 min-h-10", inputClassNameProp)}
        fullWidth
      />
      <FieldMessages description={description} error={error} />
    </HeroTextField>
  );
});

export interface TextAreaProps extends FieldRootProps, FieldPresentationProps {
  textAreaProps?: Omit<HeroTextAreaProps, "className">;
  textAreaRef?: Ref<HTMLTextAreaElement>;
}

export const TextArea = forwardRef<HTMLDivElement, TextAreaProps>(function TextArea(
  {
    className,
    description,
    error,
    inputClassName: inputClassNameProp,
    isDisabled,
    isInvalid,
    label,
    labelClassName: labelClassNameProp,
    textAreaProps,
    textAreaRef,
    ...props
  },
  ref,
) {
  return (
    <HeroTextField
      {...props}
      ref={ref}
      className={cn(rootClassName, className)}
      isDisabled={isDisabled}
      isInvalid={Boolean(error) || isInvalid}
    >
      <HeroLabel className={cn(labelClassName, labelClassNameProp)}>{label}</HeroLabel>
      <HeroTextArea
        {...textAreaProps}
        ref={textAreaRef}
        className={cn(inputClassName, "min-h-24 resize-y py-2.5 leading-5", inputClassNameProp)}
        fullWidth
      />
      <FieldMessages description={description} error={error} />
    </HeroTextField>
  );
});
