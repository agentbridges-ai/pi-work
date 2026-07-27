import type { zhCNCopy } from "./zh-CN.js";

export type UiCopyLanguage = "zh-CN" | "en-US";

type WidenUiCopyValue<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => WidenUiCopyValue<R>
  : T extends string
    ? string
    : T extends number
      ? number
      : T extends boolean
        ? boolean
        : T extends readonly (infer U)[]
          ? readonly WidenUiCopyValue<U>[]
          : T extends object
            ? { readonly [K in keyof T]: WidenUiCopyValue<T[K]> }
            : T;

export type UiCopy = WidenUiCopyValue<typeof zhCNCopy>;

export type DeepPartialUiCopy<T> = {
  [K in keyof T]?: T[K] extends (...args: any[]) => any
    ? T[K]
    : T[K] extends readonly unknown[]
      ? T[K]
      : T[K] extends object
        ? DeepPartialUiCopy<T[K]>
        : T[K];
};
