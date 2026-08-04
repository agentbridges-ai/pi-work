import type { AxeResults } from "axe-core";

// Augment vitest's Assertion interface with vitest-axe matchers.
// The vitest-axe/extend-expect types target the deprecated Vi namespace,
// so we manually augment @vitest/expect for vitest 4.x.
declare module "@vitest/expect" {
  interface Assertion<T> {
    toHaveNoViolations(): void;
  }
}

// Vitest re-exports Assertion from @vitest/expect. Augmenting the public
// module keeps the matcher visible when tests import the type through Vitest
// globals (the form used by the component suite).
declare module "vitest" {
  interface Assertion<T> {
    toHaveNoViolations(): void;
  }
}
