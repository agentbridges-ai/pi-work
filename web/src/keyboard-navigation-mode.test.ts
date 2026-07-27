// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installKeyboardNavigationMode } from "./keyboard-navigation-mode.js";

describe("keyboard navigation mode", () => {
  afterEach(() => {
    delete document.documentElement.dataset.piworkKeyboardNavigation;
  });

  it("activates globally on Tab and deactivates on any pointer press", () => {
    const dispose = installKeyboardNavigationMode(document);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.documentElement.dataset.piworkKeyboardNavigation).toBe("true");

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(document.documentElement.hasAttribute("data-piwork-keyboard-navigation")).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.documentElement.hasAttribute("data-piwork-keyboard-navigation")).toBe(false);

    dispose();
  });

  it("does not activate for non-navigation keys and cleans up its global state", () => {
    const dispose = installKeyboardNavigationMode(document);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(document.documentElement.hasAttribute("data-piwork-keyboard-navigation")).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    dispose();
    expect(document.documentElement.hasAttribute("data-piwork-keyboard-navigation")).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.documentElement.hasAttribute("data-piwork-keyboard-navigation")).toBe(false);
  });
});
