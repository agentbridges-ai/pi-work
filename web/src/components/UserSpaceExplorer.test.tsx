// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";
import { useState } from "react";
import releaseManifest from "../../../release/onlyoffice-release-manifest.json";
import type { UserSpaceMount } from "../types.js";
import { setUiCopyLanguage, uiCopy } from "../ui-copy.js";

const mockExecuteUserSpaceOperation = vi.fn();
const mockGetUserSpaceFile = vi.fn();
const mockSubscribeUserSpace = vi.fn();
const mockMountUserSpace = vi.fn();
const mockRemountUserSpace = vi.fn();
const mockRestorePersistedUserSpace = vi.fn();
const mockSaveUserSpaceFile = vi.fn();
const mockSyncUserSpaceMetadata = vi.fn();
const mockUpdateUserSpaceAccess = vi.fn();
const mockAttachUserSpaceMountsToSession = vi.fn();
const mockDetachUserSpaceFromSession = vi.fn();
const mockDiscardUnattachedUserSpaceMount = vi.fn();
const mockRenameUserSpaceMount = vi.fn();
const mockConfigureUserSpace = vi.fn();
const mockGetAgentSpaceTree = vi.fn();
const mockGetAgentSpaceFile = vi.fn();
const mockDeleteAgentSpaceEntry = vi.fn();
const mockMoveAgentSpaceEntries = vi.fn();
const mockTransferUserToAgent = vi.fn();
const mockTransferAgentToUser = vi.fn();
const {
  mockCreateOfficeEditor,
  mockOfficeEditorDestroy,
  mockWtermWrite,
  mockWtermResize,
  mockWtermFocus,
  mockPlanOfficeResourcesForFile,
  mockApplyOfficeResourcePlan,
  mockOfficeResourcesReadyForRelease,
} = vi.hoisted(() => ({
  mockCreateOfficeEditor: vi.fn(),
  mockOfficeEditorDestroy: vi.fn(),
  mockWtermWrite: vi.fn(),
  mockWtermResize: vi.fn(),
  mockWtermFocus: vi.fn(),
  mockPlanOfficeResourcesForFile: vi.fn(),
  mockApplyOfficeResourcePlan: vi.fn(),
  mockOfficeResourcesReadyForRelease: vi.fn(),
}));

const mountedWorkspace = {
  mountId: "uw-mounted",
  name: "Client Files",
  rootName: "Client Files",
  status: "mounted" as const,
  access: "readwrite" as const,
  includeHidden: true as const,
};
const persistenceScope = { userId: "better-auth-user-a", tenantId: "tenant-a" };

let mockSnapshot: {
  supported: boolean;
  mounts: UserSpaceMount[];
  indexing: Record<string, unknown>;
  recentOperations: unknown[];
  recentFileChanges?: unknown[];
} = {
  supported: true,
  mounts: [mountedWorkspace],
  indexing: {},
  recentOperations: [],
  recentFileChanges: [],
};

function createDefaultFilePreviewDefaults() {
  return {
    html: "preview",
    markdown: "preview",
    word: "preview",
    ppt: "preview",
    excel: "preview",
  };
}

let mockFilePreviewDefaults = createDefaultFilePreviewDefaults();
let mockUserSpacePreferences = {
  showHiddenEntries: false,
  searchHiddenEntries: false,
};
let mockThemeMode: "system" | "light" | "dark" = "system";

const rootEntries = [
  { name: "docs", path: "docs", kind: "directory" as const },
  { name: ".git", path: ".git", kind: "directory" as const },
  { name: ".env.local", path: ".env.local", kind: "file" as const, size: 16 },
  { name: "README.md", path: "README.md", kind: "file" as const, size: 14 },
  { name: "index.html", path: "index.html", kind: "file" as const, size: 42 },
  {
    name: "Dockerfile.server",
    path: "Dockerfile.server",
    kind: "file" as const,
    size: 32,
    previewKind: "text" as const,
    supportsLineEdit: true,
  },
  {
    name: "app.ts",
    path: "app.ts",
    kind: "file" as const,
    size: 26,
    previewKind: "text" as const,
    supportsLineEdit: true,
  },
  { name: "package-lock.json", path: "package-lock.json", kind: "file" as const, size: 82000 },
  { name: "big.txt", path: "big.txt", kind: "file" as const, size: 32000 },
  { name: "archive.zip", path: "archive.zip", kind: "file" as const, size: 128 },
  { name: "report.docx", path: "report.docx", kind: "file" as const, size: 12 },
  { name: "manual.pdf", path: "manual.pdf", kind: "file" as const, size: 12 },
];

function createDomRect({
  x,
  y,
  width,
  height,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return {
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function mockElementFromPoint(element: Element | null) {
  const mock = vi.fn(() => element);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: mock,
  });
  return mock;
}

function dispatchWindowPointerDragEvent(
  type: "pointermove" | "pointerup",
  init: { clientX: number; clientY: number; pointerId?: number },
) {
  act(() => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: init.clientX,
      clientY: init.clientY,
    }) as PointerEvent;
    Object.defineProperties(event, {
      pointerId: { value: init.pointerId ?? 1 },
      isPrimary: { value: true },
    });
    window.dispatchEvent(event);
  });
}

function dispatchElementPointerDown(
  element: Element,
  init: { clientX: number; clientY: number; pointerId?: number; button?: number },
) {
  act(() => {
    const event = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: init.button ?? 0,
      clientX: init.clientX,
      clientY: init.clientY,
    }) as PointerEvent;
    Object.defineProperties(event, {
      pointerId: { value: init.pointerId ?? 1 },
      isPrimary: { value: true },
    });
    element.dispatchEvent(event);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function mockElementRect(
  element: Element,
  rect: { x: number; y: number; width: number; height: number },
) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: vi.fn(() => createDomRect(rect)),
  });
}

function createMockDataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "uninitialized",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: vi.fn((format?: string) => {
      if (format) data.delete(format);
      else data.clear();
    }),
    getData: vi.fn((format: string) => data.get(format) || ""),
    setData: vi.fn((format: string, value: string) => {
      data.set(format, value);
    }),
    setDragImage: vi.fn(),
  } as DataTransfer;
}

function createMockDetachedPreviewWindow() {
  const popoutDocument = document.implementation.createHTMLDocument("Detached preview");
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const emit = (type: string) => {
    const event = new Event(type);
    for (const listener of listeners.get(type) || []) {
      if (typeof listener === "function") listener.call(popoutWindow, event);
      else listener.handleEvent(event);
    }
  };
  const popoutWindow = {
    closed: false,
    document: popoutDocument,
    close: vi.fn(() => {
      if (popoutWindow.closed) return;
      emit("beforeunload");
      popoutWindow.closed = true;
    }),
    focus: vi.fn(),
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      const set = listeners.get(type) || new Set<EventListenerOrEventListenerObject>();
      set.add(listener);
      listeners.set(type, set);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.get(type)?.delete(listener);
    }),
    emit,
  } as unknown as Window & {
    closed: boolean;
    close: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    emit: (type: string) => void;
  };
  return { popoutDocument, popoutWindow };
}

function expectFileIcon(element: Element | null, className: string) {
  expect(element).toBeInstanceOf(SVGElement);
  expect(element).toHaveClass(className);
}

vi.mock("../store.js", () => ({
  useStore: (
    selector: (state: {
      themeMode: typeof mockThemeMode;
      sessions: Map<string, { userSpaces: typeof mockSnapshot.mounts; cwd: string }>;
      runtimeSessions: Array<{ sessionId: string; backendType?: string; cwd?: string }>;
      preferences: {
        filePreviewDefaults: typeof mockFilePreviewDefaults;
        userSpace: typeof mockUserSpacePreferences;
        updatedAt: string;
      };
    }) => unknown,
  ) =>
    selector({
      themeMode: mockThemeMode,
      sessions: new Map([["s1", { userSpaces: mockSnapshot.mounts, cwd: "/work/daily-support" }]]),
      runtimeSessions: [{ sessionId: "s1", backendType: "pi", cwd: "/work/daily-support" }],
      preferences: {
        filePreviewDefaults: mockFilePreviewDefaults,
        userSpace: mockUserSpacePreferences,
        updatedAt: "",
      },
    }),
}));

vi.mock("../user-space.js", () => ({
  attachUserSpaceMountsToSession: (...args: unknown[]) =>
    mockAttachUserSpaceMountsToSession(...args),
  detachUserSpaceFromSession: (...args: unknown[]) => mockDetachUserSpaceFromSession(...args),
  discardUnattachedUserSpaceMount: (...args: unknown[]) =>
    mockDiscardUnattachedUserSpaceMount(...args),
  executeUserSpaceOperation: (...args: unknown[]) => mockExecuteUserSpaceOperation(...args),
  getUserSpaceFile: (...args: unknown[]) => mockGetUserSpaceFile(...args),
  getUserSpaceSnapshot: () => mockSnapshot,
  isUserSpacePickerAbort: (error: unknown) =>
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError",
  mountUserSpace: (...args: unknown[]) => mockMountUserSpace(...args),
  remountUserSpace: (...args: unknown[]) => mockRemountUserSpace(...args),
  renameUserSpaceMount: (...args: unknown[]) => mockRenameUserSpaceMount(...args),
  resendSessionUserSpaces: vi.fn(),
  restorePersistedUserSpace: (...args: unknown[]) => mockRestorePersistedUserSpace(...args),
  saveUserSpaceFile: (...args: unknown[]) => mockSaveUserSpaceFile(...args),
  subscribeUserSpace: (...args: unknown[]) => mockSubscribeUserSpace(...args),
  syncUserSpaceMetadata: (...args: unknown[]) => mockSyncUserSpaceMetadata(...args),
  updateUserSpaceAccess: (...args: unknown[]) => mockUpdateUserSpaceAccess(...args),
}));

vi.mock("./ImageEditorSurface.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ImageEditorSurface: React.forwardRef(function MockImageEditorSurface(
      props: {
        fileName: string;
        mimeType: "image/png" | "image/jpeg" | "image/webp";
        onDirtyChange: (dirty: boolean) => void;
        onReadyChange?: (ready: boolean) => void;
        zoomScale?: number;
      },
      ref,
    ) {
      React.useImperativeHandle(ref, () => ({
        exportFile: async () =>
          new File(["edited-image"], props.fileName, { type: props.mimeType }),
      }));
      React.useEffect(() => {
        props.onReadyChange?.(true);
        return () => props.onReadyChange?.(false);
      }, [props.onReadyChange]);
      return (
        <div data-testid="image-editor-surface" data-zoom-scale={props.zoomScale}>
          <button type="button" onClick={() => props.onDirtyChange(true)}>
            mock image edit
          </button>
        </div>
      );
    }),
  };
});

vi.mock("../api.js", () => ({
  api: {
    configureUserSpace: (...args: unknown[]) => mockConfigureUserSpace(...args),
    getAgentSpaceTree: (...args: unknown[]) => mockGetAgentSpaceTree(...args),
    getAgentSpaceFile: (...args: unknown[]) => mockGetAgentSpaceFile(...args),
    deleteAgentSpaceEntry: (...args: unknown[]) => mockDeleteAgentSpaceEntry(...args),
    moveAgentSpaceEntries: (...args: unknown[]) => mockMoveAgentSpaceEntries(...args),
    transferUserToAgent: (...args: unknown[]) => mockTransferUserToAgent(...args),
    transferAgentToUser: (...args: unknown[]) => mockTransferAgentToUser(...args),
  },
}));

vi.mock("../user-space-configuration.js", () => ({
  captureUserSpaceConfigurationContext: () => ({
    userId: "test-user",
    userScopeKey: "test-scope",
    agentId: "test-agent",
    sessionId: "s1",
    epoch: 1,
  }),
  configureUserSpaceLatest: (intent: {
    context: { sessionId: string };
    userSpace: unknown;
    activeMountId?: string;
    onSuccess?: (result: unknown) => void;
    onError?: (error: unknown) => void;
  }) => {
    const request = intent.activeMountId
      ? mockConfigureUserSpace(intent.context.sessionId, intent.userSpace, intent.activeMountId)
      : mockConfigureUserSpace(intent.context.sessionId, intent.userSpace);
    void request.then(intent.onSuccess, intent.onError);
    return 1;
  },
}));

vi.mock("@agentbridges-ai/onlyoffice-browser", () => ({
  createOfficeEditor: (...args: unknown[]) => mockCreateOfficeEditor(...args),
  mountOfficeEditor: (container: HTMLElement, options: unknown) => {
    const id = `mock-office-mount-${Math.random().toString(36).slice(2)}`;
    const iframe = document.createElement("iframe");
    iframe.className = "office-editor-host-frame mock-onlyoffice-host-shell";
    container.replaceChildren(iframe);
    let activation: Promise<unknown> | null = null;
    let instance: { destroy(): Promise<void> } | null = null;
    return {
      id,
      activate: () => {
        activation ??= mockCreateOfficeEditor(container, options).then((nextInstance: unknown) => {
          instance = nextInstance as { destroy(): Promise<void> };
          return nextInstance;
        });
        return activation;
      },
      destroy: async () => {
        if (instance) await instance.destroy();
        else iframe.remove();
      },
      getState: () => ({
        id,
        origin: `https://${id}.office-host.test`,
        phase: instance ? "ready" : iframe.isConnected ? "waiting-for-activation" : "destroyed",
      }),
    };
  },
  getActiveOfficeEditorCount: () => 0,
  loadOfficeEditorApi: () => Promise.resolve(),
}));

vi.mock("../office-runtime-resources.js", () => ({
  applyOfficeResourcePlan: (...args: unknown[]) => mockApplyOfficeResourcePlan(...args),
  ensureOfficeResources: vi.fn(async () => ({})),
  getTargetOfficeReleaseId: vi.fn(() => "test-release"),
  getVerifiedOfficeFontPaths: vi.fn(() => []),
  officeResourcesNeedAttention: vi.fn(() => false),
  officeResourcesReadyForRelease: (...args: unknown[]) =>
    mockOfficeResourcesReadyForRelease(...args),
  planOfficeResourcesForFile: (...args: unknown[]) => mockPlanOfficeResourcesForFile(...args),
  requestOfficeResourceSettings: vi.fn(),
}));

vi.mock("@wterm/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Terminal: React.forwardRef(function MockTerminal(
      props: {
        className?: string;
        style?: React.CSSProperties;
        autoResize?: boolean;
        cursorBlink?: boolean;
        theme?: string;
        onReady?: () => void;
        onData?: (data: string) => void;
        "data-testid"?: string;
      },
      ref,
    ) {
      const elementRef = React.useRef<HTMLDivElement | null>(null);
      React.useImperativeHandle(ref, () => ({
        write: mockWtermWrite,
        resize: mockWtermResize,
        focus: mockWtermFocus,
        instance: {
          cols: 88,
          rows: 24,
          element: elementRef.current,
        },
      }));
      React.useEffect(() => {
        props.onReady?.();
      }, [props.onReady]);
      const style = props.style as
        (React.CSSProperties & Record<string, string | number | undefined>) | undefined;
      return React.createElement(
        "div",
        {
          ref: elementRef,
          className: props.className,
          style: props.style,
          "data-testid": props["data-testid"] || "mock-wterm-terminal",
          "data-term-bg": style?.["--term-bg"],
          "data-term-fg": style?.["--term-fg"],
          "data-border-radius": style?.borderRadius,
          "data-box-shadow": style?.boxShadow,
          "data-box-sizing": style?.boxSizing,
          "data-padding": style?.padding,
          "data-height": style?.height,
          "data-auto-resize": props.autoResize ? "true" : "false",
          "data-cursor-blink": props.cursorBlink ? "true" : "false",
          "data-theme": props.theme,
          role: "textbox",
          onInput: (event: React.FormEvent<HTMLDivElement>) => {
            props.onData?.(event.currentTarget.textContent || "");
          },
        },
        React.createElement("textarea", {
          "aria-hidden": "true",
          "data-testid": "mock-wterm-textarea",
        }),
      );
    }),
  };
});

vi.mock("@uiw/react-codemirror", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    default: ({
      value = "",
      onChange,
      onCreateEditor,
      readOnly,
      editable,
      basicSetup,
      extensions,
      className,
    }: {
      value?: string;
      onChange?: (value: string) => void;
      onCreateEditor?: (view: unknown) => void;
      readOnly?: boolean;
      editable?: boolean;
      basicSetup?: Record<string, unknown>;
      extensions?: unknown[];
      className?: string;
    }) => {
      const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
      const valueRef = React.useRef(value);
      const onChangeRef = React.useRef(onChange);
      const selectionRef = React.useRef({ from: 0, to: 0 });
      valueRef.current = value;
      onChangeRef.current = onChange;
      const viewRef = React.useRef<{
        state: {
          doc: { toString: () => string };
          selection: { main: { from: number; to: number } };
        };
        dispatch: (spec: {
          changes: { from: number; to: number; insert: string };
          selection?: { anchor: number; head?: number };
        }) => void;
        focus: () => void;
      } | null>(null);
      viewRef.current ??= {
        state: {
          doc: { toString: () => valueRef.current },
          selection: { main: selectionRef.current },
        },
        dispatch: (spec) => {
          const nextValue = `${valueRef.current.slice(0, spec.changes.from)}${spec.changes.insert}${valueRef.current.slice(spec.changes.to)}`;
          const anchor = spec.selection?.anchor ?? spec.changes.from + spec.changes.insert.length;
          const head = spec.selection?.head ?? anchor;
          selectionRef.current = { from: Math.min(anchor, head), to: Math.max(anchor, head) };
          valueRef.current = nextValue;
          onChangeRef.current?.(nextValue);
        },
        focus: () => textareaRef.current?.focus(),
      };
      viewRef.current.state = {
        doc: { toString: () => valueRef.current },
        selection: { main: selectionRef.current },
      };
      React.useEffect(() => {
        onCreateEditor?.(viewRef.current);
      }, [onCreateEditor]);
      return (
        <textarea
          ref={textareaRef}
          aria-label="CodeMirror editor"
          data-testid="codemirror-editor"
          data-readonly={readOnly ? "true" : "false"}
          data-editable={editable ? "true" : "false"}
          data-basic-setup={JSON.stringify(basicSetup || {})}
          data-extension-count={String(extensions?.length || 0)}
          className={className}
          readOnly={readOnly}
          value={value}
          onSelect={(event) => {
            const selection = {
              from: event.currentTarget.selectionStart,
              to: event.currentTarget.selectionEnd,
            };
            selectionRef.current = selection;
            if (viewRef.current) viewRef.current.state.selection.main = selection;
          }}
          onChange={(event) => {
            const selection = {
              from: event.currentTarget.selectionStart,
              to: event.currentTarget.selectionEnd,
            };
            selectionRef.current = selection;
            if (viewRef.current) viewRef.current.state.selection.main = selection;
            onChange?.(event.currentTarget.value);
          }}
        />
      );
    },
  };
});

vi.mock("@milkdown/crepe", () => {
  type MarkdownUpdated = (_ctx: unknown, markdown: string, previousMarkdown: string) => void;

  class MockCrepe {
    private readonly root?: Element;
    private markdown: string;
    private readonly listeners: MarkdownUpdated[] = [];
    private readonlyState = false;
    private editorElement?: HTMLDivElement;

    editor = {
      action: (callback: (ctx: { get: () => Record<string, unknown> }) => unknown) =>
        callback({
          get: () => ({
            call: vi.fn(),
            updateRoot: vi.fn(),
            state: { selection: { from: 0 } },
          }),
        }),
    };

    constructor(config: { root?: Node | string | null; defaultValue?: string } = {}) {
      const { root, defaultValue = "" } = config;
      this.root =
        typeof root === "string"
          ? document.querySelector(root) || undefined
          : root instanceof Element
            ? root
            : undefined;
      this.markdown = String(defaultValue);
    }

    setReadonly(value: boolean) {
      this.readonlyState = value;
      if (this.editorElement) {
        this.editorElement.setAttribute("contenteditable", value ? "false" : "true");
        this.editorElement.dataset.readonly = value ? "true" : "false";
      }
      return this;
    }

    on(register: (api: { markdownUpdated: (listener: MarkdownUpdated) => unknown }) => void) {
      register({
        markdownUpdated: (listener) => {
          this.listeners.push(listener);
          return this;
        },
      });
      return this;
    }

    async create() {
      const milkdown = document.createElement("div");
      milkdown.className = "milkdown";
      const editor = document.createElement("div");
      editor.className = "ProseMirror virtual-cursor-enabled";
      editor.dataset.testid = "mock-crepe-editor";
      editor.dataset.readonly = this.readonlyState ? "true" : "false";
      editor.setAttribute("contenteditable", this.readonlyState ? "false" : "true");

      const headingMatch = this.markdown.match(/^#\s+(.+)$/m);
      if (headingMatch) {
        const heading = document.createElement("h1");
        heading.textContent = headingMatch[1];
        editor.append(heading);
      }
      for (const match of this.markdown.matchAll(
        /<h([1-6])\s+align=["']([^"']+)["']>(.*?)<\/h\1>/g,
      )) {
        const heading = document.createElement(`h${match[1]}`);
        heading.setAttribute("align", match[2] || "");
        heading.textContent = match[3] || "";
        editor.append(heading);
      }
      for (const match of this.markdown.matchAll(/!\[([^\]\r\n]*)\]\(\s*<?([^)\s>]+)>?/g)) {
        const image = document.createElement("img");
        image.alt = match[1] || "";
        image.setAttribute("src", match[2] || "");
        editor.append(image);
      }
      editor.addEventListener("input", () => {
        const previousMarkdown = this.markdown;
        this.markdown = editor.dataset.markdown ?? editor.textContent ?? "";
        for (const listener of this.listeners) listener({}, this.markdown, previousMarkdown);
      });
      this.editorElement = editor;
      milkdown.append(editor);
      this.root?.replaceChildren(milkdown);
      return {};
    }

    async destroy() {
      this.editorElement?.remove();
      this.editorElement = undefined;
      return {};
    }

    getMarkdown() {
      return this.markdown;
    }
  }

  return { Crepe: MockCrepe };
});

vi.mock("react-zoom-pan-pinch", async () => {
  const React = await import("react");
  type TransformState = {
    previousScale: number;
    scale: number;
    positionX: number;
    positionY: number;
  };
  const TransformContext = React.createContext<TransformState>({
    previousScale: 1,
    scale: 1,
    positionX: 0,
    positionY: 0,
  });

  const clampScale = (value: number, minScale = 0.25, maxScale = 6) =>
    Math.min(maxScale, Math.max(minScale, value));

  const TransformWrapper = ({
    children,
    initialScale = 1,
    minScale = 0.25,
    maxScale = 6,
    onInit,
    onTransform,
    wheel,
    trackPadPanning,
  }: {
    children?: React.ReactNode | ((controls: Record<string, unknown>) => React.ReactNode);
    initialScale?: number;
    minScale?: number;
    maxScale?: number;
    onInit?: (ref: { state: TransformState }) => void;
    onTransform?: (ref: { state: TransformState }, state: TransformState) => void;
    wheel?: { wheelDisabled?: boolean; touchPadDisabled?: boolean };
    trackPadPanning?: { disabled?: boolean; velocityDisabled?: boolean };
  }) => {
    const [state, setState] = React.useState<TransformState>({
      previousScale: initialScale,
      scale: initialScale,
      positionX: 0,
      positionY: 0,
    });

    const updateScale = (nextScale: (current: number) => number) => {
      setState((current) => {
        const nextState = {
          ...current,
          previousScale: current.scale,
          scale: clampScale(nextScale(current.scale), minScale, maxScale),
        };
        onTransform?.({ state: nextState }, nextState);
        return nextState;
      });
    };

    const controls = {
      state,
      zoomIn: (step = Math.log(1.2)) => updateScale((current) => current * Math.exp(step)),
      zoomOut: (step = Math.log(1.2)) => updateScale((current) => current * Math.exp(-step)),
      resetTransform: () => {
        const nextState = {
          previousScale: state.scale,
          scale: initialScale,
          positionX: 0,
          positionY: 0,
        };
        setState(nextState);
        onTransform?.({ state: nextState }, nextState);
      },
      setTransform: () => undefined,
      centerView: () => undefined,
      zoomToElement: () => undefined,
    };

    React.useEffect(() => {
      onInit?.({ state });
    }, []);

    return (
      <TransformContext.Provider value={state}>
        <div
          data-testid="mock-transform-wrapper"
          data-wheel-disabled={String(Boolean(wheel?.wheelDisabled))}
          data-touchpad-disabled={String(Boolean(wheel?.touchPadDisabled))}
          data-trackpad-panning-disabled={String(Boolean(trackPadPanning?.disabled))}
          data-trackpad-panning-velocity-disabled={String(
            Boolean(trackPadPanning?.velocityDisabled),
          )}
        >
          {typeof children === "function" ? children(controls) : children}
        </div>
      </TransformContext.Provider>
    );
  };

  const TransformComponent = ({
    children,
    wrapperClass,
    contentClass,
    wrapperStyle,
    contentStyle,
    wrapperProps,
    contentProps,
  }: {
    children?: React.ReactNode;
    wrapperClass?: string;
    contentClass?: string;
    wrapperStyle?: React.CSSProperties;
    contentStyle?: React.CSSProperties;
    wrapperProps?: React.HTMLAttributes<HTMLDivElement>;
    contentProps?: React.HTMLAttributes<HTMLDivElement>;
  }) => {
    const state = React.useContext(TransformContext);
    return (
      <div {...wrapperProps} className={wrapperClass} style={wrapperStyle}>
        <div
          {...contentProps}
          className={contentClass}
          style={{
            ...contentStyle,
            transform: `translate3d(${state.positionX}px, ${state.positionY}px, 0) scale(${state.scale})`,
          }}
        >
          {children}
        </div>
      </div>
    );
  };

  return { TransformWrapper, TransformComponent };
});

import { UserSpaceExplorer } from "./UserSpaceExplorer.js";
import {
  clearUserSpaceFileRefs,
  getUserSpaceFileRefs,
  requestUserSpaceFilePreview,
} from "../user-space-file-refs.js";
import { WORKSPACE_INTERNAL_DRAG_TYPE } from "./user-space-explorer/drag-and-drop.js";
import { previewSessionStorageKey } from "./user-space-explorer/preview-session-state.js";

beforeAll(() => {
  globalThis.URL.createObjectURL = vi.fn(() => "blob:http://localhost/workspace-preview");
  globalThis.URL.revokeObjectURL = vi.fn();
});

function defaultMockGetUserSpaceFile(_mountId: string, path: string): Promise<File> {
  if (path.endsWith(".md"))
    return Promise.resolve(
      new File(
        [
          '# Hello\n\n<h1 align="center">Native Center</h1>\n\n- one\n\n```ts\nconst markdownCode = 1\n```',
        ],
        "README.md",
        { type: "text/markdown" },
      ),
    );
  if (path.endsWith(".html"))
    return Promise.resolve(
      new File(["<main>\n  <h1>Hello HTML</h1>\n</main>"], "index.html", { type: "text/html" }),
    );
  if (path === "Dockerfile.server")
    return Promise.resolve(
      new File(["FROM node:22\nCMD node server.js\n"], "Dockerfile.server", { type: "" }),
    );
  if (path.endsWith(".ts"))
    return Promise.resolve(
      new File(["const answer: number = 42;"], "app.ts", { type: "text/typescript" }),
    );
  if (path.endsWith("package-lock.json")) {
    const packages = Array.from(
      { length: 1400 },
      (_, index) => `    "node_modules/pkg-${index}": { "version": "1.0.${index}" }`,
    ).join(",\n");
    const content = `{\n  "name": "outlook",\n  "lockfileVersion": 3,\n  "packages": {\n${packages}\n  }\n}`;
    return Promise.resolve(new File([content], "package-lock.json", { type: "application/json" }));
  }
  if (path.endsWith("big.txt")) {
    const content = Array.from({ length: 2000 }, (_, index) => `line ${index + 1}`).join("\n");
    return Promise.resolve(new File([content], "big.txt", { type: "text/plain" }));
  }
  if (path.endsWith(".pdf"))
    return Promise.resolve(new File(["%PDF-mock"], "manual.pdf", { type: "application/pdf" }));
  return Promise.resolve(
    new File(["not-a-real-docx"], "report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );
}

beforeEach(() => {
  setUiCopyLanguage("zh-CN");
  document.documentElement.classList.remove("piwork-wterm-selecting");
  window.sessionStorage.clear();
  vi.clearAllMocks();
  mockElementFromPoint(null);
  mockExecuteUserSpaceOperation.mockReset();
  mockGetUserSpaceFile.mockReset();
  mockSubscribeUserSpace.mockReset();
  mockMountUserSpace.mockReset();
  mockRemountUserSpace.mockReset();
  mockRestorePersistedUserSpace.mockReset();
  mockSaveUserSpaceFile.mockReset();
  mockSyncUserSpaceMetadata.mockReset();
  mockUpdateUserSpaceAccess.mockReset();
  mockAttachUserSpaceMountsToSession.mockReset();
  mockDetachUserSpaceFromSession.mockReset();
  mockDiscardUnattachedUserSpaceMount.mockReset();
  mockRenameUserSpaceMount.mockReset();
  mockRenameUserSpaceMount.mockImplementation(async (mountId: string, rootName: string) => {
    const mount = mockSnapshot.mounts.find((item) => item.mountId === mountId) || mountedWorkspace;
    return { ...mount, mountId, name: rootName, rootName };
  });
  mockConfigureUserSpace.mockReset();
  mockGetAgentSpaceTree.mockReset();
  mockGetAgentSpaceFile.mockReset();
  mockDeleteAgentSpaceEntry.mockReset();
  mockMoveAgentSpaceEntries.mockReset();
  mockTransferUserToAgent.mockReset();
  mockTransferAgentToUser.mockReset();
  mockThemeMode = "system";
  mockCreateOfficeEditor.mockReset();
  mockOfficeEditorDestroy.mockReset();
  mockWtermWrite.mockReset();
  mockWtermResize.mockReset();
  mockWtermFocus.mockReset();
  mockPlanOfficeResourcesForFile.mockReset();
  mockApplyOfficeResourcePlan.mockReset();
  mockOfficeResourcesReadyForRelease.mockReset();
  mockOfficeResourcesReadyForRelease.mockReturnValue(true);
  mockPlanOfficeResourcesForFile.mockResolvedValue({
    planId: "test-plan",
    releaseId: "test-release",
    scope: "document",
    profiles: ["base", "word"],
    totalBytes: 0,
    downloadBytes: 0,
    reusedBytes: 0,
  });
  mockApplyOfficeResourcePlan.mockResolvedValue(undefined);
  mockCreateOfficeEditor.mockImplementation(
    async (
      container: HTMLElement,
      options: {
        fileName?: string;
        hostUrl?: unknown;
        mode?: string;
        readonly?: boolean;
        onReady?: (instance: unknown) => void;
        onSave?: (file: File, instance: unknown) => Promise<void> | void;
        onSaveAs?: (file: File, instance: unknown) => Promise<void> | void;
        onDirtyChange?: (dirty: boolean, instance: unknown) => Promise<void> | void;
        onStateChange?: (state: unknown, instance: unknown) => Promise<void> | void;
      },
    ) => {
      container.classList.add("office-editor-host");
      const iframe = document.createElement("iframe");
      iframe.dataset.piworkOfficePreviewPath = container.dataset.piworkOfficePreviewPath || "";
      iframe.className = "office-editor-host-frame mock-onlyoffice-host-frame";
      container.replaceChildren(iframe);
      let instance: {
        id: string;
        save: ReturnType<typeof vi.fn>;
        confirmSaveToNewFormat: ReturnType<typeof vi.fn>;
        setInterfaceTheme: ReturnType<typeof vi.fn>;
        setReadonly: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
        getState: ReturnType<typeof vi.fn>;
        getHostIdentity: ReturnType<typeof vi.fn>;
      };
      let currentMode = options.mode || "preview";
      let currentReadonly = currentMode === "preview" ? true : (options.readonly ?? true);
      const buildState = () => ({
        id: "mock-office",
        fileName: options.fileName || "document",
        fileType: "docx",
        mode: currentMode,
        readonly: currentReadonly,
        dirty: false,
        status: "ready",
        destroyed: false,
      });
      instance = {
        id: `mock-office-${mockCreateOfficeEditor.mock.calls.length}`,
        save: vi.fn(async () => {
          const savedFile = new File(["updated"], options.fileName || "document.docx", {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          });
          await options.onSave?.(savedFile, instance);
          return savedFile;
        }),
        confirmSaveToNewFormat: vi.fn(async () => true),
        setInterfaceTheme: vi.fn(),
        setReadonly: vi.fn((readonly: boolean) => {
          currentReadonly = readonly;
          currentMode = readonly ? "preview" : "edit";
          void options.onStateChange?.(buildState(), instance);
        }),
        destroy: vi.fn(async () => {
          mockOfficeEditorDestroy();
          iframe.remove();
          container.replaceChildren();
        }),
        getState: vi.fn(() => buildState()),
        getHostIdentity: vi.fn(() => ({ ...releaseManifest.runtimeIdentity })),
      };
      options.onReady?.(instance);
      return instance;
    },
  );
  const createObjectURL = vi.mocked(globalThis.URL.createObjectURL);
  const revokeObjectURL = vi.mocked(globalThis.URL.revokeObjectURL);
  createObjectURL.mockReset();
  revokeObjectURL.mockReset();
  createObjectURL.mockImplementation(() => "blob:http://localhost/workspace-preview");
  revokeObjectURL.mockImplementation(() => {});
  clearUserSpaceFileRefs("s1");
  mockSnapshot = {
    supported: true,
    mounts: [mountedWorkspace],
    indexing: {},
    recentOperations: [],
    recentFileChanges: [],
  };
  mockFilePreviewDefaults = createDefaultFilePreviewDefaults();
  mockUserSpacePreferences = {
    showHiddenEntries: false,
    searchHiddenEntries: false,
  };
  mockSubscribeUserSpace.mockReturnValue(() => {});
  mockMountUserSpace.mockResolvedValue({
    mountId: "uw-next",
    name: "Next Files",
    rootName: "Next Files",
    status: "mounted",
    access: "readwrite",
    includeHidden: true,
  });
  mockRemountUserSpace.mockResolvedValue(mountedWorkspace);
  mockRestorePersistedUserSpace.mockResolvedValue(mountedWorkspace);
  mockSaveUserSpaceFile.mockResolvedValue({
    mountId: "uw-mounted",
    path: "report.docx",
    bytesWritten: 7,
    mtime: 123,
  });
  mockSyncUserSpaceMetadata.mockResolvedValue({
    ...mountedWorkspace,
    fileCount: 8,
    lastIndexedAt: 123,
  });
  mockUpdateUserSpaceAccess.mockResolvedValue({
    ...mountedWorkspace,
    access: "readonly",
    canRead: true,
    canWrite: false,
  });
  mockConfigureUserSpace.mockImplementation(
    (
      _sessionId: string,
      configuredMounts: UserSpaceMount[] = [mountedWorkspace],
      activeMountId?: string,
    ) =>
      Promise.resolve({
        user_space:
          configuredMounts.find((mount) => mount.mountId === activeMountId) ||
          configuredMounts[0] ||
          null,
        user_spaces: configuredMounts,
      }),
  );
  mockGetAgentSpaceTree.mockResolvedValue({ path: "", rootName: "workspace", tree: [] });
  mockMoveAgentSpaceEntries.mockResolvedValue({ ok: true, moves: [] });
  mockGetAgentSpaceFile.mockImplementation((_sessionId: string, path: string) =>
    Promise.resolve({
      file: new File(["export const ok = true;\n"], path.split("/").pop() || path, {
        type: "text/plain",
      }),
      metadata: {
        path,
        name: path.split("/").pop() || path,
        kind: "file",
        size: 24,
        mtime: 123,
        sha256: "agent-hash",
      },
    }),
  );
  mockTransferUserToAgent.mockResolvedValue({ ok: true, files: [] });
  mockTransferAgentToUser.mockResolvedValue({ ok: true, files: [] });
  mockDeleteAgentSpaceEntry.mockResolvedValue({ ok: true, path: "artifact.pdf" });
  mockExecuteUserSpaceOperation.mockImplementation(
    (operation, input: { path?: string; cwd?: string }) => {
      if (operation === "shell_exec") {
        return Promise.resolve({
          stdout: "README.md\n",
          stderr: "",
          exitCode: 0,
          cwd: input.cwd || "",
        });
      }
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [{ name: "notes.txt", path: "docs/notes.txt", kind: "file", size: 9 }],
        });
      }
      return Promise.resolve({ entries: rootEntries });
    },
  );
  mockGetUserSpaceFile.mockImplementation(defaultMockGetUserSpaceFile);
});

afterEach(() => {
  setUiCopyLanguage("zh-CN");
});

function treeItemForButton(button: HTMLElement): HTMLElement {
  const treeItem = button.closest("[role='treeitem']");
  expect(treeItem).not.toBeNull();
  return treeItem as HTMLElement;
}

async function openUserSpaceManager(name = "管理用户空间目录"): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name }));
  return screen.getByRole("dialog", { name });
}

async function openWtermFromBlankAreaMenu(): Promise<void> {
  fireEvent.contextMenu(screen.getByTestId("user-space-tree-blank-area"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "打开 wterm" }));
}

async function closeAllPreviewsFromTabMenu(label = "关闭所有"): Promise<void> {
  const firstTab = screen
    .getByTestId("user-space-preview-tab-scroll")
    .querySelector<HTMLElement>("[data-preview-tab-id]");
  expect(firstTab).not.toBeNull();
  fireEvent.contextMenu(firstTab as HTMLElement);
  fireEvent.click(await screen.findByRole("menuitem", { name: label }));
}

async function mountDirectoryFromUserSpaceManager(
  managerName = "管理用户空间目录",
  actionName = "添加目录",
): Promise<void> {
  const dialog = await openUserSpaceManager(managerName);
  fireEvent.click(within(dialog).getByRole("button", { name: actionName }));
}

describe("UserSpaceExplorer", () => {
  it("restores open files, tab order, and the active file after a refresh", async () => {
    const ownerKey = JSON.stringify(["", "", "", "s1"]);
    const firstRender = render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "预览 app.ts" }));
    fireEvent.click(await screen.findByRole("button", { name: "切换预览 README.md" }));

    await waitFor(() => {
      const persisted = window.sessionStorage.getItem(previewSessionStorageKey(ownerKey));
      expect(persisted).not.toBeNull();
      expect(JSON.parse(persisted || "null")).toMatchObject({
        activeTabId: "uw-mounted:README.md",
        tabs: [
          { id: "uw-mounted:README.md", path: "README.md" },
          { id: "uw-mounted:app.ts", path: "app.ts", previewKind: "text" },
        ],
      });
    });

    firstRender.unmount();
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await screen.findByTestId("preview-tab-uw-mounted:app.ts");
    expect(await screen.findByTestId("text-editor-uw-mounted:app.ts")).toBeInTheDocument();
    const restoredTabs = within(screen.getByTestId("user-space-preview-tabbar"))
      .getAllByTestId(/^preview-tab-uw-mounted:/)
      .map((tab) => tab.dataset.testid);
    expect(restoredTabs).toEqual([
      "preview-tab-uw-mounted:README.md",
      "preview-tab-uw-mounted:app.ts",
    ]);
    expect(screen.getByTestId("preview-tab-uw-mounted:README.md")).toHaveClass("bg-accent");
    expect(screen.getByTestId("preview-tab-uw-mounted:app.ts")).toHaveClass("bg-transparent");
  });

  it("does not let a file finishing loading steal focus from a later tab selection", async () => {
    const appFile = deferred<File>();
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) =>
      path === "app.ts" ? appFile.promise : defaultMockGetUserSpaceFile(_mountId, path),
    );

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    await screen.findByTestId("markdown-editor-uw-mounted:README.md");
    fireEvent.click(screen.getByRole("button", { name: "预览 app.ts" }));
    fireEvent.click(await screen.findByRole("button", { name: "切换预览 README.md" }));

    await act(async () => {
      appFile.resolve(new File(["export const app = true;"], "app.ts", { type: "text/plain" }));
      await Promise.resolve();
    });

    expect(await screen.findByTestId("text-editor-uw-mounted:app.ts")).toBeInTheDocument();
    expect(screen.getByTestId("preview-tab-uw-mounted:README.md")).toHaveClass("bg-accent");
    expect(screen.getByTestId("preview-tab-uw-mounted:app.ts")).toHaveClass("bg-transparent");
  });

  it("restores every tab shell atomically without moving the persisted active tab", async () => {
    const ownerKey = JSON.stringify(["", "", "", "s1"]);
    window.sessionStorage.setItem(
      previewSessionStorageKey(ownerKey),
      JSON.stringify({
        activeTabId: "uw-mounted:package.json",
        tabs: [
          {
            space: "user",
            id: "uw-mounted:package.json",
            mountId: "uw-mounted",
            path: "package.json",
            viewMode: "text",
          },
          {
            space: "user",
            id: "uw-mounted:report.docx",
            mountId: "uw-mounted",
            path: "report.docx",
            viewMode: "preview",
          },
        ],
      }),
    );
    const packageFile = deferred<File>();
    const reportFile = deferred<File>();
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) =>
      path === "package.json" ? packageFile.promise : reportFile.promise,
    );

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);
    await screen.findByTestId("preview-tab-uw-mounted:package.json");

    try {
      expect(screen.getByTestId("preview-tab-uw-mounted:report.docx")).toBeInTheDocument();
      expect(screen.getByTestId("preview-tab-uw-mounted:package.json")).toHaveClass("bg-accent");
      expect(screen.getByTestId("preview-tab-uw-mounted:report.docx")).toHaveClass(
        "bg-transparent",
      );
      expect(
        within(screen.getByTestId("preview-body-uw-mounted:package.json")).getByTestId(
          "preview-loading-state",
        ),
      ).toBeInTheDocument();
      expect(mockGetUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "package.json");
      expect(mockGetUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "report.docx");
    } finally {
      await act(async () => {
        packageFile.resolve(
          new File(['{"answer":42}'], "package.json", { type: "application/json" }),
        );
        reportFile.resolve(
          new File(["not-a-real-docx"], "report.docx", {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          }),
        );
        await Promise.resolve();
      });
    }

    expect(await screen.findByTestId("text-editor-uw-mounted:package.json")).toBeInTheDocument();
    expect(screen.getByTestId("preview-tab-uw-mounted:package.json")).toHaveClass("bg-accent");
    expect(screen.getByTestId("preview-tab-uw-mounted:report.docx")).toHaveClass("bg-transparent");
  });

  it("keeps persisted file tabs while the directory handle is still restoring", async () => {
    const ownerKey = JSON.stringify([persistenceScope.userId, persistenceScope.tenantId, "", "s1"]);
    const storageKey = previewSessionStorageKey(ownerKey);
    window.sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        activeTabId: "uw-mounted:README.md",
        tabs: [
          {
            space: "user",
            id: "uw-mounted:README.md",
            mountId: "uw-mounted",
            path: "README.md",
            viewMode: "preview",
          },
        ],
      }),
    );
    mockSnapshot = {
      supported: true,
      mounts: [],
      indexing: {},
      recentOperations: [],
      recentFileChanges: [],
    };
    let notifyUserSpaceChanged = () => {};
    mockSubscribeUserSpace.mockImplementation((notify: () => void) => {
      notifyUserSpaceChanged = notify;
      return () => {};
    });

    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        persistenceScope={persistenceScope}
      />,
    );

    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();
    expect(screen.getByTestId("preview-tab-uw-mounted:README.md")).toHaveClass("bg-accent");
    expect(
      within(screen.getByTestId("preview-body-uw-mounted:README.md")).getByTestId(
        "preview-loading-state",
      ),
    ).toBeInTheDocument();

    act(() => {
      mockSnapshot = {
        supported: true,
        mounts: [mountedWorkspace],
        indexing: {},
        recentOperations: [],
        recentFileChanges: [],
      };
      notifyUserSpaceChanged();
    });

    expect(await screen.findByTestId("preview-tab-uw-mounted:README.md")).toBeInTheDocument();
  });

  it("keeps a restored file preview folded when the controlled parent callback rerenders", async () => {
    const ownerKey = JSON.stringify(["", "", "", "s1"]);
    window.sessionStorage.setItem(
      previewSessionStorageKey(ownerKey),
      JSON.stringify({
        activeTabId: "uw-mounted:README.md",
        tabs: [
          {
            space: "user",
            id: "uw-mounted:README.md",
            mountId: "uw-mounted",
            path: "README.md",
            viewMode: "preview",
          },
        ],
      }),
    );

    function ControlledExplorer() {
      const [previewOpen, setPreviewOpen] = useState(false);
      return (
        <UserSpaceExplorer
          sessionId="s1"
          mounts={[mountedWorkspace]}
          previewOpen={previewOpen}
          onPreviewOpenChange={(open) => setPreviewOpen(open)}
        />
      );
    }

    render(<ControlledExplorer />);
    fireEvent.click(await screen.findByRole("button", { name: "折叠文件预览" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "展开文件预览" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "折叠文件预览" })).not.toBeInTheDocument();
  });

  it("does not rerun preview restoration when only the controlled callback identity changes", async () => {
    const ownerKey = JSON.stringify(["", "", "", "s1"]);
    const storedPreview = JSON.stringify({
      activeTabId: "uw-mounted:README.md",
      tabs: [
        {
          space: "user",
          id: "uw-mounted:README.md",
          mountId: "uw-mounted",
          path: "README.md",
          viewMode: "preview",
        },
      ],
    });
    window.sessionStorage.setItem(previewSessionStorageKey(ownerKey), storedPreview);
    const firstPreviewChange = vi.fn();
    const secondPreviewChange = vi.fn();
    const firstProps = {
      sessionId: "s1",
      mounts: [mountedWorkspace],
      previewOpen: true,
      onPreviewOpenChange: firstPreviewChange,
    };
    const { rerender } = render(<UserSpaceExplorer {...firstProps} />);
    await screen.findByTestId("preview-tab-uw-mounted:README.md");

    firstPreviewChange.mockClear();
    window.sessionStorage.setItem(previewSessionStorageKey(ownerKey), storedPreview);
    rerender(<UserSpaceExplorer {...firstProps} onPreviewOpenChange={secondPreviewChange} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(firstPreviewChange).not.toHaveBeenCalled();
    expect(secondPreviewChange).not.toHaveBeenCalled();
  });

  it("refreshes memoized user space copy immediately when the language prop changes", () => {
    const { rerender } = render(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="zh-CN" />,
    );

    expect(screen.getByRole("button", { name: "管理用户空间目录" })).toBeInTheDocument();

    setUiCopyLanguage("en-US");
    rerender(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />);

    expect(screen.getByRole("button", { name: "Manage user space folders" })).toBeInTheDocument();
  });

  it("does not create old ranuts document prefetch hints when office files are indexed", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    expect(await screen.findByRole("button", { name: "预览 report.docx" })).toBeInTheDocument();

    const hints = Array.from(
      document.head.querySelectorAll<HTMLLinkElement>(
        "link[data-piwork-ranuts-document-prefetch='true']",
      ),
    );
    expect(hints).toHaveLength(0);
    expect(screen.queryByTitle("Office preview warmup")).not.toBeInTheDocument();
  });

  it("opens wterm as its own file preview tab", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    expect(screen.queryByRole("button", { name: "打开 wterm" })).not.toBeInTheDocument();

    await screen.findByRole("button", { name: "预览 README.md" });
    expect(screen.queryByRole("treeitem", { selected: true })).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTestId("user-space-tree-blank-area"));
    const wtermMenuItem = await screen.findByRole("menuitem", { name: "打开 wterm" });
    expect(wtermMenuItem.querySelector(".lucide-square-terminal")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "关闭所有" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").at(-1)).toBe(wtermMenuItem);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    await openWtermFromBlankAreaMenu();

    expect(screen.getByRole("button", { name: "切换预览 wterm" })).toBeInTheDocument();
    expect(screen.getByTestId("user-space-wterm-preview")).toBeInTheDocument();
    expect(screen.getByTestId("user-space-preview-toolbar-filename")).toHaveTextContent("wterm");
    const openInNewWindow = within(screen.getByTestId("user-space-preview-toolbar")).getByRole(
      "button",
      { name: "在新窗口打开" },
    );
    expect(openInNewWindow).toHaveTextContent("");
    expect(openInNewWindow.querySelector(".lucide-external-link")).toBeInTheDocument();
    expect(screen.queryByTestId("user-space-inner-resize-handle")).not.toBeInTheDocument();
    const terminal = await screen.findByTestId("user-space-wterm-terminal");
    expect(terminal).toBeInTheDocument();
    expect(terminal).toHaveClass("w-full");
    expect(terminal.parentElement).toHaveClass("justify-start");
    expect(terminal.parentElement).not.toHaveClass("justify-end", "bg-background");
    expect(terminal).not.toHaveAttribute("data-term-bg");
    expect(terminal).not.toHaveAttribute("data-term-fg");
    expect(terminal).not.toHaveAttribute("data-border-radius");
    expect(terminal).not.toHaveAttribute("data-box-shadow");
    expect(terminal).not.toHaveAttribute("data-box-sizing");
    expect(terminal).not.toHaveAttribute("data-padding");
    expect(terminal).not.toHaveAttribute("data-height");
    expect(terminal).toHaveAttribute("data-cursor-blink", "false");
    expect(terminal).not.toHaveAttribute("data-theme");
    expect(terminal).toHaveAttribute("data-auto-resize", "false");
    await waitFor(() =>
      expect(screen.getByTestId("mock-wterm-textarea")).not.toHaveAttribute("aria-hidden"),
    );
    await waitFor(() => expect(mockWtermWrite).toHaveBeenCalledWith(expect.stringContaining(":")));
    expect(mockWtermWrite).toHaveBeenCalledWith(expect.stringContaining("/"));
    expect(mockWtermWrite).not.toHaveBeenCalledWith(expect.stringContaining("~"));
    terminal.textContent = "ls\n";
    fireEvent.input(terminal);
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "shell_exec",
        expect.objectContaining({
          mountId: "uw-mounted",
          script: "ls",
          cwd: "/",
        }),
      ),
    );
    expect(mockGetUserSpaceFile).not.toHaveBeenCalled();
  });

  it("moves wterm to an independent window and returns it with icon-only controls", async () => {
    const { popoutDocument, popoutWindow } = createMockDetachedPreviewWindow();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popoutWindow);

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);
    await openWtermFromBlankAreaMenu();
    const terminal = await screen.findByTestId("user-space-wterm-terminal");

    fireEvent.click(screen.getByRole("button", { name: "在新窗口打开" }));

    await waitFor(() =>
      expect(popoutDocument.querySelector("[data-testid='user-space-wterm-terminal']")).toBe(
        terminal,
      ),
    );
    const detachedHeader = popoutDocument.querySelector(
      "[data-testid='detached-preview-window-header']",
    ) as HTMLElement;
    expect(detachedHeader).not.toBeNull();
    expect(
      detachedHeader.querySelector("[data-testid='detached-preview-window-header-filename']")
        ?.textContent,
    ).toBe("wterm");
    expect(detachedHeader.querySelector("button[aria-label='在新窗口打开']")).toBeNull();
    const returnButton = detachedHeader.querySelector(
      "button[aria-label='移回标签组']",
    ) as HTMLButtonElement;
    expect(returnButton).not.toBeNull();
    expect(returnButton.textContent).toBe("");
    expect(returnButton.querySelector(".lucide-panel-top-open")).not.toBeNull();

    act(() => {
      returnButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(await screen.findByTestId("user-space-wterm-terminal")).toBe(terminal);
    expect(screen.getByTestId("user-space-preview-toolbar-filename")).toHaveTextContent("wterm");
    expect(popoutWindow.close).toHaveBeenCalledTimes(1);
    openSpy.mockRestore();
  });

  it("uses wterm command history and swallows terminal navigation escape sequences", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await openWtermFromBlankAreaMenu();
    const terminal = await screen.findByTestId("user-space-wterm-terminal");
    await waitFor(() => expect(mockWtermWrite).toHaveBeenCalledWith(expect.stringContaining("/")));
    expect(mockWtermWrite).not.toHaveBeenCalledWith(expect.stringContaining("~"));

    terminal.textContent = "ls\n";
    fireEvent.input(terminal);
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "shell_exec",
        expect.objectContaining({ script: "ls" }),
      ),
    );

    mockWtermWrite.mockClear();
    terminal.textContent = "\x1b[A";
    fireEvent.input(terminal);
    expect(mockWtermWrite).toHaveBeenCalledWith(expect.stringContaining("ls"));
    expect(mockWtermWrite).not.toHaveBeenCalledWith(expect.stringContaining("[A"));

    mockWtermWrite.mockClear();
    terminal.textContent = "\x1b[D\x1b[C\x1b[B\x1b[H\x1b[F\x1b[3~\x1b[5~\x1bOP";
    fireEvent.input(terminal);
    expect(mockWtermWrite).not.toHaveBeenCalledWith(expect.stringContaining("[D"));
    expect(mockWtermWrite).not.toHaveBeenCalledWith(expect.stringContaining("[C"));
    expect(mockWtermWrite).not.toHaveBeenCalledWith(expect.stringContaining("[B"));
    expect(mockWtermWrite).not.toHaveBeenCalledWith(expect.stringContaining("[5~"));
    expect(mockWtermWrite).not.toHaveBeenCalledWith(expect.stringContaining("OP"));
  });

  it("keeps wterm separate from directory mounting in the manager", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await openWtermFromBlankAreaMenu();

    expect(screen.getByRole("button", { name: "切换预览 wterm" })).toBeInTheDocument();
    expect(mockMountUserSpace).not.toHaveBeenCalled();
  });

  it("does not schedule forced scroll correction for local wterm character echo", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await openWtermFromBlankAreaMenu();
    const terminal = await screen.findByTestId("user-space-wterm-terminal");
    await waitFor(() =>
      expect(mockWtermWrite).toHaveBeenCalledWith(expect.stringContaining("user@wterm")),
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    terminal.textContent = "a";
    fireEvent.input(terminal);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    expect(mockWtermWrite).toHaveBeenCalledWith("a");
    expect(rafSpy).not.toHaveBeenCalled();
    expect(mockExecuteUserSpaceOperation).not.toHaveBeenCalledWith("shell_exec", expect.anything());
    rafSpy.mockRestore();
  });

  it("keeps native terminal text selection from leaking into the rest of the page", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await openWtermFromBlankAreaMenu();
    const terminal = await screen.findByTestId("user-space-wterm-terminal");
    await waitFor(() =>
      expect(mockWtermWrite).toHaveBeenCalledWith(expect.stringContaining("user@wterm")),
    );

    fireEvent.mouseDown(terminal);
    expect(document.documentElement).toHaveClass("piwork-wterm-selecting");

    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(document.documentElement).not.toHaveClass("piwork-wterm-selecting");
  });

  it("clears wterm scrollback after long command output", async () => {
    mockExecuteUserSpaceOperation.mockImplementation(
      (operation, input: { cwd?: string; script?: string; path?: string }) => {
        if (operation === "shell_exec" && input.script === "ruok") {
          return Promise.resolve({
            stdout:
              Array.from({ length: 120 }, (_, index) => `ruok line ${index + 1}`).join("\n") + "\n",
            stderr: "",
            exitCode: 0,
            cwd: input.cwd || "",
          });
        }
        if (operation === "shell_exec" && input.script === "clear") {
          return Promise.resolve({
            stdout: "\x1b[2J\x1b[H",
            stderr: "",
            exitCode: 0,
            cwd: input.cwd || "",
          });
        }
        if (operation === "shell_exec") {
          return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, cwd: input.cwd || "" });
        }
        return Promise.resolve({ entries: rootEntries });
      },
    );
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await openWtermFromBlankAreaMenu();
    const terminal = await screen.findByTestId("user-space-wterm-terminal");
    await waitFor(() =>
      expect(mockWtermWrite).toHaveBeenCalledWith(expect.stringContaining("user@wterm")),
    );

    mockWtermWrite.mockClear();
    terminal.textContent = "ruok\n";
    fireEvent.input(terminal);
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "shell_exec",
        expect.objectContaining({ script: "ruok" }),
      ),
    );
    await waitFor(() =>
      expect(mockWtermWrite).toHaveBeenCalledWith(expect.stringContaining("ruok line 120")),
    );

    mockWtermWrite.mockClear();
    terminal.textContent = "clear\n";
    fireEvent.input(terminal);
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "shell_exec",
        expect.objectContaining({ script: "clear" }),
      ),
    );
    await waitFor(() => expect(mockWtermWrite).toHaveBeenCalledWith("\x1b[3J\x1b[2J\x1b[H"));
    expect(mockWtermWrite).toHaveBeenCalledWith(expect.stringContaining("user@wterm"));
  });

  it("keeps wterm mounted without replaying output when the preview pane is folded and expanded again", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await openWtermFromBlankAreaMenu();
    expect(screen.getByTestId("user-space-wterm-preview")).toBeInTheDocument();
    await screen.findByTestId("user-space-wterm-terminal");
    await waitFor(() => expect(mockWtermWrite).toHaveBeenCalledWith(expect.stringContaining(":")));

    mockWtermWrite.mockClear();
    mockWtermResize.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "折叠文件预览" }));
    expect(screen.getByTestId("user-space-preview-pane")).toHaveAttribute("aria-hidden", "true");

    const expandPreviewToggle = screen.getByRole("button", { name: "展开文件预览" });
    expect(expandPreviewToggle).toBeEnabled();
    fireEvent.click(expandPreviewToggle);

    expect(screen.getByTestId("user-space-wterm-preview")).toBeInTheDocument();
    expect(mockWtermWrite).not.toHaveBeenCalledWith(expect.stringContaining("user@wterm"));
    expect(mockWtermResize).not.toHaveBeenCalled();
  });

  it("loads the mounted root once without looping after state updates", async () => {
    // This guards against the previous activeMount object dependency loop:
    // loading the root updates component state, but must not re-trigger list_dir.
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    expect(screen.getByLabelText("工作区文件边栏")).toBeInTheDocument();
    expect(screen.getByTestId("user-space-tree-pane")).toBeInTheDocument();
    expect(screen.getByTestId("user-space-preview-pane")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "用户空间" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Agent空间" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByRole("tab", { name: "用户空间" })).toHaveClass(
      "h-full",
      "bg-accent",
      "text-foreground",
    );
    expect(screen.getByRole("tab", { name: "用户空间" })).toHaveClass(
      "min-w-0",
      "overflow-hidden",
      "px-1",
    );
    expect(screen.getByRole("tab", { name: "用户空间" }).firstElementChild).toHaveClass(
      "truncate",
      "leading-none",
    );
    expect(screen.getByRole("tab", { name: "用户空间" })).not.toHaveClass(
      "piwork-theme-selected-tab",
    );
    expect(screen.getByRole("tab", { name: "用户空间" }).className).toContain(
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(screen.getByRole("tab", { name: "Agent空间" })).toHaveClass(
      "h-full",
      "bg-transparent",
      "text-foreground",
      "hover:bg-accent",
    );
    expect(screen.getByRole("tab", { name: "Agent空间" }).firstElementChild).toHaveClass(
      "truncate",
      "leading-none",
    );
    expect(screen.getByRole("tab", { name: "Agent空间" })).not.toHaveClass(
      "text-muted-foreground",
      "hover:text-foreground",
    );
    expect(screen.getByRole("tab", { name: "Agent空间" }).className).toContain(
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(screen.getByRole("tab", { name: "Agent空间" })).not.toHaveClass("border-r");
    expect(screen.queryByText("|")).not.toBeInTheDocument();
    expect(screen.queryByText("工作区")).not.toBeInTheDocument();
    expect(screen.queryByText("daily-support")).not.toBeInTheDocument();
    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(screen.queryByText(".git")).not.toBeInTheDocument();
    expect(screen.queryByText(".env.local")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "下载" })).not.toBeInTheDocument();
    expect(screen.queryByText(/读写 · \d+ 项/)).not.toBeInTheDocument();
    expect(
      mockExecuteUserSpaceOperation.mock.calls.filter(([operation]) => operation === "list_dir"),
    ).toHaveLength(1);
    expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
      "list_dir",
      expect.objectContaining({
        includeHidden: false,
        mountId: "uw-mounted",
        path: "",
      }),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));

    expect(screen.getByRole("tab", { name: "Agent空间" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "用户空间" })).toHaveClass(
      "bg-transparent",
      "text-foreground",
      "hover:bg-accent",
    );
    expect(screen.getByRole("tab", { name: "用户空间" })).not.toHaveClass(
      "text-muted-foreground",
      "hover:text-foreground",
    );
    expect(screen.getByRole("tab", { name: "Agent空间" })).toHaveClass(
      "bg-accent",
      "text-foreground",
    );
    expect(screen.getByRole("tab", { name: "Agent空间" })).not.toHaveClass(
      "piwork-theme-selected-tab",
    );
    expect(await screen.findByTestId("agent-space-tree")).toBeInTheDocument();
    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(screen.queryByText("daily-support")).not.toBeInTheDocument();
    expect(screen.queryByText("Client Files")).not.toBeInTheDocument();
  });

  it("opens user-space search when the parent requests the file-search shortcut", async () => {
    const { rerender } = render(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} openSearchRequest={0} />,
    );

    rerender(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} openSearchRequest={1} />,
    );

    expect(
      await screen.findByRole("dialog", { name: "搜索Client Files用户空间" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("user-space-search-input")).toHaveFocus();
  });

  it("opens user-space search from the mount toolbar and searches by file name", async () => {
    mockExecuteUserSpaceOperation.mockImplementation(
      (operation, input: { path?: string; query?: string }) => {
        if (operation === "search_paths") {
          return Promise.resolve({
            entries: [
              {
                name: "hello.jpg",
                path: "hello.jpg",
                kind: "file",
                size: 11,
                previewKind: "image",
              },
              {
                name: "notes.txt",
                path: "docs/notes.txt",
                kind: "file",
                size: 9,
                previewKind: "text",
              },
            ],
          });
        }
        if (input.path === "docs") {
          return Promise.resolve({
            entries: [
              {
                name: "notes.txt",
                path: "docs/notes.txt",
                kind: "file",
                size: 9,
                previewKind: "text",
              },
            ],
          });
        }
        return Promise.resolve({ entries: rootEntries });
      },
    );
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) => {
      if (path === "docs/notes.txt")
        return Promise.resolve(
          new File(["notes search result"], "notes.txt", { type: "text/plain" }),
        );
      return defaultMockGetUserSpaceFile(_mountId, path);
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const toolbar = await screen.findByTestId("user-space-mount-switcher");
    const searchButton = within(toolbar).getByRole("button", { name: "搜索Client Files用户空间" });
    const accessButton = within(toolbar).getByRole("button", { name: "设置Client Files为只读" });
    const syncButton = within(toolbar).getByRole("button", { name: "同步Client Files空间索引" });
    expect(searchButton.querySelector("svg")).toHaveClass("h-4", "w-4");
    expect(accessButton.querySelector("svg")).toHaveClass("h-4", "w-4");
    expect(syncButton.querySelector("svg")).toHaveClass("h-4", "w-4");
    expect(
      searchButton.compareDocumentPosition(accessButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(searchButton);
    const dialog = await screen.findByRole("dialog", { name: "搜索Client Files用户空间" });
    await waitFor(() => expect(screen.getByTestId("user-space-search-input")).toHaveFocus());
    expect(dialog).toHaveClass("h-[520px]", "overflow-hidden");
    expect(dialog).toHaveClass("rounded-[var(--piwork-panel-radius)]");
    expect(within(dialog).getByTestId("user-space-search-body")).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-scroll",
    );
    expect(within(dialog).getByTestId("user-space-search-body")).not.toHaveClass(
      "piwork-scrollbar-hidden",
    );
    expect(within(dialog).queryByRole("heading", { name: "搜索" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Client Files")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("输入关键词开始搜索")).not.toBeInTheDocument();
    const searchModeTabs = within(dialog).getByRole("tablist", { name: "搜索模式" });
    expect(searchModeTabs).toHaveClass(
      "gap-1",
      "border",
      "border-border",
      "bg-surface-weak",
      "p-0.5",
    );
    expect(searchModeTabs).not.toHaveClass("gap-0.5");
    expect(searchModeTabs).not.toHaveClass("bg-card");
    expect(searchModeTabs).not.toHaveClass("bg-muted");
    expect(searchModeTabs).not.toHaveClass("p-1");
    expect(screen.getByRole("tab", { name: "文件名" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "文件名" })).toHaveClass(
      "rounded-[var(--piwork-control-radius)]",
      "h-7",
      "px-2",
      "text-xs",
      "hover:bg-card",
      "aria-selected:bg-card",
    );
    expect(screen.getByRole("tab", { name: "文件名" })).not.toHaveClass("bg-accent");
    expect(screen.getByRole("tab", { name: "文件名" })).not.toHaveClass("border");
    expect(screen.getByRole("tab", { name: "文件名" }).className).not.toContain(
      "aria-selected:outline",
    );
    expect((screen.getByRole("tab", { name: "文件名" }) as HTMLElement).style.borderRadius).toBe(
      "",
    );
    expect(screen.getByRole("tab", { name: "内容" })).toHaveClass(
      "bg-transparent",
      "text-muted-foreground",
      "hover:bg-card",
      "aria-selected:bg-card",
    );

    fireEvent.change(screen.getByTestId("user-space-search-input"), { target: { value: "notes" } });

    await waitFor(() => {
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "search_paths",
        expect.objectContaining({
          includeHidden: true,
          mountId: "uw-mounted",
          query: "notes",
        }),
      );
    });
    const searchPathCall = mockExecuteUserSpaceOperation.mock.calls.find(
      ([operation, input]) =>
        operation === "search_paths" && (input as { query?: string }).query === "notes",
    );
    expect(searchPathCall?.[1]).not.toHaveProperty("limit");
    const resultButton = await screen.findByRole("button", { name: "打开搜索结果 docs/notes.txt" });
    expect(resultButton).toHaveTextContent("docs/notes.txt");
    expect(resultButton).not.toHaveTextContent("文件");
    expect(resultButton).toHaveClass("h-12", "items-center");
    expect(within(resultButton).getByText("docs/notes.txt")).toHaveClass("overflow-visible");
    const previewSearchResultButton = screen.getByRole("button", { name: "预览 docs/notes.txt" });
    expect(previewSearchResultButton).toHaveClass("absolute", "opacity-0");
    expect(previewSearchResultButton).not.toHaveClass("bg-card", "shadow-sm", "ring-1");
    expect(previewSearchResultButton.className).toContain("group-hover/search-result:opacity-100");
    expect(previewSearchResultButton.className).not.toContain(
      "group-focus-within/search-result:opacity-100",
    );
    expect(
      previewSearchResultButton.querySelector("[data-iconify-icon='qlementine-icons:preview-16']"),
    ).toBeInstanceOf(SVGElement);
    const rootResultButton = screen.getByRole("button", { name: "打开搜索结果 hello.jpg" });
    expect(within(rootResultButton).getAllByText("hello.jpg")).toHaveLength(1);
    fireEvent.click(previewSearchResultButton);

    const previewDialog = await screen.findByRole("dialog", { name: "预览 docs/notes.txt" });
    await waitFor(() =>
      expect(mockGetUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "docs/notes.txt"),
    );
    const previewEditor = await within(previewDialog).findByTestId(
      "text-editor-search-preview:uw-mounted:docs/notes.txt",
    );
    expect(previewEditor).toHaveAttribute("data-search-highlight-query", "notes");
    expect(previewEditor).toHaveAttribute("data-search-highlight-line-numbers", "true");
    expect(within(previewEditor).getByTestId("codemirror-editor")).toHaveValue(
      "notes search result",
    );
    fireEvent.click(within(previewDialog).getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "预览 docs/notes.txt" })).not.toBeInTheDocument(),
    );

    mockGetUserSpaceFile.mockClear();
    fireEvent.click(resultButton);

    await waitFor(() =>
      expect(mockGetUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "docs/notes.txt"),
    );
    expect(await screen.findByRole("button", { name: "切换预览 notes.txt" })).toBeInTheDocument();
  });

  it("debounces user-space search requests and uses a progress circle while pending", async () => {
    mockExecuteUserSpaceOperation.mockImplementation(
      (operation, input: { path?: string; query?: string }) => {
        if (operation === "search_paths") return Promise.resolve({ entries: [] });
        if (input.path === "docs") {
          return Promise.resolve({
            entries: [
              {
                name: "notes.txt",
                path: "docs/notes.txt",
                kind: "file",
                size: 9,
                previewKind: "text",
              },
            ],
          });
        }
        return Promise.resolve({ entries: rootEntries });
      },
    );

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "搜索Client Files用户空间" }));
    const input = screen.getByTestId("user-space-search-input");
    mockExecuteUserSpaceOperation.mockClear();

    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "case" } });

      expect(screen.queryByText("搜索中...")).not.toBeInTheDocument();
      expect(screen.getByTestId("user-space-search-loading")).toBeInTheDocument();
      expect(mockExecuteUserSpaceOperation).not.toHaveBeenCalledWith(
        "search_paths",
        expect.objectContaining({ query: "case" }),
      );

      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });
      expect(mockExecuteUserSpaceOperation).not.toHaveBeenCalledWith(
        "search_paths",
        expect.objectContaining({ query: "case" }),
      );

      await act(async () => {
        vi.advanceTimersByTime(80);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "search_paths",
        expect.objectContaining({
          includeHidden: true,
          mountId: "uw-mounted",
          query: "case",
        }),
      );
      const searchPathCall = mockExecuteUserSpaceOperation.mock.calls.find(
        ([operation, input]) =>
          operation === "search_paths" && (input as { query?: string }).query === "case",
      );
      expect(searchPathCall?.[1]).not.toHaveProperty("limit");
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => {
      expect(screen.getByText("没有匹配结果")).toHaveClass(
        "h-full",
        "items-center",
        "justify-center",
      );
    });
  });

  it("switches user-space search to content mode and opens grouped file matches", async () => {
    mockExecuteUserSpaceOperation.mockImplementation(
      (operation, input: { path?: string; query?: string }) => {
        if (operation === "search") {
          return Promise.resolve({
            matches: [
              {
                path: "README.md",
                lineNumber: 2,
                line: "alpha beta gamma",
                contextBefore: ["# Readme"],
                contextAfter: ["done"],
              },
              {
                path: "README.md",
                lineNumber: 4,
                line: "second beta hit",
                contextBefore: ["done"],
                contextAfter: [],
              },
              {
                path: "app.ts",
                lineNumber: 1,
                line: "const beta = true;",
                contextBefore: [],
                contextAfter: [],
              },
            ],
            truncated: false,
          });
        }
        return Promise.resolve({ entries: rootEntries });
      },
    );
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) => {
      if (path === "README.md")
        return Promise.resolve(
          new File(["# Readme\nalpha beta gamma\nsecond beta hit"], "README.md", {
            type: "text/markdown",
          }),
        );
      return defaultMockGetUserSpaceFile(_mountId, path);
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "搜索Client Files用户空间" }));
    fireEvent.click(await screen.findByRole("tab", { name: "内容" }));
    await waitFor(() => expect(screen.getByTestId("user-space-search-input")).toHaveFocus());
    fireEvent.change(screen.getByTestId("user-space-search-input"), { target: { value: "beta" } });

    await waitFor(() => {
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "search",
        expect.objectContaining({
          contextLines: 1,
          includeHidden: true,
          mountId: "uw-mounted",
          query: "beta",
        }),
      );
    });
    const contentSearchCall = mockExecuteUserSpaceOperation.mock.calls.find(
      ([operation, input]) =>
        operation === "search" && (input as { query?: string }).query === "beta",
    );
    expect(contentSearchCall?.[1]).not.toHaveProperty("limit");
    const resultList = await screen.findByTestId("user-space-search-results");
    expect(within(resultList).getAllByRole("button", { name: /打开搜索结果/ })).toHaveLength(2);
    const readmeResult = within(resultList).getByRole("button", { name: "打开搜索结果 README.md" });
    expect(readmeResult).toHaveClass("h-12", "items-center");
    expect(readmeResult).toHaveTextContent("README.md");
    expect(readmeResult).toHaveTextContent("2 次");
    expect(readmeResult.textContent?.indexOf("2 次")).toBeGreaterThan(
      readmeResult.textContent?.indexOf("README.md") ?? 0,
    );
    expect(readmeResult).not.toHaveTextContent("README.md:2 alpha beta gamma");
    expect(
      within(resultList).getByRole("button", { name: "打开搜索结果 app.ts" }),
    ).toHaveTextContent("1 次");

    fireEvent.click(within(resultList).getByRole("button", { name: "预览 README.md" }));

    const previewDialog = await screen.findByRole("dialog", { name: "预览 README.md" });
    const previewEditor = await within(previewDialog).findByTestId(
      "text-editor-search-preview:uw-mounted:README.md",
    );
    expect(previewEditor).toHaveAttribute("data-search-highlight-query", "beta");
    expect(previewEditor).toHaveAttribute("data-search-highlight-line-numbers", "true");
    expect(within(previewEditor).getByTestId("codemirror-editor")).toHaveValue(
      "# Readme\nalpha beta gamma\nsecond beta hit",
    );
    fireEvent.click(within(previewDialog).getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "预览 README.md" })).not.toBeInTheDocument(),
    );

    mockGetUserSpaceFile.mockClear();
    fireEvent.click(readmeResult);

    await waitFor(() =>
      expect(mockGetUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "README.md"),
    );
    expect(await screen.findByRole("button", { name: "切换预览 README.md" })).toBeInTheDocument();
    expect(await screen.findByTestId("markdown-editor-uw-mounted:README.md")).toBeInTheDocument();
    expect(screen.queryByTestId("text-editor-uw-mounted:README.md")).not.toBeInTheDocument();
  });

  it("refreshes loaded user-space directories when just-bash reports file changes", async () => {
    let notifyWorkspace: (() => void) | null = null;
    mockSubscribeUserSpace.mockImplementation((listener: () => void) => {
      notifyWorkspace = listener;
      return () => {};
    });
    let rootLoadCount = 0;
    const generatedEntry = {
      name: "generated.txt",
      path: "generated.txt",
      kind: "file" as const,
      size: 9,
    };
    mockExecuteUserSpaceOperation.mockImplementation(
      (operation, input: { path?: string; cwd?: string }) => {
        if (operation === "shell_exec") {
          return Promise.resolve({
            stdout: "",
            stderr: "",
            exitCode: 0,
            cwd: input.cwd || "",
            changedDirs: [""],
          });
        }
        if (input.path === "docs") {
          return Promise.resolve({
            entries: [{ name: "notes.txt", path: "docs/notes.txt", kind: "file", size: 9 }],
          });
        }
        rootLoadCount++;
        return Promise.resolve({
          entries: rootLoadCount > 1 ? [...rootEntries, generatedEntry] : rootEntries,
        });
      },
    );

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(screen.queryByText("generated.txt")).not.toBeInTheDocument();
    mockExecuteUserSpaceOperation.mockClear();
    mockSnapshot = {
      ...mockSnapshot,
      recentOperations: [
        {
          id: "uwo-shell-1",
          mountId: "uw-mounted",
          operation: "shell_exec",
          status: "ok",
          message: "Completed",
          timestamp: Date.now(),
          changedDirs: [""],
        },
      ],
    };

    act(() => notifyWorkspace?.());

    expect(await screen.findByText("generated.txt")).toBeInTheDocument();
    expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
      "list_dir",
      expect.objectContaining({
        mountId: "uw-mounted",
        path: "",
      }),
    );
  });

  it("refreshes loaded user-space directories while a shell command reports file changes", async () => {
    let notifyWorkspace: (() => void) | null = null;
    mockSubscribeUserSpace.mockImplementation((listener: () => void) => {
      notifyWorkspace = listener;
      return () => {};
    });
    let rootLoadCount = 0;
    const generatedEntry = {
      name: "piwork-ruok-live",
      path: "piwork-ruok-live",
      kind: "directory" as const,
    };
    mockExecuteUserSpaceOperation.mockImplementation((_operation, input: { path?: string }) => {
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [{ name: "notes.txt", path: "docs/notes.txt", kind: "file", size: 9 }],
        });
      }
      rootLoadCount++;
      return Promise.resolve({
        entries: rootLoadCount > 1 ? [...rootEntries, generatedEntry] : rootEntries,
      });
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(screen.queryByText("piwork-ruok-live")).not.toBeInTheDocument();
    mockExecuteUserSpaceOperation.mockClear();
    mockSnapshot = {
      ...mockSnapshot,
      recentFileChanges: [
        {
          id: "uwfc-shell-live-1",
          mountId: "uw-mounted",
          timestamp: Date.now(),
          changedDirs: [""],
        },
      ],
    };

    act(() => notifyWorkspace?.());

    expect(await screen.findByText("piwork-ruok-live")).toBeInTheDocument();
    expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
      "list_dir",
      expect.objectContaining({
        mountId: "uw-mounted",
        path: "",
      }),
    );
  });

  it("shows dot-prefixed entries when the user space preference is enabled", async () => {
    mockUserSpacePreferences = {
      showHiddenEntries: true,
      searchHiddenEntries: false,
    };

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    expect(await screen.findByText(".git")).toBeInTheDocument();
    expect(screen.getByText(".env.local")).toBeInTheDocument();
    expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
      "list_dir",
      expect.objectContaining({
        includeHidden: true,
        mountId: "uw-mounted",
        path: "",
      }),
    );
  });

  it("opens unsupported file types in a preview tab with file details", async () => {
    const { rerender } = render(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="zh-CN" />,
    );

    const unsupported = await screen.findByRole("button", { name: "预览 archive.zip" });
    expect(unsupported).toBeEnabled();

    mockGetUserSpaceFile.mockClear();
    fireEvent.click(unsupported);

    expect(mockGetUserSpaceFile).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "切换预览 archive.zip" })).toBeInTheDocument();
    const previewDetails = screen.getByTestId("unsupported-preview-details");
    expect(previewDetails).toHaveClass("items-center", "justify-center");
    expect(previewDetails).not.toHaveClass("bg-danger-muted", "text-danger");
    expect(
      within(previewDetails).getByRole("heading", { name: "archive.zip" }),
    ).toBeInTheDocument();
    expect(within(previewDetails).getByText("ZIP归档")).toBeInTheDocument();
    expect(within(previewDetails).getByText("128 B")).toBeInTheDocument();
    expect(within(previewDetails).queryByText("路径")).not.toBeInTheDocument();
    expect(
      within(previewDetails).queryByText("无法预览此文件类型，可以用本地应用打开。"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("user-space-preview-toolbar-filename")).toHaveTextContent(
      "archive.zip",
    );
    expect(
      within(screen.getByTestId("user-space-preview-toolbar")).queryByRole("button", {
        name: "编辑",
      }),
    ).not.toBeInTheDocument();

    setUiCopyLanguage("en-US");
    rerender(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />);

    expect(screen.getByText("ZIP archive")).toBeInTheDocument();
    expect(
      screen.queryByText("This file type cannot be previewed. You can open it with a local app."),
    ).not.toBeInTheDocument();
  });

  it("refreshes fallback preview error copy immediately when the language changes", async () => {
    const { rerender } = render(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="zh-CN" />,
    );

    await screen.findByRole("button", { name: "预览 README.md" });
    mockGetUserSpaceFile.mockRejectedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "预览 README.md" }));

    expect(await screen.findByText("文件预览失败")).toBeInTheDocument();

    setUiCopyLanguage("en-US");
    rerender(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />);

    expect(screen.queryByText("文件预览失败")).not.toBeInTheDocument();
    expect(screen.getByText("File preview failed")).toBeInTheDocument();
  });

  it("shows a bilingual toast without opening a tab when a message anchor file moved", async () => {
    const nativeMessage =
      "A requested file or directory could not be found at the time an operation was processed.";
    mockGetUserSpaceFile.mockRejectedValue(new DOMException(nativeMessage, "NotFoundError"));
    const { rerender } = render(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="zh-CN" />,
    );

    await screen.findByRole("button", { name: "预览 README.md" });
    act(() => {
      requestUserSpaceFilePreview("s1", {
        path: "docs/README.md",
        name: "README.md",
      });
    });

    expect(await screen.findByText("找不到“README.md”。")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveClass("bg-danger-muted");
    expect(screen.queryByText(nativeMessage)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "切换预览 README.md" })).not.toBeInTheDocument();

    setUiCopyLanguage("en-US");
    rerender(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />);
    act(() => {
      requestUserSpaceFilePreview("s1", {
        path: "docs/README.md",
        name: "README.md",
      });
    });

    expect(await screen.findByText("“README.md” isn’t available.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Switch preview README.md" }),
    ).not.toBeInTheDocument();
  });

  it("opens a message anchor with the prefetched file only after it is confirmed to exist", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);
    await screen.findByRole("button", { name: "预览 README.md" });
    mockGetUserSpaceFile.mockClear();

    act(() => {
      requestUserSpaceFilePreview("s1", {
        path: "README.md",
        name: "README.md",
      });
    });

    expect(await screen.findByRole("button", { name: "切换预览 README.md" })).toBeInTheDocument();
    expect(mockGetUserSpaceFile).toHaveBeenCalledTimes(1);
  });

  it("uses distinct icons for Word, Excel, and PowerPoint files", async () => {
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "brief.docx",
          path: "brief.docx",
          kind: "file" as const,
          size: 12,
          previewKind: "office" as const,
        },
        {
          name: "budget.xlsx",
          path: "budget.xlsx",
          kind: "file" as const,
          size: 12,
          previewKind: "office" as const,
        },
        {
          name: "slides.pptx",
          path: "slides.pptx",
          kind: "file" as const,
          size: 12,
          previewKind: "office" as const,
        },
      ],
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const wordButton = await screen.findByRole("button", { name: "预览 brief.docx" });
    const spreadsheetButton = screen.getByRole("button", { name: "预览 budget.xlsx" });
    const presentationButton = screen.getByRole("button", { name: "预览 slides.pptx" });

    const wordIcon = wordButton.querySelector("[data-office-icon='word']");
    const spreadsheetIcon = spreadsheetButton.querySelector("[data-office-icon='spreadsheet']");
    const presentationIcon = presentationButton.querySelector("[data-office-icon='presentation']");
    expectFileIcon(wordIcon, "text-primary");
    expectFileIcon(spreadsheetIcon, "text-success");
    expectFileIcon(presentationIcon, "text-warning");
    expect(wordIcon).toHaveAttribute("data-iconify-icon", "material-icon-theme:word");
    expect(spreadsheetIcon).toHaveAttribute("data-iconify-icon", "material-icon-theme:table");
    expect(presentationIcon).toHaveAttribute("data-iconify-icon", "material-icon-theme:powerpoint");
  });

  it("uses distinct icons for HTML and Markdown files in the tree and preview tabs", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const markdownButton = await screen.findByRole("button", { name: "预览 README.md" });
    const htmlButton = screen.getByRole("button", { name: "预览 index.html" });
    const genericTextButton = screen.getByRole("button", { name: "预览 app.ts" });
    const textButton = screen.getByRole("button", { name: "预览 big.txt" });
    const pdfButton = screen.getByRole("button", { name: "预览 manual.pdf" });

    expectFileIcon(markdownButton.querySelector("[data-file-icon='markdown']"), "text-info");
    expectFileIcon(htmlButton.querySelector("[data-file-icon='html']"), "text-warning");
    expectFileIcon(
      genericTextButton.querySelector("[data-file-icon='text']"),
      "text-foreground/75",
    );
    expectFileIcon(textButton.querySelector("[data-file-icon='text']"), "text-foreground/75");
    const pdfIcon = pdfButton.querySelector("[data-file-icon='pdf']");
    expectFileIcon(pdfIcon, "text-danger");
    expect(pdfIcon).toHaveAttribute("data-iconify-icon", "material-icon-theme:pdf");

    fireEvent.click(markdownButton);
    fireEvent.click(htmlButton);

    expectFileIcon(
      screen
        .getByTestId("preview-tab-icon-uw-mounted:README.md")
        .querySelector("[data-file-icon='markdown']"),
      "text-info",
    );
    expectFileIcon(
      screen
        .getByTestId("preview-tab-icon-uw-mounted:index.html")
        .querySelector("[data-file-icon='html']"),
      "text-warning",
    );
  });

  it("previews audio and video files with native browser controls and media icons", async () => {
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "theme.mp3",
          path: "theme.mp3",
          kind: "file" as const,
          size: 128,
          previewKind: "audio" as const,
        },
        {
          name: "clip.mp4",
          path: "clip.mp4",
          kind: "file" as const,
          size: 256,
          previewKind: "video" as const,
        },
      ],
    });
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) => {
      if (path.endsWith(".mp3"))
        return Promise.resolve(new File(["audio"], "theme.mp3", { type: "audio/mpeg" }));
      if (path.endsWith(".mp4"))
        return Promise.resolve(new File(["video"], "clip.mp4", { type: "video/mp4" }));
      return defaultMockGetUserSpaceFile(_mountId, path);
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const audioButton = await screen.findByRole("button", { name: "预览 theme.mp3" });
    const videoButton = screen.getByRole("button", { name: "预览 clip.mp4" });
    expectFileIcon(audioButton.querySelector("[data-file-icon='audio']"), "text-success");
    expectFileIcon(videoButton.querySelector("[data-file-icon='video']"), "text-primary");

    fireEvent.click(audioButton);
    const audio = await screen.findByTestId("audio-preview-theme.mp3");
    expect(audio.tagName).toBe("AUDIO");
    expect(screen.getByTestId("user-space-preview-toolbar-filename")).toHaveTextContent(
      "theme.mp3",
    );
    expect(
      within(screen.getByTestId("user-space-preview-toolbar")).queryByRole("button", {
        name: "编辑",
      }),
    ).not.toBeInTheDocument();
    expect(audio).toHaveAttribute("controls");
    expect(audio).toHaveAttribute("src", "blob:http://localhost/workspace-preview");
    expect(audio.parentElement?.querySelector("svg")).toBeNull();
    expect(audio.className).not.toContain("rounded");
    expect(audio.parentElement?.className || "").not.toContain("bg-background");
    expect(audio.parentElement?.className || "").not.toContain("border");
    expect(audio.parentElement?.className || "").not.toContain("rounded");

    fireEvent.click(videoButton);
    const video = await screen.findByTestId("video-preview-clip.mp4");
    expect(video.tagName).toBe("VIDEO");
    expect(screen.getByTestId("user-space-preview-toolbar-filename")).toHaveTextContent("clip.mp4");
    expect(
      within(screen.getByTestId("user-space-preview-toolbar")).queryByRole("button", {
        name: "编辑",
      }),
    ).not.toBeInTheDocument();
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("src", "blob:http://localhost/workspace-preview");
    expect(video).toHaveClass("bg-background");
    expect(video.className).not.toContain("rounded");
    expect(video.parentElement).toHaveClass("bg-background");
    expect(video.parentElement?.className || "").not.toContain("rounded");
    expectFileIcon(
      screen
        .getByTestId("preview-tab-icon-uw-mounted:theme.mp3")
        .querySelector("[data-file-icon='audio']"),
      "text-success",
    );
    expectFileIcon(
      screen
        .getByTestId("preview-tab-icon-uw-mounted:clip.mp4")
        .querySelector("[data-file-icon='video']"),
      "text-primary",
    );
  });

  it("uses the zoom pan pinch viewer controls for image previews", async () => {
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "photo.png",
          path: "photo.png",
          kind: "file" as const,
          size: 128,
          previewKind: "image" as const,
        },
      ],
    });
    mockGetUserSpaceFile.mockResolvedValueOnce(
      new File(["image"], "photo.png", { type: "image/png" }),
    );

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 photo.png" }));
    expectFileIcon(
      screen
        .getByRole("button", { name: "预览 photo.png" })
        .querySelector("[data-file-icon='image']"),
      "text-info",
    );
    const imagePreview = await screen.findByTestId("image-preview-photo.png");
    const image = screen.getByTestId("image-preview-img-photo.png");
    const transformContent = screen.getByTestId("image-preview-transform-photo.png");
    const previewToolbar = screen.getByTestId("user-space-preview-toolbar");

    expect(image).toHaveAttribute("src", "blob:http://localhost/workspace-preview");
    expect(screen.getByTestId("user-space-preview-toolbar-filename")).toHaveTextContent(
      "photo.png",
    );
    expect(
      await within(previewToolbar).findByRole("button", {
        name: "编辑",
      }),
    ).toBeEnabled();
    expect(image.className).not.toContain("rounded");
    expect(image.className).not.toContain("shadow");
    expect(image.parentElement).toHaveClass("px-4", "py-3");
    expect(image.parentElement).not.toHaveClass("p-3");
    expect(screen.getByTestId("mock-transform-wrapper")).toHaveAttribute(
      "data-wheel-disabled",
      "true",
    );
    expect(screen.getByTestId("mock-transform-wrapper")).toHaveAttribute(
      "data-touchpad-disabled",
      "false",
    );
    expect(screen.getByTestId("mock-transform-wrapper")).toHaveAttribute(
      "data-trackpad-panning-disabled",
      "false",
    );
    expect(screen.getByTestId("mock-transform-wrapper")).toHaveAttribute(
      "data-trackpad-panning-velocity-disabled",
      "true",
    );
    expect(screen.getByTestId("image-preview-zoom-controls-photo.png")).toHaveClass(
      "piwork-superellipse-panel",
      "right-4",
      "top-3",
      "rounded-[var(--piwork-panel-radius)]",
    );
    expect(screen.getByTestId("image-preview-zoom-controls-photo.png")).not.toHaveClass("right-3");
    expect(screen.getByRole("button", { name: "缩小图片" })).toHaveClass(
      "piwork-superellipse",
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(screen.getByRole("button", { name: "放大图片" })).toHaveClass(
      "piwork-superellipse",
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(screen.getByRole("button", { name: "重置图片缩放" })).toHaveClass(
      "piwork-superellipse",
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(screen.getByTestId("image-preview-scale-photo.png")).toHaveTextContent("100%");
    expect(transformContent).toHaveStyle({ transform: "translate3d(0px, 0px, 0) scale(1)" });

    fireEvent.click(screen.getByRole("button", { name: "放大图片" }));
    await waitFor(() =>
      expect(screen.getByTestId("image-preview-scale-photo.png")).toHaveTextContent("120%"),
    );
    await waitFor(() =>
      expect(transformContent).toHaveStyle({ transform: "translate3d(0px, 0px, 0) scale(1.2)" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "缩小图片" }));
    await waitFor(() =>
      expect(screen.getByTestId("image-preview-scale-photo.png")).toHaveTextContent("100%"),
    );

    fireEvent.click(screen.getByRole("button", { name: "重置图片缩放" }));
    expect(screen.getByTestId("image-preview-scale-photo.png")).toHaveTextContent("100%");
    expect(transformContent).toHaveStyle({ transform: "translate3d(0px, 0px, 0) scale(1)" });
    expect(image).not.toHaveAttribute("style");
    expect(imagePreview).toBeInTheDocument();

    mockSaveUserSpaceFile.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "放大图片" }));
    await waitFor(() =>
      expect(screen.getByTestId("image-preview-scale-photo.png")).toHaveTextContent("120%"),
    );
    fireEvent.click(within(previewToolbar).getByRole("button", { name: "编辑" }));
    expect(await screen.findByTestId("image-editor-photo.png")).toBeInTheDocument();
    expect(await screen.findByTestId("image-editor-surface")).toHaveAttribute(
      "data-zoom-scale",
      "1.2",
    );
    await waitFor(() =>
      expect(screen.getByTestId("image-editor-photo.png")).toHaveClass("opacity-100"),
    );
    expect(screen.getByTestId("image-preview-photo.png").parentElement).toHaveClass("opacity-0");
    expect(
      within(previewToolbar).getByTestId("user-space-preview-editor-toolbar-slot"),
    ).toBeInTheDocument();
    expect(
      within(previewToolbar).queryByTestId("user-space-preview-toolbar-filename"),
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "mock image edit" }));
    await waitFor(() =>
      expect(screen.getByTestId("preview-tab-dirty-uw-mounted:photo.png")).toBeInTheDocument(),
    );
    expect(within(previewToolbar).getByRole("button", { name: "保存" })).toBeEnabled();
    fireEvent.click(within(previewToolbar).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mockSaveUserSpaceFile).toHaveBeenCalledTimes(1));
    const [savedMountId, savedPath, savedFile] = mockSaveUserSpaceFile.mock.calls[0] as [
      string,
      string,
      File,
    ];
    expect(savedMountId).toBe("uw-mounted");
    expect(savedPath).toBe("photo.png");
    expect(savedFile).toBeInstanceOf(File);
    expect(savedFile).toMatchObject({ name: "photo.png", type: "image/png", size: 12 });
    expect(await screen.findByTestId("image-preview-photo.png")).toBeInTheDocument();
  });

  it("keeps image zoom controls working after the preview moves to a detached window", async () => {
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "photo.png",
          path: "photo.png",
          kind: "file" as const,
          size: 128,
          previewKind: "image" as const,
        },
      ],
    });
    mockGetUserSpaceFile.mockResolvedValueOnce(
      new File(["image"], "photo.png", { type: "image/png" }),
    );
    const { popoutDocument, popoutWindow } = createMockDetachedPreviewWindow();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popoutWindow);

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);
    fireEvent.click(await screen.findByRole("button", { name: "预览 photo.png" }));
    expect(await screen.findByTestId("image-preview-scale-photo.png")).toHaveTextContent("100%");
    fireEvent.click(screen.getByRole("button", { name: "在新窗口打开" }));

    await waitFor(() =>
      expect(
        popoutDocument.querySelector("[data-testid='image-preview-photo.png']"),
      ).not.toBeNull(),
    );
    const scale = () =>
      popoutDocument.querySelector("[data-testid='image-preview-scale-photo.png']");
    const clickDetachedControl = (label: string) => {
      const button = popoutDocument.querySelector(`button[aria-label='${label}']`);
      expect(button).not.toBeNull();
      act(() =>
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
      );
    };

    clickDetachedControl("放大图片");
    await waitFor(() => expect(scale()?.textContent).toBe("120%"));
    clickDetachedControl("缩小图片");
    await waitFor(() => expect(scale()?.textContent).toBe("100%"));
    clickDetachedControl("放大图片");
    await waitFor(() => expect(scale()?.textContent).toBe("120%"));
    clickDetachedControl("重置图片缩放");
    await waitFor(() => expect(scale()?.textContent).toBe("100%"));

    popoutWindow.close();
    openSpy.mockRestore();
  });

  it("opens indexed text files even when their extension is unknown", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const dockerfile = await screen.findByRole("button", { name: "预览 Dockerfile.server" });
    fireEvent.click(dockerfile);

    await waitFor(() => {
      expect(mockGetUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "Dockerfile.server");
    });
    expect(
      await screen.findByRole("button", { name: "切换预览 Dockerfile.server" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/正在读取/)).not.toBeInTheDocument();
  });

  it("collapses and expands the preview pane from the mount toolbar's rightmost control", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await screen.findByText("README.md");

    expect(screen.queryByRole("button", { name: "关闭文件预览" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("工作区文件边栏")).toHaveStyle({
      gridTemplateColumns: "minmax(0, 1fr) 0px",
    });
    expect(screen.getByTestId("user-space-preview-pane")).toHaveAttribute("aria-hidden", "true");

    const unavailablePreviewToggle = screen.getByRole("button", { name: "展开文件预览" });
    expect(unavailablePreviewToggle).toBeDisabled();
    expect(unavailablePreviewToggle).toHaveClass(
      "disabled:cursor-not-allowed",
      "disabled:opacity-45",
    );
    fireEvent.click(unavailablePreviewToggle);

    expect(screen.getByLabelText("工作区文件边栏")).toHaveStyle({
      gridTemplateColumns: "minmax(0, 1fr) 0px",
    });
    expect(screen.getByTestId("user-space-preview-pane")).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(screen.getByRole("button", { name: "预览 README.md" }));

    expect(screen.getByLabelText("工作区文件边栏")).toHaveStyle({
      gridTemplateColumns: "28.571429% minmax(0, 1fr)",
    });
    expect(screen.getByTestId("user-space-preview-pane")).toBeInTheDocument();
    expect(screen.getByTestId("user-space-inner-divider")).toHaveClass(
      "w-px",
      "bg-border",
      "pointer-events-none",
    );
    expect(screen.queryByTestId("user-space-inner-resize-handle")).not.toBeInTheDocument();
    expect(screen.getByTestId("user-space-outer-divider")).toBeInTheDocument();

    const collapseButton = screen.getByRole("button", { name: "折叠文件预览" });
    expect(collapseButton).toBeEnabled();
    expect(screen.getByTestId("user-space-current-mount")).toHaveClass("min-w-0", "flex-1");
    expect(screen.getByTestId("user-space-current-mount").className).not.toContain("max-w-[calc");
    expect(screen.getByTestId("user-space-mount-controls")).toHaveClass(
      "ml-auto",
      "shrink-0",
      "pr-1",
    );
    expect(collapseButton.parentElement?.lastElementChild).toBe(collapseButton);
    expect(collapseButton).toHaveClass("h-6", "w-6", "hover:bg-accent");
    expect(collapseButton.querySelector(".lucide-file")).toBeInTheDocument();
    expect(collapseButton).toHaveAttribute("aria-pressed", "false");
    expect(collapseButton).not.toHaveStyle({ left: "28.571429%" });

    fireEvent.click(collapseButton);

    expect(screen.getByLabelText("工作区文件边栏")).toHaveStyle({
      gridTemplateColumns: "minmax(0, 1fr) 0px",
    });
    expect(screen.getByTestId("user-space-preview-pane")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByTestId("user-space-inner-divider")).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-space-inner-resize-handle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-space-outer-divider")).not.toBeInTheDocument();
    expect(screen.getByTestId("user-space-tree-panel")).not.toHaveClass("border-r");
    expect(screen.getByTestId("user-space-folded-tree-divider")).toHaveClass("w-px", "bg-border");
    expect(screen.getByRole("tablist", { name: "空间切换" })).toHaveClass("gap-1", "p-1");
    expect(screen.getByRole("tablist", { name: "空间切换" })).not.toHaveClass("pr-4");
    const expandButton = screen.getByRole("button", { name: "展开文件预览" });
    expect(expandButton.parentElement?.lastElementChild).toBe(expandButton);
    expect(expandButton).toHaveClass(
      "h-6",
      "w-6",
      "rounded-[var(--piwork-control-radius)]",
      "hover:bg-accent",
    );
    expect(expandButton.querySelector(".lucide-file")).toBeInTheDocument();
    expect(expandButton).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "展开文件预览" }));

    expect(screen.getByTestId("user-space-preview-pane")).toBeInTheDocument();
    expect(screen.getByTestId("user-space-preview-pane")).not.toHaveAttribute("aria-hidden");
    expect(screen.getByRole("button", { name: "折叠文件预览" })).toBeInTheDocument();
  });

  it("folds the preview pane without coordinating session-area visibility", async () => {
    const onPreviewOpenChange = vi.fn();
    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        previewOpen={true}
        onPreviewOpenChange={onPreviewOpenChange}
      />,
    );

    await screen.findByText("README.md");
    fireEvent.click(screen.getByRole("button", { name: "预览 README.md" }));
    onPreviewOpenChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "折叠文件预览" }));

    expect(onPreviewOpenChange).toHaveBeenCalledWith(false);
  });

  it("requests a layout reset when the final preview tab closes", async () => {
    const onPreviewOpenChange = vi.fn();

    function ControlledExplorer() {
      const [previewOpen, setPreviewOpen] = useState(false);
      return (
        <UserSpaceExplorer
          sessionId="s1"
          mounts={[mountedWorkspace]}
          previewOpen={previewOpen}
          onPreviewOpenChange={(open, options) => {
            onPreviewOpenChange(open, options);
            setPreviewOpen(open);
          }}
        />
      );
    }

    render(<ControlledExplorer />);
    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "折叠用户｜Agent空间面板",
      }),
    );
    expect(screen.getByLabelText("工作区文件边栏")).toHaveStyle({
      gridTemplateColumns: "0px minmax(0, 1fr)",
    });
    onPreviewOpenChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "关闭预览 README.md" }));

    expect(onPreviewOpenChange).toHaveBeenCalledWith(false, { resetLayout: true });
    expect(screen.getByRole("button", { name: "展开文件预览" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "预览 app.ts" }));
    expect(screen.getByLabelText("工作区文件边栏")).toHaveStyle({
      gridTemplateColumns: "28.571429% minmax(0, 1fr)",
    });
    expect(
      screen.getByRole("button", {
        name: "折叠用户｜Agent空间面板",
      }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps open preview tabs mounted while folding and unfolding the preview pane", async () => {
    const { container } = render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    const officePreview = await screen.findByTitle("Office 本地编辑 report.docx");
    expect(officePreview).toBe(
      container.querySelector('[data-piwork-office-preview-path="report.docx"]'),
    );
    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "折叠文件预览" }));

    expect(screen.getByTestId("user-space-preview-pane")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector('[data-piwork-office-preview-path="report.docx"]')).toBe(
      officePreview,
    );
    expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "展开文件预览" }));

    expect(screen.getByTestId("user-space-preview-pane")).not.toHaveAttribute("aria-hidden");
    expect(container.querySelector('[data-piwork-office-preview-path="report.docx"]')).toBe(
      officePreview,
    );
    expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1);
  });

  it("shows a HeroUI progress circle while an Office preview is opening", async () => {
    mockGetUserSpaceFile.mockImplementationOnce(() => new Promise<File>(() => {}));
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    expect(await screen.findByRole("button", { name: "切换预览 report.docx" })).toBeInTheDocument();
    expect(screen.getByTestId("office-loading-state")).toBeInTheDocument();
    expect(screen.getByLabelText("加载中...")).toBeInTheDocument();
  });

  it("disposes the local Office iframe when its preview tab closes", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    const officePreview = await screen.findByTitle("Office 本地编辑 report.docx");
    await waitFor(() =>
      expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({
          fileName: "report.docx",
          hostUrl: expect.any(Function),
          mode: "edit",
          readonly: false,
        }),
      ),
    );
    expect(mockCreateOfficeEditor.mock.calls.at(-1)?.[1]).not.toHaveProperty(
      "hardResetOnLastDestroy",
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭预览 report.docx" }));

    await waitFor(() => expect(officePreview).not.toBeInTheDocument());
    await waitFor(() => expect(mockOfficeEditorDestroy).toHaveBeenCalledTimes(1));
  });

  it("preserves Unicode Office file names when creating the local editor", async () => {
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "项目级别报告.docx",
          path: "项目级别报告.docx",
          kind: "file" as const,
          size: 12,
          previewKind: "office" as const,
        },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 项目级别报告.docx" }));

    expect(await screen.findByTitle("Office 本地编辑 项目级别报告.docx")).toBeInTheDocument();
    await waitFor(() =>
      expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({
          fileName: "项目级别报告.docx",
          mode: "edit",
          readonly: false,
        }),
      ),
    );
    expect(screen.getByTestId("user-space-preview-toolbar-filename")).toHaveTextContent(
      "项目级别报告.docx",
    );
  });

  it("opens zero-byte Office files with the OnlyOffice blank document source", async () => {
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "新建word.docx",
          path: "新建word.docx",
          kind: "file" as const,
          size: 0,
          previewKind: "office" as const,
        },
      ],
    });
    mockGetUserSpaceFile.mockImplementation((mountId: string, path: string) => {
      if (mountId === "uw-mounted" && path === "新建word.docx") {
        return Promise.resolve(
          new File([""], "新建word.docx", {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          }),
        );
      }
      return defaultMockGetUserSpaceFile(mountId, path);
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 新建word.docx" }));

    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1));
    const createOptions = mockCreateOfficeEditor.mock.calls.at(-1)?.[1] as {
      emptyType?: string;
      file?: File;
      fileName?: string;
    };
    expect(createOptions).toEqual(
      expect.objectContaining({
        emptyType: "docx",
        fileName: "新建word.docx",
      }),
    );
    expect(createOptions).not.toHaveProperty("file");
  });

  it("opens writable Office files directly in edit mode without an outer mode switch", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    expect(await screen.findByTitle("Office 本地编辑 report.docx")).toBeInTheDocument();
    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1));
    expect(mockCreateOfficeEditor.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        fileName: "report.docx",
        mode: "edit",
        readonly: false,
      }),
    );
    expect(screen.getByTestId("user-space-preview-toolbar-filename")).toHaveTextContent(
      "report.docx",
    );
    expect(screen.queryByTestId("user-space-office-mode-switch")).not.toBeInTheDocument();
  });

  it("does not enable return-to-preview controls for writable Office files", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    expect(await screen.findByTitle("Office 本地编辑 report.docx")).toBeInTheDocument();
    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("onlyoffice-return-preview-button")).not.toBeInTheDocument();
    expect(mockCreateOfficeEditor.mock.calls.at(-1)?.[1]).not.toHaveProperty("canReturnToPreview");

    const officeInstance = await mockCreateOfficeEditor.mock.results.at(-1)?.value;

    expect(screen.queryByTestId("onlyoffice-return-preview-button")).not.toBeInTheDocument();
    expect(officeInstance.setReadonly).not.toHaveBeenCalled();
  });

  it("ignores the legacy Office preference and keeps writable files in edit mode", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      word: "alternate",
    };
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    await waitFor(() =>
      expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({
          fileName: "report.docx",
          mode: "edit",
          readonly: false,
        }),
      ),
    );
    expect(await screen.findByTitle("Office 本地编辑 report.docx")).toBeInTheDocument();
    expect(screen.queryByTestId("user-space-office-mode-switch")).not.toBeInTheDocument();
  });

  it("passes the workspace theme to OnlyOffice and updates open editors without remounting", async () => {
    mockThemeMode = "dark";
    const { rerender } = render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    await waitFor(() =>
      expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({
          fileName: "report.docx",
          interfaceTheme: "dark",
        }),
      ),
    );
    const officeInstance = (await mockCreateOfficeEditor.mock.results.at(-1)?.value) as {
      setInterfaceTheme: ReturnType<typeof vi.fn>;
    };

    mockThemeMode = "light";
    rerender(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await waitFor(() => expect(officeInstance.setInterfaceTheme).toHaveBeenCalledWith("light"));
    expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1);
  });

  it("writes OnlyOffice saved files back to the mounted user space", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      word: "alternate",
    };
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    await waitFor(() =>
      expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({
          fileName: "report.docx",
          mode: "edit",
          readonly: false,
          saveBehavior: "callback",
          onSave: expect.any(Function),
        }),
      ),
    );

    const savedFile = new File(["updated"], "report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const onSave = mockCreateOfficeEditor.mock.calls.at(-1)?.[1]?.onSave as (
      file: File,
      instance?: unknown,
    ) => Promise<void>;

    await act(async () => {
      await onSave(savedFile);
    });

    expect(mockSaveUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "report.docx", savedFile);
    expect(screen.queryByTestId("onlyoffice-save-tip")).not.toBeInTheDocument();
  });

  it("keeps the live OnlyOffice editor mounted after a move and saves to the relocated path", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      word: "alternate",
    };
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "move_entries") {
        return Promise.resolve({
          ok: true,
          moves: [
            {
              sourcePath: "report.docx",
              path: "docs/report.docx",
              kind: "file",
            },
          ],
        });
      }
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [
            {
              name: "report.docx",
              path: "docs/report.docx",
              kind: "file",
              size: 12,
            },
          ],
        });
      }
      return Promise.resolve({ entries: rootEntries });
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));
    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1));
    const onSave = mockCreateOfficeEditor.mock.calls[0]?.[1]?.onSave as (
      file: File,
      instance?: unknown,
    ) => Promise<void>;

    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(screen.getByTestId("user-space-entry-row-uw-mounted:report.docx"), {
      dataTransfer,
    });
    const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("move_entries", {
        mountId: "uw-mounted",
        paths: ["report.docx"],
        targetDirPath: "docs",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("onlyoffice-browser-preview").firstElementChild).toHaveAttribute(
        "data-piwork-office-preview-path",
        "docs/report.docx",
      ),
    );
    expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1);
    expect(mockOfficeEditorDestroy).not.toHaveBeenCalled();

    const savedFile = new File(["relocated"], "report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await act(async () => {
      await onSave(savedFile);
    });

    expect(mockSaveUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "docs/report.docx", savedFile);
    expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1);
  });

  it("waits for a pending move before saving OnlyOffice content to the relocated path", async () => {
    const pendingMove = deferred<{
      ok: true;
      moves: Array<{ sourcePath: string; path: string; kind: "file" }>;
    }>();
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      word: "alternate",
    };
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "move_entries") return pendingMove.promise;
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [
            {
              name: "report.docx",
              path: "docs/report.docx",
              kind: "file",
              size: 12,
            },
          ],
        });
      }
      return Promise.resolve({ entries: rootEntries });
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));
    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1));
    const onSave = mockCreateOfficeEditor.mock.calls[0]?.[1]?.onSave as (
      file: File,
      instance?: unknown,
    ) => Promise<void>;

    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(screen.getByTestId("user-space-entry-row-uw-mounted:report.docx"), {
      dataTransfer,
    });
    const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("move_entries", {
        mountId: "uw-mounted",
        paths: ["report.docx"],
        targetDirPath: "docs",
      }),
    );

    const savedFile = new File(["saved while moving"], "report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    mockSaveUserSpaceFile.mockClear();
    let savePromise: Promise<void> | undefined;
    await act(async () => {
      savePromise = onSave(savedFile);
      await Promise.resolve();
    });
    expect(mockSaveUserSpaceFile).not.toHaveBeenCalled();

    await act(async () => {
      pendingMove.resolve({
        ok: true,
        moves: [{ sourcePath: "report.docx", path: "docs/report.docx", kind: "file" }],
      });
      await pendingMove.promise;
      await savePromise;
    });

    expect(mockSaveUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "docs/report.docx", savedFile);
    expect(mockSaveUserSpaceFile).not.toHaveBeenCalledWith("uw-mounted", "report.docx", savedFile);
  });

  it("saves OnlyOffice Save Copy As results into the mounted workspace instead of downloading", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      word: "alternate",
    };
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    await waitFor(() =>
      expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({
          fileName: "report.docx",
          mode: "edit",
          readonly: false,
          saveBehavior: "callback",
          onSaveAs: expect.any(Function),
        }),
      ),
    );

    const savedFile = new File(["copy"], "report.odt", {
      type: "application/vnd.oasis.opendocument.text",
    });
    const onSaveAs = mockCreateOfficeEditor.mock.calls.at(-1)?.[1]?.onSaveAs as (
      file: File,
      instance?: unknown,
    ) => Promise<void>;

    mockExecuteUserSpaceOperation.mockClear();
    mockGetUserSpaceFile.mockClear();
    await act(async () => {
      await onSaveAs(savedFile);
    });

    expect(mockSaveUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "report_副本.odt", savedFile, {
      create: true,
    });
    expect(mockSaveUserSpaceFile).not.toHaveBeenCalledWith("uw-mounted", "report.docx", savedFile);
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "list_dir",
        expect.objectContaining({
          mountId: "uw-mounted",
          path: "",
        }),
      ),
    );
    expect(mockGetUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "report_副本.odt");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "切换预览 report_副本.odt" })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("onlyoffice-save-tip")).toHaveTextContent(
        "已另存副本为 report_副本.odt",
      ),
    );
  });

  it("keeps the legacy source extension marker for OnlyOffice Save Copy As results", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      ppt: "alternate",
    };
    mockExecuteUserSpaceOperation.mockImplementation(() =>
      Promise.resolve({
        entries: [
          ...rootEntries,
          {
            name: "single_page_with_image.ppt",
            path: "single_page_with_image.ppt",
            kind: "file" as const,
            size: 12,
            previewKind: "office" as const,
          },
          {
            name: "single_page_with_image.pptx",
            path: "single_page_with_image.pptx",
            kind: "file" as const,
            size: 34,
            previewKind: "office" as const,
          },
        ],
      }),
    );
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) => {
      if (path === "single_page_with_image.ppt") {
        return Promise.resolve(
          new File(["legacy"], "single_page_with_image.ppt", {
            type: "application/vnd.ms-powerpoint",
          }),
        );
      }
      return defaultMockGetUserSpaceFile(_mountId, path);
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 single_page_with_image.ppt" }));

    await waitFor(() =>
      expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({
          fileName: "single_page_with_image.ppt",
          mode: "edit",
          readonly: false,
          saveBehavior: "callback",
          onSaveAs: expect.any(Function),
        }),
      ),
    );

    const savedFile = new File(["copy"], "single_page_with_image.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const onSaveAs = mockCreateOfficeEditor.mock.calls.at(-1)?.[1]?.onSaveAs as (
      file: File,
      instance?: unknown,
    ) => Promise<void>;

    await act(async () => {
      await onSaveAs(savedFile);
    });

    expect(mockSaveUserSpaceFile).toHaveBeenCalledWith(
      "uw-mounted",
      "single_page_with_image_ppt_副本.pptx",
      savedFile,
      { create: true },
    );
    expect(mockSaveUserSpaceFile).not.toHaveBeenCalledWith(
      "uw-mounted",
      "single_page_with_image.pptx",
      savedFile,
      expect.anything(),
    );
    expect(mockExecuteUserSpaceOperation).not.toHaveBeenCalledWith(
      "delete_entry",
      expect.anything(),
    );
  });

  it.each([
    {
      legacyPath: "legacy.doc",
      savedFileName: "legacy.docx",
      expectedPath: "legacy_doc.docx",
      preference: "word" as const,
      mime: "application/msword",
      outputMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    {
      legacyPath: "legacy.xls",
      savedFileName: "legacy.xlsx",
      expectedPath: "legacy_xls.xlsx",
      preference: "excel" as const,
      mime: "application/vnd.ms-excel",
      outputMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    {
      legacyPath: "legacy.ppt",
      savedFileName: "legacy.pptx",
      expectedPath: "legacy_ppt.pptx",
      preference: "ppt" as const,
      mime: "application/vnd.ms-powerpoint",
      outputMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
  ])(
    "confirms and migrates $legacyPath saves to $expectedPath before deleting the original",
    async ({ legacyPath, savedFileName, expectedPath, preference, mime, outputMime }) => {
      let legacyDeleted = false;
      mockFilePreviewDefaults = {
        ...createDefaultFilePreviewDefaults(),
        [preference]: "alternate",
      };
      mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
        if (operation === "delete_entry") {
          legacyDeleted = true;
          return Promise.resolve({ mountId: "uw-mounted", path: input.path, deleted: true });
        }
        if (input.path === "docs") {
          return Promise.resolve({
            entries: [{ name: "notes.txt", path: "docs/notes.txt", kind: "file", size: 9 }],
          });
        }
        return Promise.resolve({
          entries: [
            ...rootEntries,
            legacyDeleted
              ? {
                  name: expectedPath,
                  path: expectedPath,
                  kind: "file" as const,
                  size: 12,
                  previewKind: "office" as const,
                }
              : {
                  name: legacyPath,
                  path: legacyPath,
                  kind: "file" as const,
                  size: 12,
                  previewKind: "office" as const,
                },
          ],
        });
      });
      mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) => {
        if (path === legacyPath) {
          return Promise.resolve(new File(["legacy"], legacyPath, { type: mime }));
        }
        if (path === expectedPath) {
          return Promise.resolve(new File(["updated"], expectedPath, { type: outputMime }));
        }
        return defaultMockGetUserSpaceFile(_mountId, path);
      });

      render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

      fireEvent.click(await screen.findByRole("button", { name: `预览 ${legacyPath}` }));

      await waitFor(() =>
        expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
          expect.any(HTMLElement),
          expect.objectContaining({
            fileName: legacyPath,
            mode: "edit",
            readonly: false,
            saveBehavior: "callback",
            onSave: expect.any(Function),
          }),
        ),
      );

      const savedFile = new File(["updated"], savedFileName, {
        type: outputMime,
      });
      const officeInstance = (await mockCreateOfficeEditor.mock.results.at(-1)?.value) as {
        confirmSaveToNewFormat: ReturnType<typeof vi.fn>;
      };
      const onSave = mockCreateOfficeEditor.mock.calls.at(-1)?.[1]?.onSave as (
        file: File,
        instance: unknown,
      ) => Promise<void>;

      await act(async () => {
        await onSave(savedFile, officeInstance);
      });

      expect(officeInstance.confirmSaveToNewFormat).toHaveBeenCalledTimes(1);
      expect(mockSaveUserSpaceFile).toHaveBeenCalledWith("uw-mounted", expectedPath, savedFile, {
        create: true,
      });
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("delete_entry", {
        mountId: "uw-mounted",
        path: legacyPath,
      });
      await waitFor(() =>
        expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
          "list_dir",
          expect.objectContaining({
            mountId: "uw-mounted",
            path: "",
          }),
        ),
      );
      await waitFor(() =>
        expect(mockGetUserSpaceFile).toHaveBeenCalledWith("uw-mounted", expectedPath),
      );
      await waitFor(() =>
        expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
          expect.any(HTMLElement),
          expect.objectContaining({
            fileName: expectedPath,
            mode: "edit",
            readonly: false,
          }),
        ),
      );
    },
  );

  it("adds the original legacy suffix when migrating even if the OOXML basename already exists", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      ppt: "alternate",
    };
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "delete_entry") {
        return Promise.resolve({ mountId: "uw-mounted", path: input.path, deleted: true });
      }
      return Promise.resolve({
        entries: [
          ...rootEntries,
          {
            name: "single_page_with_image.ppt",
            path: "single_page_with_image.ppt",
            kind: "file" as const,
            size: 12,
            previewKind: "office" as const,
          },
          {
            name: "single_page_with_image.pptx",
            path: "single_page_with_image.pptx",
            kind: "file" as const,
            size: 34,
            previewKind: "office" as const,
          },
        ],
      });
    });
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) => {
      if (path === "single_page_with_image.ppt") {
        return Promise.resolve(
          new File(["legacy"], "single_page_with_image.ppt", {
            type: "application/vnd.ms-powerpoint",
          }),
        );
      }
      return defaultMockGetUserSpaceFile(_mountId, path);
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 single_page_with_image.ppt" }));

    await waitFor(() =>
      expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({
          fileName: "single_page_with_image.ppt",
          mode: "edit",
          readonly: false,
          saveBehavior: "callback",
          onSave: expect.any(Function),
        }),
      ),
    );

    const savedFile = new File(["updated"], "single_page_with_image.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const officeInstance = (await mockCreateOfficeEditor.mock.results.at(-1)?.value) as {
      confirmSaveToNewFormat: ReturnType<typeof vi.fn>;
    };
    const onSave = mockCreateOfficeEditor.mock.calls.at(-1)?.[1]?.onSave as (
      file: File,
      instance: unknown,
    ) => Promise<void>;

    await act(async () => {
      await onSave(savedFile, officeInstance);
    });

    expect(officeInstance.confirmSaveToNewFormat).toHaveBeenCalledTimes(1);
    expect(mockSaveUserSpaceFile).toHaveBeenCalledWith(
      "uw-mounted",
      "single_page_with_image_ppt.pptx",
      savedFile,
      { create: true },
    );
    expect(mockSaveUserSpaceFile).not.toHaveBeenCalledWith(
      "uw-mounted",
      "single_page_with_image.pptx",
      savedFile,
      expect.anything(),
    );
    expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("delete_entry", {
      mountId: "uw-mounted",
      path: "single_page_with_image.ppt",
    });
  });

  it("cancels legacy Office migration without saving or deleting the original", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      excel: "alternate",
    };
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "delete_entry") {
        return Promise.resolve({ mountId: "uw-mounted", path: input.path, deleted: true });
      }
      return Promise.resolve({
        entries: [
          ...rootEntries,
          {
            name: "legacy.xls",
            path: "legacy.xls",
            kind: "file" as const,
            size: 12,
            previewKind: "office" as const,
          },
        ],
      });
    });
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) => {
      if (path === "legacy.xls") {
        return Promise.resolve(
          new File(["legacy"], "legacy.xls", { type: "application/vnd.ms-excel" }),
        );
      }
      return defaultMockGetUserSpaceFile(_mountId, path);
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 legacy.xls" }));

    await waitFor(() =>
      expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({
          fileName: "legacy.xls",
          mode: "edit",
          readonly: false,
          onSave: expect.any(Function),
        }),
      ),
    );

    const savedFile = new File(["updated"], "legacy.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const officeInstance = (await mockCreateOfficeEditor.mock.results.at(-1)?.value) as {
      confirmSaveToNewFormat: ReturnType<typeof vi.fn>;
    };
    officeInstance.confirmSaveToNewFormat.mockResolvedValueOnce(false);
    const onSave = mockCreateOfficeEditor.mock.calls.at(-1)?.[1]?.onSave as (
      file: File,
      instance: unknown,
    ) => Promise<void>;
    let saveError: unknown;

    await act(async () => {
      try {
        await onSave(savedFile, officeInstance);
      } catch (error) {
        saveError = error;
      }
    });

    expect(saveError).toMatchObject({ name: "OfficeLegacyMigrationCancelled" });
    expect(officeInstance.confirmSaveToNewFormat).toHaveBeenCalledTimes(1);
    expect(mockSaveUserSpaceFile).not.toHaveBeenCalled();
    expect(mockExecuteUserSpaceOperation).not.toHaveBeenCalledWith(
      "delete_entry",
      expect.anything(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("onlyoffice-save-tip")).toHaveTextContent("已取消保存"),
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭 Office 保存提示" }));
    expect(screen.queryByTestId("onlyoffice-save-tip")).not.toBeInTheDocument();
  });

  it("does not show routine Office saving or saved banners", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      word: "alternate",
    };
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    await waitFor(() =>
      expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({
          fileName: "report.docx",
          mode: "edit",
          readonly: false,
          saveBehavior: "callback",
          onSave: expect.any(Function),
        }),
      ),
    );

    const savedFile = new File(["updated"], "report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const onSave = mockCreateOfficeEditor.mock.calls.at(-1)?.[1]?.onSave as (
      file: File,
      instance?: unknown,
    ) => Promise<void>;

    let resolveSave!: (value: { mountId: string; path: string; bytesWritten: number }) => void;
    mockSaveUserSpaceFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    let savePromise!: Promise<void>;
    act(() => {
      savePromise = onSave(savedFile);
    });

    await waitFor(() => expect(mockSaveUserSpaceFile).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("保存中...")).not.toBeInTheDocument();
    expect(screen.queryByTestId("onlyoffice-save-tip")).not.toBeInTheDocument();

    await act(async () => {
      resolveSave({ mountId: "uw-mounted", path: "report.docx", bytesWritten: 7 });
      await savePromise;
    });

    expect(screen.queryByText("已保存到用户空间")).not.toBeInTheDocument();
    expect(screen.queryByTestId("onlyoffice-save-tip")).not.toBeInTheDocument();
  });

  it("does not expose an external Office save button when the document becomes dirty", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      word: "alternate",
    };
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    await waitFor(() =>
      expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({
          fileName: "report.docx",
          mode: "edit",
          readonly: false,
          saveBehavior: "callback",
          onDirtyChange: expect.any(Function),
          onSave: expect.any(Function),
        }),
      ),
    );

    const officeTitlebar = screen.getByTestId("user-space-preview-toolbar");
    expect(within(officeTitlebar).getByText("report.docx")).toBeInTheDocument();
    expect(within(officeTitlebar).queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-space-office-mode-switch")).not.toBeInTheDocument();

    const createOptions = mockCreateOfficeEditor.mock.calls.at(-1)?.[1] as {
      onDirtyChange: (dirty: boolean, instance: unknown) => void;
    };
    const officeInstance = await mockCreateOfficeEditor.mock.results.at(-1)?.value;

    act(() => {
      createOptions.onDirtyChange(true, officeInstance);
    });

    expect(screen.getByTestId("user-space-preview-toolbar-filename")).toHaveTextContent(
      "report.docx",
    );
    expect(screen.getByTestId("preview-tab-dirty-uw-mounted:report.docx")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("user-space-preview-toolbar")).queryByRole("button", {
        name: "保存",
      }),
    ).not.toBeInTheDocument();
    expect(officeInstance.save).not.toHaveBeenCalled();
    expect(mockSaveUserSpaceFile).not.toHaveBeenCalled();
  });

  it("prepares missing document resources before mounting the Office editor", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      word: "alternate",
    };
    mockPlanOfficeResourcesForFile.mockResolvedValueOnce({
      planId: "word-plan",
      releaseId: "release-v3",
      scope: "document",
      profiles: ["base", "word"],
      totalBytes: 24 * 1024 * 1024,
      downloadBytes: 24 * 1024 * 1024,
      reusedBytes: 0,
    });
    mockOfficeResourcesReadyForRelease.mockReturnValueOnce(false).mockReturnValue(true);

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);
    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    expect(await screen.findByRole("dialog", { name: "准备 Office 资源" })).toBeInTheDocument();
    expect(mockCreateOfficeEditor).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "准备并打开" }));

    await waitFor(() => expect(mockApplyOfficeResourcePlan).toHaveBeenCalledOnce());
    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledOnce());
  });

  it("activates and probes a zero-download release before mounting the Office editor", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      word: "alternate",
    };
    mockOfficeResourcesReadyForRelease.mockReturnValueOnce(false).mockReturnValue(true);

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);
    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    await waitFor(() => expect(mockApplyOfficeResourcePlan).toHaveBeenCalledOnce());
    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledOnce());
    expect(mockApplyOfficeResourcePlan.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateOfficeEditor.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps the editor unmounted when canonical resource readiness remains incomplete", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      word: "alternate",
    };
    mockOfficeResourcesReadyForRelease.mockReturnValue(false);

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);
    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    expect(await screen.findByText(uiCopy.userSpace.office.resourcesNotReady)).toBeInTheDocument();
    expect(mockApplyOfficeResourcePlan).toHaveBeenCalledOnce();
    expect(mockCreateOfficeEditor).not.toHaveBeenCalled();
  });

  it("shows the localized 12-document limit when the constellation pool is exhausted", async () => {
    setUiCopyLanguage("en-US");
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      word: "alternate",
    };
    const capacityError = new Error("office-host-pool-exhausted");
    capacityError.name = "OfficeHostPoolExhaustedError";
    mockCreateOfficeEditor.mockRejectedValue(capacityError);

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview report.docx" }));

    expect(await screen.findByText(uiCopy.userSpace.office.openLimitReached)).toBeInTheDocument();
  });

  it("keeps Office previews readonly in the common viewer when the workspace is readonly", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      word: "alternate",
    };
    const readonlyWorkspace = {
      ...mountedWorkspace,
      access: "readonly" as const,
      canRead: true,
      canWrite: false,
    };
    mockSnapshot = { ...mockSnapshot, mounts: [readonlyWorkspace] };
    render(<UserSpaceExplorer sessionId="s1" mounts={[readonlyWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1));
    expect(mockCreateOfficeEditor.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        fileName: "report.docx",
        mode: "preview",
        readonly: true,
      }),
    );
    expect(await screen.findByTitle("Office 本地预览 report.docx")).toBeInTheDocument();
    expect(screen.queryByTestId("user-space-office-mode-switch")).not.toBeInTheDocument();
  });

  it("reopens an Office preview as readonly after workspace access changes to readonly", async () => {
    const { rerender } = render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1));
    expect(mockCreateOfficeEditor.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        mode: "edit",
        readonly: false,
      }),
    );

    const readonlyWorkspace = {
      ...mountedWorkspace,
      access: "readonly" as const,
      canRead: true,
      canWrite: false,
    };
    mockSnapshot = { ...mockSnapshot, mounts: [readonlyWorkspace] };

    rerender(<UserSpaceExplorer sessionId="s1" mounts={[readonlyWorkspace]} />);

    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockOfficeEditorDestroy).toHaveBeenCalledTimes(1));
    expect(mockOfficeEditorDestroy.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateOfficeEditor.mock.invocationCallOrder[1]!,
    );
    expect(mockCreateOfficeEditor.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        fileName: "report.docx",
        mode: "preview",
        readonly: true,
      }),
    );
  });

  it("preserves mixed Unicode Office file names when creating the local editor", async () => {
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "江西中材_AI_Agent落地方案书.docx",
          path: "江西中材_AI_Agent落地方案书.docx",
          kind: "file" as const,
          size: 12,
          previewKind: "office" as const,
        },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "预览 江西中材_AI_Agent落地方案书.docx" }),
    );

    expect(
      await screen.findByTitle("Office 本地编辑 江西中材_AI_Agent落地方案书.docx"),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({
          fileName: "江西中材_AI_Agent落地方案书.docx",
        }),
      );
    });
  });

  it("keeps Office iframes mounted while switching preview tabs", async () => {
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "report.docx",
          path: "report.docx",
          kind: "file" as const,
          size: 12,
          previewKind: "office" as const,
        },
        {
          name: "budget.xlsx",
          path: "budget.xlsx",
          kind: "file" as const,
          size: 12,
          previewKind: "office" as const,
        },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));
    const reportPreview = await screen.findByTitle("Office 本地编辑 report.docx");
    const reportFrame = reportPreview.querySelector("iframe.office-editor-host-frame");
    expect(reportPreview).toBeInTheDocument();
    expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole("button", { name: "预览 budget.xlsx" }));
    const budgetPreview = await screen.findByTitle("Office 本地编辑 budget.xlsx");
    expect(budgetPreview).toBeInTheDocument();
    expect(screen.getByTitle("Office 本地编辑 report.docx")).toBe(reportPreview);
    expect(reportPreview.querySelector("iframe.office-editor-host-frame")).toBe(reportFrame);
    expect(screen.getByTestId("preview-body-uw-mounted:report.docx")).toHaveClass("opacity-0");
    expect(screen.getByTestId("preview-body-uw-mounted:report.docx")).not.toHaveClass("invisible");
    expect(screen.getByTestId("preview-body-uw-mounted:report.docx")).not.toHaveClass("hidden");
    expect(screen.getByTestId("preview-body-uw-mounted:report.docx")).toHaveAttribute("inert");
    expect(screen.getAllByTestId("onlyoffice-browser-preview")).toHaveLength(2);
    expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(2);
    expect(mockCreateOfficeEditor.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        fileName: "budget.xlsx",
        mode: "edit",
        readonly: false,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "切换预览 report.docx" }));
    const nextReportPreview = await screen.findByTitle("Office 本地编辑 report.docx");
    expect(nextReportPreview).toBe(reportPreview);
    expect(screen.getByTitle("Office 本地编辑 budget.xlsx")).toBe(budgetPreview);
    expect(screen.getAllByTestId("onlyoffice-browser-preview")).toHaveLength(2);
    expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "关闭预览 budget.xlsx" }));

    expect(budgetPreview).not.toBeInTheDocument();
    expect(screen.getByTitle("Office 本地编辑 report.docx")).toBe(reportPreview);
    expect(reportPreview.querySelector("iframe.office-editor-host-frame")).toBe(reportFrame);
    await waitFor(() => expect(mockOfficeEditorDestroy).toHaveBeenCalledTimes(1));
  });

  it("keeps Office preview body DOM order stable when reordering tabs", async () => {
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "report.docx",
          path: "report.docx",
          kind: "file" as const,
          size: 12,
          previewKind: "office" as const,
        },
        {
          name: "budget.xlsx",
          path: "budget.xlsx",
          kind: "file" as const,
          size: 12,
          previewKind: "office" as const,
        },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));
    const reportPreview = await screen.findByTitle("Office 本地编辑 report.docx");
    fireEvent.click(await screen.findByRole("button", { name: "预览 budget.xlsx" }));
    const budgetPreview = await screen.findByTitle("Office 本地编辑 budget.xlsx");
    const bodyArea = screen.getByTestId("user-space-preview-body-area");
    const reportTab = screen.getByTestId("preview-tab-uw-mounted:report.docx");
    const budgetTab = screen.getByTestId("preview-tab-uw-mounted:budget.xlsx");

    expect(
      within(bodyArea)
        .getAllByTestId(/^preview-body-uw-mounted:/)
        .map((body) => body.getAttribute("data-testid")),
    ).toEqual(["preview-body-uw-mounted:report.docx", "preview-body-uw-mounted:budget.xlsx"]);

    mockElementFromPoint(budgetTab);
    fireEvent.pointerDown(reportTab, { button: 0, pointerId: 1, clientX: 120, clientY: 16 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 180, clientY: 18 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180, clientY: 18 });

    expect(
      within(screen.getByTestId("user-space-preview-tabbar"))
        .getAllByTestId(/^preview-tab-uw-mounted:/)
        .map((tab) => tab.getAttribute("data-testid")),
    ).toEqual(["preview-tab-uw-mounted:budget.xlsx", "preview-tab-uw-mounted:report.docx"]);
    expect(
      within(bodyArea)
        .getAllByTestId(/^preview-body-uw-mounted:/)
        .map((body) => body.getAttribute("data-testid")),
    ).toEqual(["preview-body-uw-mounted:report.docx", "preview-body-uw-mounted:budget.xlsx"]);

    fireEvent.click(screen.getByRole("button", { name: "切换预览 budget.xlsx" }));

    expect(screen.getByTitle("Office 本地编辑 report.docx")).toBe(reportPreview);
    expect(screen.getByTitle("Office 本地编辑 budget.xlsx")).toBe(budgetPreview);
    expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(2);
  });

  it("moves the OnlyOffice tab with single ownership, restores edit mode, and can dock it back", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      word: "alternate",
    };
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "report.docx",
          path: "report.docx",
          kind: "file" as const,
          size: 12,
          previewKind: "office" as const,
        },
      ],
    });
    const popoutDocument = document.implementation.createHTMLDocument("Detached preview");
    const popoutWindow = {
      closed: false,
      document: popoutDocument,
      close: vi.fn(() => {
        popoutWindow.closed = true;
      }),
      focus: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window & { closed: boolean };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popoutWindow);

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));
    const officeHost = await screen.findByTitle("Office 本地编辑 report.docx");
    expect(officeHost).toBeInTheDocument();
    expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        fileName: "report.docx",
        mode: "edit",
        readonly: false,
      }),
    );
    const mainOfficeOptions = mockCreateOfficeEditor.mock.calls.at(-1)?.[1] as {
      file: File;
      onStateChange?: (state: Record<string, unknown>, instance: unknown) => void | Promise<void>;
    };
    const initialOfficeFile = mainOfficeOptions.file;
    const mainOfficeInstance = await mockCreateOfficeEditor.mock.results.at(-1)?.value;
    await act(async () => {
      await mainOfficeOptions.onStateChange?.(
        {
          ...mainOfficeInstance.getState(),
          mode: "edit",
          readonly: false,
        },
        mainOfficeInstance,
      );
    });

    const reportTab = screen.getByTestId("preview-tab-uw-mounted:report.docx");
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const hasPointerCapture = vi.fn(() => true);
    Object.assign(reportTab, { setPointerCapture, releasePointerCapture, hasPointerCapture });
    const bodyArea = screen.getByTestId("user-space-preview-body-area");
    vi.spyOn(bodyArea, "getBoundingClientRect").mockReturnValue(
      createDomRect({
        x: 100,
        y: 100,
        width: 400,
        height: 300,
      }),
    );
    mockElementFromPoint(bodyArea);
    fireEvent.pointerDown(reportTab, { button: 0, pointerId: 1, clientX: 120, clientY: 16 });
    expect(screen.queryByTestId("user-space-preview-popout-dropzone")).not.toBeInTheDocument();
    expect(screen.getByTestId("user-space-preview-pointer-shield")).toHaveClass(
      "absolute",
      "inset-0",
      "bg-transparent",
    );

    fireEvent.pointerMove(window, { pointerId: 1, clientX: 240, clientY: 140 });
    const dropzone = screen.getByTestId("user-space-preview-popout-dropzone");
    expect(dropzone).toHaveClass("absolute", "inset-0", "bg-background/90");
    expect(dropzone).not.toHaveClass("backdrop-blur-md");
    expect(dropzone).not.toHaveClass("inset-2", "border", "border-dashed", "border-primary/60");

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 0, clientY: 0 });

    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(hasPointerCapture).toHaveBeenCalledWith(1);
    expect(releasePointerCapture).toHaveBeenCalledWith(1);
    expect(openSpy).toHaveBeenCalledWith("", "_blank", expect.stringContaining("width=1180"));
    await waitFor(() =>
      expect(
        popoutDocument.querySelector("[data-preview-surface-owner='detached']"),
      ).not.toBeNull(),
    );
    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockOfficeEditorDestroy).toHaveBeenCalledTimes(1));
    expect(mockCreateOfficeEditor.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        fileName: "report.docx",
        mode: "edit",
        readonly: false,
      }),
    );
    const detachedOfficeInstance = await mockCreateOfficeEditor.mock.results.at(-1)?.value;
    let savedFile!: File;
    await act(async () => {
      savedFile = await detachedOfficeInstance.save();
    });
    expect(mockSaveUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "report.docx", savedFile);
    expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(2);
    expect(mockOfficeEditorDestroy).toHaveBeenCalledTimes(1);
    Object.defineProperty(initialOfficeFile, "arrayBuffer", {
      configurable: true,
      value: vi
        .fn()
        .mockRejectedValue(
          new DOMException(
            "The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.",
            "NotReadableError",
          ),
        ),
    });
    Object.defineProperty(savedFile, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(new ArrayBuffer(7)),
    });
    expect(screen.queryByRole("button", { name: "切换预览 report.docx" })).not.toBeInTheDocument();
    expect(popoutDocument.querySelector("[title='Office 本地编辑 report.docx']")).not.toBe(
      officeHost,
    );
    expect(popoutDocument.title).toContain("report.docx");
    const detachedHeader = popoutDocument.querySelector(
      "[data-testid='detached-preview-window-header']",
    ) as HTMLElement;
    expect(detachedHeader).not.toBeNull();
    expect(detachedHeader.textContent).toContain("report.docx");
    expect(within(detachedHeader).queryByText("预览")).not.toBeInTheDocument();
    expect(detachedHeader.querySelector("button[aria-label='关闭预览 report.docx']")).toBeNull();
    const returnButton = detachedHeader.querySelector(
      "button[aria-label='移回标签组']",
    ) as HTMLButtonElement;
    expect(returnButton).not.toBeNull();
    act(() => {
      returnButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(await screen.findByRole("button", { name: "切换预览 report.docx" })).toBeInTheDocument();
    expect(popoutWindow.close).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(mockOfficeEditorDestroy).toHaveBeenCalledTimes(2));
    expect(mockCreateOfficeEditor.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ mode: "edit" }),
    );
    expect(mockCreateOfficeEditor.mock.calls.at(-1)?.[1]).not.toHaveProperty("canReturnToPreview");
    const dockedFile = mockCreateOfficeEditor.mock.calls.at(-1)?.[1]?.file as File;
    expect(dockedFile).toBe(savedFile);
    await expect(dockedFile.arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer);
    expect(screen.getByTitle("Office 本地编辑 report.docx")).not.toBe(officeHost);

    openSpy.mockRestore();
  });

  it("detaches the active file from the title-bar action without remounting its text editor", async () => {
    const { popoutDocument, popoutWindow } = createMockDetachedPreviewWindow();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popoutWindow);

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 app.ts" }));
    const editor = await screen.findByTestId("text-editor-uw-mounted:app.ts");
    const surface = screen.getByTestId("preview-body-uw-mounted:app.ts");
    const openInNewWindow = screen.getByRole("button", { name: "在新窗口打开" });
    expect(openInNewWindow).toHaveTextContent("");
    expect(openInNewWindow).toHaveAttribute("title", "在新窗口打开");
    expect(openInNewWindow.querySelector(".lucide-external-link")).toBeInTheDocument();

    fireEvent.click(openInNewWindow);

    expect(openSpy).toHaveBeenCalledWith("", "_blank", expect.stringContaining("width=1180"));
    await waitFor(() =>
      expect(popoutDocument.querySelector("[data-preview-surface-owner='detached']")).toBe(surface),
    );
    expect(popoutDocument.querySelector("[data-testid='text-editor-uw-mounted:app.ts']")).toBe(
      editor,
    );
    expect(screen.queryByRole("button", { name: "切换预览 app.ts" })).not.toBeInTheDocument();
    expect(popoutDocument.querySelector("button[aria-label='在新窗口打开']")).toBeNull();
    const returnButton = popoutDocument.querySelector(
      "button[aria-label='移回标签组']",
    ) as HTMLButtonElement;
    expect(returnButton).not.toBeNull();
    expect(returnButton.textContent).toBe("");
    expect(returnButton.querySelector(".lucide-panel-top-open")).not.toBeNull();

    popoutWindow.close();
    await waitFor(() =>
      expect(popoutDocument.querySelector("[data-preview-surface-owner]")).toBeNull(),
    );
    openSpy.mockRestore();
  });

  it("keeps Markdown WYSIWYG editing functional in a detached window", async () => {
    const { popoutDocument, popoutWindow } = createMockDetachedPreviewWindow();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popoutWindow);

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    const markdownEditor = await screen.findByTestId("markdown-editor-uw-mounted:README.md");
    expect(
      (await within(markdownEditor).findByRole("heading", { name: "Hello" })).textContent,
    ).toBe("Hello");
    mockExecuteUserSpaceOperation.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "在新窗口打开" }));

    await waitFor(() =>
      expect(
        popoutDocument.querySelector("[data-preview-surface-owner='detached']"),
      ).not.toBeNull(),
    );
    expect(
      popoutDocument.querySelector("[data-testid='markdown-editor-uw-mounted:README.md']"),
    ).toBe(markdownEditor);
    const detachedHeader = popoutDocument.querySelector(
      "[data-testid='detached-preview-window-header']",
    ) as HTMLElement;
    const editButton = detachedHeader.querySelector(
      "button[aria-label='编辑']",
    ) as HTMLButtonElement;
    act(() => {
      editButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const wysiwygEditor = await waitFor(() => {
      const editor = popoutDocument.querySelector(
        "[data-testid='mock-crepe-editor']",
      ) as HTMLDivElement | null;
      expect(editor).not.toBeNull();
      return editor as HTMLDivElement;
    });
    expect(markdownEditor.getAttribute("data-readonly")).toBe("false");
    expect(wysiwygEditor.getAttribute("contenteditable")).toBe("true");
    const markdownToolbar = popoutDocument.querySelector(
      "[role='toolbar'][aria-label='Markdown 编辑工具栏']",
    ) as HTMLElement;
    expect(markdownToolbar).not.toBeNull();
    expect(markdownToolbar.querySelector("button[aria-label='加粗']")).not.toBeNull();
    wysiwygEditor.dataset.markdown = "# Hello\n\nDetached WYSIWYG edit";
    act(() => {
      wysiwygEditor.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButton = await waitFor(() => {
      const button = detachedHeader.querySelector(
        "button[aria-label='保存']",
      ) as HTMLButtonElement | null;
      expect(button).not.toBeNull();
      expect(button?.disabled).toBe(false);
      return button as HTMLButtonElement;
    });
    act(() => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("write_file", {
        mountId: "uw-mounted",
        path: "README.md",
        content: "# Hello\n\nDetached WYSIWYG edit",
        createParents: false,
      }),
    );

    popoutWindow.close();
    await waitFor(() =>
      expect(popoutDocument.querySelector("[data-preview-surface-owner]")).toBeNull(),
    );
    openSpy.mockRestore();
  });

  it("keeps detached text preview controls, language, and theme in sync with the workbench", async () => {
    const { popoutDocument, popoutWindow } = createMockDetachedPreviewWindow();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popoutWindow);
    const originalHtmlClass = document.documentElement.className;
    const originalTheme = document.documentElement.dataset.theme;
    const originalColorScheme = document.documentElement.style.colorScheme;

    const { rerender } = render(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="zh-CN" />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "预览 app.ts" }));
    expect(await screen.findByTestId("text-editor-uw-mounted:app.ts")).toBeInTheDocument();

    const textTab = screen.getByTestId("preview-tab-uw-mounted:app.ts");
    Object.assign(textTab, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
    });
    const bodyArea = screen.getByTestId("user-space-preview-body-area");
    vi.spyOn(bodyArea, "getBoundingClientRect").mockReturnValue(
      createDomRect({
        x: 100,
        y: 100,
        width: 400,
        height: 300,
      }),
    );
    mockElementFromPoint(bodyArea);

    fireEvent.pointerDown(textTab, { button: 0, pointerId: 1, clientX: 120, clientY: 16 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 240, clientY: 140 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 240, clientY: 140 });

    expect(openSpy).toHaveBeenCalledWith("", "_blank", expect.stringContaining("width=1180"));
    expect(screen.queryByRole("button", { name: "切换预览 app.ts" })).not.toBeInTheDocument();
    const detachedHeader = await waitFor(() => {
      const header = popoutDocument.querySelector("[data-testid='detached-preview-window-header']");
      expect(header).not.toBeNull();
      return header as HTMLElement;
    });
    expect(within(detachedHeader).getByText("app.ts").textContent).toBe("app.ts");
    const editButton = detachedHeader.querySelector(
      "button[aria-label='编辑']",
    ) as HTMLButtonElement;
    expect(editButton).not.toBeNull();
    expect(editButton.disabled).toBe(false);
    act(() => {
      editButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => {
      const saveButton = detachedHeader.querySelector(
        "button[aria-label='保存']",
      ) as HTMLButtonElement | null;
      expect(saveButton).not.toBeNull();
      expect(saveButton?.disabled).toBe(false);
    });

    act(() => {
      document.documentElement.classList.add("dark", "detached-theme-probe");
      document.documentElement.dataset.theme = "dark";
      document.documentElement.style.colorScheme = "dark";
    });
    await waitFor(() => {
      expect(popoutDocument.documentElement.classList.contains("dark")).toBe(true);
      expect(popoutDocument.documentElement.classList.contains("detached-theme-probe")).toBe(true);
      expect(popoutDocument.documentElement.dataset.theme).toBe("dark");
      expect(popoutDocument.documentElement.style.colorScheme).toBe("dark");
    });

    setUiCopyLanguage("en-US");
    rerender(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />);
    await waitFor(() => {
      const saveButton = detachedHeader.querySelector(
        "button[aria-label='Save']",
      ) as HTMLButtonElement | null;
      expect(saveButton).not.toBeNull();
      expect(saveButton?.disabled).toBe(false);
    });
    expect(popoutDocument.documentElement.lang).toBe("en-US");
    act(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.classList.add("light");
      document.documentElement.dataset.theme = "light";
      document.documentElement.style.colorScheme = "light";
    });
    await waitFor(() => {
      expect(popoutDocument.documentElement.classList.contains("light")).toBe(true);
      expect(popoutDocument.documentElement.dataset.theme).toBe("light");
      expect(popoutDocument.documentElement.style.colorScheme).toBe("light");
      expect(popoutDocument.documentElement.lang).toBe("en-US");
    });
    const returnButton = detachedHeader.querySelector(
      "button[aria-label='Return to tab group']",
    ) as HTMLButtonElement;
    expect(returnButton).not.toBeNull();
    act(() => {
      returnButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(
      await screen.findByRole("button", { name: "Switch preview app.ts" }),
    ).toBeInTheDocument();
    expect(popoutWindow.close).toHaveBeenCalledTimes(1);

    act(() => {
      document.documentElement.className = originalHtmlClass;
      if (originalTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = originalTheme;
      document.documentElement.style.colorScheme = originalColorScheme;
    });
    setUiCopyLanguage("zh-CN");
    openSpy.mockRestore();
  });

  it("closes the owned tab and destroys its single Office editor when a detached window closes", async () => {
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "report.docx",
          path: "report.docx",
          kind: "file" as const,
          size: 12,
          previewKind: "office" as const,
        },
      ],
    });
    const { popoutWindow } = createMockDetachedPreviewWindow();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popoutWindow);

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));
    const mainHost = await screen.findByTitle("Office 本地编辑 report.docx");
    await waitFor(() =>
      expect(mainHost.querySelector("iframe.office-editor-host-frame")).toBeInTheDocument(),
    );
    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1));

    const reportTab = screen.getByTestId("preview-tab-uw-mounted:report.docx");
    Object.assign(reportTab, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
    });
    const bodyArea = screen.getByTestId("user-space-preview-body-area");
    vi.spyOn(bodyArea, "getBoundingClientRect").mockReturnValue(
      createDomRect({
        x: 100,
        y: 100,
        width: 400,
        height: 300,
      }),
    );
    mockElementFromPoint(bodyArea);

    fireEvent.pointerDown(reportTab, { button: 0, pointerId: 1, clientX: 120, clientY: 16 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 240, clientY: 140 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 240, clientY: 140 });

    expect(openSpy).toHaveBeenCalledWith("", "_blank", expect.stringContaining("width=1180"));
    await waitFor(() =>
      expect(
        popoutWindow.document.querySelector("[data-preview-surface-owner='detached']"),
      ).not.toBeNull(),
    );
    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockOfficeEditorDestroy).toHaveBeenCalledTimes(1));
    expect(mockOfficeEditorDestroy.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateOfficeEditor.mock.invocationCallOrder[1]!,
    );
    expect(screen.queryByRole("button", { name: "切换预览 report.docx" })).not.toBeInTheDocument();
    expect(mainHost.querySelector("iframe.office-editor-host-frame")).not.toBeInTheDocument();
    expect(popoutWindow.document.querySelector("iframe.office-editor-host-frame")).not.toBeNull();

    popoutWindow.close();

    await waitFor(() => expect(mockOfficeEditorDestroy).toHaveBeenCalledTimes(2));
    expect(mainHost.querySelector("iframe.office-editor-host-frame")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "切换预览 report.docx" })).not.toBeInTheDocument();

    openSpy.mockRestore();
  });

  it("keeps remaining tabs switchable after closing a tab that owns a detached preview window", async () => {
    const { popoutWindow } = createMockDetachedPreviewWindow();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popoutWindow);

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));
    expect(await screen.findByRole("button", { name: "切换预览 report.docx" })).toBeInTheDocument();
    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "预览 README.md" }));
    expect(await screen.findByRole("button", { name: "切换预览 README.md" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "预览 app.ts" }));
    expect(await screen.findByRole("button", { name: "切换预览 app.ts" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("preview-tab-uw-mounted:app.ts")).toHaveClass("bg-accent"),
    );

    const reportTab = screen.getByTestId("preview-tab-uw-mounted:report.docx");
    Object.assign(reportTab, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
    });
    const bodyArea = screen.getByTestId("user-space-preview-body-area");
    vi.spyOn(bodyArea, "getBoundingClientRect").mockReturnValue(
      createDomRect({
        x: 100,
        y: 100,
        width: 400,
        height: 300,
      }),
    );
    mockElementFromPoint(bodyArea);

    fireEvent.pointerDown(reportTab, { button: 0, pointerId: 1, clientX: 120, clientY: 16 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 240, clientY: 140 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 240, clientY: 140 });

    expect(openSpy).toHaveBeenCalledWith("", "_blank", expect.stringContaining("width=1180"));
    await waitFor(() =>
      expect(
        popoutWindow.document.querySelector("[data-preview-surface-owner='detached']"),
      ).not.toBeNull(),
    );
    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockOfficeEditorDestroy).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "切换预览 report.docx" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-space-preview-pointer-shield")).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-space-preview-popout-dropzone")).not.toBeInTheDocument();

    popoutWindow.close();
    await waitFor(() => expect(mockOfficeEditorDestroy).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "切换预览 README.md" }));

    expect(screen.getByTestId("preview-tab-uw-mounted:README.md")).toHaveClass(
      "bg-accent",
      "text-foreground",
    );
    expect(screen.getByTestId("preview-tab-uw-mounted:app.ts")).toHaveClass("bg-transparent");

    fireEvent.click(screen.getByRole("button", { name: "切换预览 app.ts" }));

    expect(screen.getByTestId("preview-tab-uw-mounted:app.ts")).toHaveClass(
      "bg-accent",
      "text-foreground",
    );
    expect(screen.getByTestId("preview-tab-uw-mounted:README.md")).toHaveClass("bg-transparent");

    openSpy.mockRestore();
  });

  it("recycles many Office previews after opening and closing all tabs", async () => {
    const officeEntries = Array.from({ length: 10 }, (_, index) => {
      const number = index + 1;
      return {
        name: `office-${number}.docx`,
        path: `office-${number}.docx`,
        kind: "file" as const,
        size: 12,
        previewKind: "office" as const,
      };
    });
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({ entries: officeEntries });
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) =>
      Promise.resolve(
        new File([path], path, {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      ),
    );

    const { container } = render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    for (const entry of officeEntries) {
      fireEvent.click(await screen.findByRole("button", { name: `预览 ${entry.name}` }));
      expect(
        await screen.findByRole("button", { name: `切换预览 ${entry.name}` }),
      ).toBeInTheDocument();
    }

    expect(screen.getAllByTestId("onlyoffice-browser-preview")).toHaveLength(officeEntries.length);
    expect(container.querySelectorAll("div[data-piwork-office-preview-path]")).toHaveLength(
      officeEntries.length,
    );
    await waitFor(() => expect(mockCreateOfficeEditor).toHaveBeenCalledTimes(officeEntries.length));

    await closeAllPreviewsFromTabMenu();

    await waitFor(() =>
      expect(screen.queryAllByTestId("onlyoffice-browser-preview")).toHaveLength(0),
    );
    expect(container.querySelectorAll("div[data-piwork-office-preview-path]")).toHaveLength(0);
    await waitFor(() =>
      expect(mockOfficeEditorDestroy).toHaveBeenCalledTimes(officeEntries.length),
    );
  });

  it("moves close-all to the preview-tab context menu and closes every tab", async () => {
    const createObjectURL = vi.mocked(globalThis.URL.createObjectURL);
    const revokeObjectURL = vi.mocked(globalThis.URL.revokeObjectURL);
    createObjectURL
      .mockImplementationOnce(() => "blob:http://localhost/readme-preview")
      .mockImplementationOnce(() => "blob:http://localhost/app-preview");

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    expect(await screen.findByRole("button", { name: "切换预览 README.md" })).toBeInTheDocument();
    const markdownEditor = await screen.findByTestId("markdown-editor-uw-mounted:README.md");
    expect(
      (await within(markdownEditor).findByRole("heading", { name: "Hello" })).textContent,
    ).toBe("Hello");

    fireEvent.click(await screen.findByRole("button", { name: "预览 app.ts" }));
    expect(await screen.findByRole("button", { name: "切换预览 app.ts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换预览 README.md" })).toBeInTheDocument();
    expect(await screen.findByTestId("text-editor-uw-mounted:app.ts")).toBeInTheDocument();

    fireEvent.contextMenu(screen.getByTestId("user-space-tree-blank-area"));
    const wtermMenuItem = await screen.findByRole("menuitem", { name: "打开 wterm" });
    expect(screen.queryByRole("menuitem", { name: "关闭所有" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    const inactiveReadmeTab = screen.getByTestId("preview-tab-uw-mounted:README.md");
    fireEvent.contextMenu(inactiveReadmeTab);
    const closeAllMenuItem = await screen.findByRole("menuitem", {
      name: "关闭所有",
    });
    expect(inactiveReadmeTab).toHaveAttribute("data-state", "open");
    expect(inactiveReadmeTab).toHaveClass(
      "piwork-context-target-trigger",
      "data-[state=open]:bg-accent",
      "data-[state=open]:text-foreground",
    );
    expect(closeAllMenuItem.querySelector(".lucide-list-x")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "关闭当前" }).querySelector(".lucide-x"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "关闭其他" }).querySelector(".lucide-circle-x"),
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "在新窗口打开" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "添加到会话" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    const activeAppTab = screen.getByTestId("preview-tab-uw-mounted:app.ts");
    fireEvent.contextMenu(activeAppTab);
    expect(await screen.findByRole("menuitem", { name: "关闭所有" })).toBeInTheDocument();
    expect(activeAppTab).toHaveClass("piwork-context-target-trigger");
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭所有" }));

    expect(screen.getByTestId("user-space-preview-pane")).toBeInTheDocument();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledTimes(2));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/readme-preview");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/app-preview");

    expect(screen.queryByRole("button", { name: "切换预览 README.md" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "切换预览 app.ts" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-space-preview-toolbar")).not.toBeInTheDocument();
    expect(screen.queryByText("选择左侧文件后在这里预览。")).not.toBeInTheDocument();
    createObjectURL.mockReturnValue("blob:http://localhost/workspace-preview");
  });

  it("adds a preview to the conversation, closes others, and closes the selected tab", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    for (const name of ["README.md", "app.ts", "index.html"]) {
      fireEvent.click(await screen.findByRole("button", { name: `预览 ${name}` }));
      await screen.findByRole("button", { name: `切换预览 ${name}` });
    }

    fireEvent.contextMenu(screen.getByTestId("preview-tab-uw-mounted:app.ts"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "添加到会话" }));
    expect(getUserSpaceFileRefs("s1")).toEqual([
      {
        rootName: "Client Files",
        path: "app.ts",
        name: "app.ts",
      },
    ]);

    fireEvent.contextMenu(screen.getByTestId("preview-tab-uw-mounted:app.ts"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "关闭其他" }));
    expect(screen.queryByRole("button", { name: "切换预览 README.md" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换预览 app.ts" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "切换预览 index.html" })).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByTestId("preview-tab-uw-mounted:app.ts"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "关闭当前" }));
    expect(screen.queryByRole("button", { name: "切换预览 app.ts" })).not.toBeInTheDocument();
  });

  it("pins tabs before movable tabs and requires unpinning before close", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    for (const name of ["README.md", "app.ts", "index.html"]) {
      fireEvent.click(await screen.findByRole("button", { name: `预览 ${name}` }));
      await screen.findByRole("button", { name: `切换预览 ${name}` });
    }

    const tabbar = screen.getByTestId("user-space-preview-tabbar");
    const tabScroll = screen.getByTestId("user-space-preview-tab-scroll");
    const tabOrder = () =>
      Array.from(tabbar.querySelectorAll<HTMLElement>("[data-preview-tab-id]"), (tab) =>
        tab.getAttribute("data-preview-tab-id"),
      );

    fireEvent.contextMenu(screen.getByTestId("preview-tab-uw-mounted:index.html"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "固定标签页" }));

    expect(tabOrder()).toEqual(["uw-mounted:README.md", "uw-mounted:app.ts"]);
    const pinnedGroup = screen.getByTestId("preview-pinned-tab-group");
    const pinnedGroupToggle = screen.getByTestId("preview-pinned-tab-group-toggle");
    expect(pinnedGroup).not.toHaveClass("border-r", "border-border");
    expect(pinnedGroup).toHaveClass("pr-0");
    expect(
      pinnedGroup.compareDocumentPosition(tabScroll) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(pinnedGroupToggle.querySelector(".lucide-pin")).toBeInTheDocument();
    expect(pinnedGroupToggle.querySelector(".lucide-chevron-down")).toBeInTheDocument();
    expect(pinnedGroupToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("preview-pinned-tab-list")).not.toBeInTheDocument();
    fireEvent.click(pinnedGroupToggle);
    expect(pinnedGroupToggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.pointerEnter(pinnedGroup);
    expect(pinnedGroupToggle).toHaveAttribute("aria-expanded", "true");
    expect(pinnedGroupToggle.querySelector(".lucide-chevron-up")).toBeInTheDocument();
    expect(within(pinnedGroupToggle).getByText("1")).toHaveClass("text-[13px]", "tabular-nums");
    expect(screen.getByTestId("preview-pinned-tab-list")).toHaveClass("flex-col", "top-full");
    expect(screen.getByTestId("preview-pinned-tab-list")).not.toHaveClass("shadow-lg");
    let pinnedTab = screen.getByTestId("preview-tab-uw-mounted:index.html");
    expect(
      within(pinnedTab).queryByRole("button", { name: "关闭预览 index.html" }),
    ).not.toBeInTheDocument();
    fireEvent.pointerLeave(pinnedGroup);
    expect(screen.queryByTestId("preview-tab-uw-mounted:index.html")).not.toBeInTheDocument();
    expect(pinnedGroupToggle).toHaveAttribute("aria-expanded", "false");
    expect(pinnedGroupToggle.querySelector(".lucide-chevron-down")).toBeInTheDocument();
    fireEvent.pointerEnter(pinnedGroup);
    fireEvent.blur(window);
    expect(screen.queryByTestId("preview-pinned-tab-list")).not.toBeInTheDocument();
    expect(pinnedGroupToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.pointerEnter(pinnedGroup);
    pinnedTab = screen.getByTestId("preview-tab-uw-mounted:index.html");

    fireEvent.contextMenu(pinnedGroupToggle);
    expect(await screen.findByRole("menuitem", { name: "取消所有固定" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "关闭所有固定" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    fireEvent.pointerDown(pinnedTab, { button: 0, pointerId: 1, clientX: 120, clientY: 16 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 260, clientY: 16 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 260, clientY: 16 });
    expect(tabOrder()).toEqual(["uw-mounted:README.md", "uw-mounted:app.ts"]);
    expect(screen.queryByTestId("preview-tab-drag-proxy")).not.toBeInTheDocument();

    fireEvent.pointerEnter(pinnedGroup);
    pinnedTab = screen.getByTestId("preview-tab-uw-mounted:index.html");
    fireEvent.contextMenu(pinnedTab);
    expect(await screen.findByRole("menuitem", { name: "取消固定标签页" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "关闭当前" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭所有" }));

    expect(screen.getByRole("button", { name: "切换预览 index.html" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "切换预览 README.md" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "切换预览 app.ts" })).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByTestId("preview-pinned-tab-group-toggle"));
    expect(screen.queryByRole("menuitem", { name: "关闭所有" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "关闭其他" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "取消所有固定" }));

    expect(screen.getByRole("button", { name: "关闭预览 index.html" })).toBeInTheDocument();
    expect(screen.queryByTestId("preview-pinned-tab-group")).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTestId("preview-tab-uw-mounted:index.html"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "关闭当前" }));
    expect(screen.queryByRole("button", { name: "切换预览 index.html" })).not.toBeInTheDocument();
  });

  it("closes every pinned tab from the pinned-group context menu", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    for (const name of ["README.md", "app.ts"]) {
      fireEvent.click(await screen.findByRole("button", { name: `预览 ${name}` }));
      await screen.findByRole("button", { name: `切换预览 ${name}` });
      fireEvent.contextMenu(screen.getByTestId(`preview-tab-uw-mounted:${name}`));
      fireEvent.click(await screen.findByRole("menuitem", { name: "固定标签页" }));
    }

    expect(screen.getByTestId("preview-pinned-tab-group-toggle")).toHaveTextContent("2");
    fireEvent.contextMenu(screen.getByTestId("preview-pinned-tab-group-toggle"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "关闭所有固定" }));

    expect(screen.queryByTestId("preview-pinned-tab-group")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "切换预览 README.md" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "切换预览 app.ts" })).not.toBeInTheDocument();
  });

  it("opens a preview tab in a new window from its context menu", async () => {
    const popout = createMockDetachedPreviewWindow();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popout.popoutWindow);
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    await screen.findByRole("button", { name: "切换预览 README.md" });
    fireEvent.contextMenu(screen.getByTestId("preview-tab-uw-mounted:README.md"));

    expect(screen.queryByRole("menuitem", { name: "关闭所有" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "关闭其他" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "关闭当前" })).toBeInTheDocument();
    const menu = screen.getByRole("menu");
    expect(menu.querySelectorAll("svg")).toHaveLength(4);
    fireEvent.click(screen.getByRole("menuitem", { name: "在新窗口打开" }));

    expect(openSpy).toHaveBeenCalledWith("", "_blank", expect.stringContaining("width=1180"));
    await waitFor(() =>
      expect(
        popout.popoutDocument.querySelector("[data-preview-surface-owner='detached']"),
      ).not.toBeNull(),
    );
    popout.popoutWindow.close();
    openSpy.mockRestore();
  });

  it("localizes preview-tab context-menu actions in English", async () => {
    setUiCopyLanguage("en-US");
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />);

    fireEvent.click(await screen.findByRole("button", { name: "Preview README.md" }));
    await screen.findByRole("button", { name: "Switch preview README.md" });
    fireEvent.contextMenu(screen.getByTestId("preview-tab-uw-mounted:README.md"));

    expect(screen.queryByRole("menuitem", { name: "Close All" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Close Current" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    fireEvent.click(await screen.findByRole("button", { name: "Preview app.ts" }));
    await screen.findByRole("button", { name: "Switch preview app.ts" });
    fireEvent.click(await screen.findByRole("button", { name: "Preview index.html" }));
    await screen.findByRole("button", { name: "Switch preview index.html" });
    fireEvent.contextMenu(screen.getByTestId("preview-tab-uw-mounted:app.ts"));

    const closeAllMenuItem = await screen.findByRole("menuitem", {
      name: "Close All",
    });
    expect(screen.getByRole("menuitem", { name: "Open in new window" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Add to conversation" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Close Current" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Close Others" })).toBeInTheDocument();

    fireEvent.click(closeAllMenuItem);
    expect(
      screen.queryByRole("button", { name: "Switch preview README.md" }),
    ).not.toBeInTheDocument();
  });

  it("keeps workspace and preview panel colors and typography aligned", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const workspaceHeader = screen.getByRole("tablist", { name: "空间切换" }).parentElement;
    const previewPane = screen.getByTestId("user-space-preview-pane");
    const previewTabbar = screen.getByTestId("user-space-preview-tabbar");
    const previewBodyArea = screen.getByTestId("user-space-preview-body-area");

    expect(workspaceHeader).toHaveClass("h-10", "border-b", "border-border", "bg-card");
    expect(screen.getByRole("tablist", { name: "空间切换" })).toHaveClass("gap-1", "p-1");
    expect(screen.getByRole("tablist", { name: "空间切换" })).not.toHaveClass("gap-2", "p-2");
    expect(previewPane).toHaveClass("bg-background", "text-xs", "text-foreground/75");
    expect(previewTabbar).toHaveClass("h-10", "border-b", "border-border", "bg-card");
    expect(previewBodyArea).toHaveClass("bg-background", "text-xs", "text-foreground/75");
    expect(screen.getByRole("tab", { name: "用户空间" })).toHaveClass(
      "h-full",
      "bg-accent",
      "text-foreground",
    );
    expect(screen.getByRole("tab", { name: "用户空间" })).not.toHaveClass(
      "piwork-theme-selected-tab",
    );
    expect(screen.getByRole("tab", { name: "用户空间" }).className).toContain(
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(screen.getByRole("tab", { name: "Agent空间" })).toHaveClass(
      "h-full",
      "bg-transparent",
      "text-foreground",
    );
    expect(screen.getByRole("tab", { name: "Agent空间" })).not.toHaveClass("text-muted-foreground");
    expect(screen.queryByText("文件预览")).not.toBeInTheDocument();
  });

  it("keeps the file preview toolbar on the same fixed 40px row as the mount toolbar", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));

    const previewToolbar = await screen.findByTestId("user-space-preview-toolbar");
    expect(screen.getByTestId("user-space-mount-switcher")).toHaveClass("h-10");
    expect(previewToolbar).toHaveClass("h-10");
    expect(previewToolbar).not.toHaveClass("min-h-10");
  });

  it("keeps a 4px gap between the mount toolbar and the file tree", () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    expect(screen.getByTestId("user-space-tree-pane")).toHaveClass("pt-1");
    expect(screen.getByTestId("user-space-tree-pane")).not.toHaveClass("pt-0.5");
  });

  it("renders Agent space as an expanded workspace tree even when empty", async () => {
    mockGetAgentSpaceTree.mockResolvedValue({ path: "", rootName: "workspace", tree: [] });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));

    const agentTree = await screen.findByTestId("agent-space-tree");
    expect(mockGetAgentSpaceTree).toHaveBeenCalledWith("s1");
    expect(within(agentTree).getByTestId("agent-space-root").className).toContain(
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(within(agentTree).getByTestId("agent-space-root")).toHaveClass("mx-1");
    expect(within(agentTree).getByTestId("agent-space-root")).toHaveClass("text-foreground");
    expect(within(agentTree).getByTestId("agent-space-root")).not.toHaveClass(
      "text-muted-foreground",
      "hover:text-foreground",
    );
    expect(within(agentTree).getByTestId("agent-space-root")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(agentTree).getByRole("button", { name: "收起 workspace" })).toBeInTheDocument();
    expect(within(agentTree).getByText("workspace")).toBeInTheDocument();
    expect(within(agentTree).queryByText("cwd")).not.toBeInTheDocument();
    expect(within(agentTree).queryByText("目录为空")).not.toBeInTheDocument();
  });

  it("renders nested Agent space directories with the same tree affordances", async () => {
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [
        {
          name: "src",
          path: "src",
          type: "directory",
          children: [
            { name: "app.ts", path: "src/app.ts", type: "file", size: 42 },
            { name: "empty", path: "src/empty", type: "directory", children: [] },
          ],
        },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));

    const agentTree = await screen.findByTestId("agent-space-tree");
    expect(await within(agentTree).findByRole("button", { name: "展开 src" })).toBeInTheDocument();
    expect(within(agentTree).queryByText("app.ts")).not.toBeInTheDocument();

    fireEvent.click(within(agentTree).getByRole("button", { name: "展开 src" }));

    expect(within(agentTree).getByText("app.ts")).toBeInTheDocument();
    fireEvent.click(within(agentTree).getByRole("button", { name: "展开 empty" }));
    expect(within(agentTree).queryByText("目录为空")).not.toBeInTheDocument();
  });

  it("opens Agent space files in the preview panel when clicked", async () => {
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [
        {
          name: "src",
          path: "src",
          type: "directory",
          children: [{ name: "app.ts", path: "src/app.ts", type: "file", size: 42 }],
        },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentTree = await screen.findByTestId("agent-space-tree");
    fireEvent.click(await within(agentTree).findByRole("button", { name: "展开 src" }));
    fireEvent.click(within(agentTree).getByRole("button", { name: "预览 app.ts" }));

    await waitFor(() => expect(mockGetAgentSpaceFile).toHaveBeenCalledWith("s1", "src/app.ts"));
    expect(
      await screen.findByTestId("preview-tab-__piwork_agent__:src/app.ts"),
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId("preview-body-__piwork_agent__:src/app.ts"),
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId("text-editor-__piwork_agent__:src/app.ts"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("user-space-preview-toolbar-filename")).toHaveTextContent("app.ts");
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  });

  it("previews empty Agent space files with unknown extensions as text", async () => {
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [{ name: "empty.tx", path: "empty.tx", type: "file", size: 0 }],
    });
    mockGetAgentSpaceFile.mockResolvedValueOnce({
      file: new File([""], "empty.tx"),
      metadata: {
        path: "empty.tx",
        name: "empty.tx",
        kind: "file",
        size: 0,
        mtime: 123,
        sha256: "empty-hash",
      },
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentTree = await screen.findByTestId("agent-space-tree");
    fireEvent.click(await within(agentTree).findByRole("button", { name: "预览 empty.tx" }));

    await waitFor(() => expect(mockGetAgentSpaceFile).toHaveBeenCalledWith("s1", "empty.tx"));
    expect(await screen.findByTestId("preview-tab-__piwork_agent__:empty.tx")).toBeInTheDocument();
    expect(await screen.findByTestId("text-editor-__piwork_agent__:empty.tx")).toBeInTheDocument();
    expect(screen.queryByText("无法预览此文件类型，可以用本地应用打开。")).not.toBeInTheDocument();
  });

  it("does not fetch known binary Agent space files for preview", async () => {
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [{ name: "archive.zip", path: "archive.zip", type: "file", size: 128 }],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentTree = await screen.findByTestId("agent-space-tree");
    fireEvent.click(await within(agentTree).findByRole("button", { name: "预览 archive.zip" }));

    expect(mockGetAgentSpaceFile).not.toHaveBeenCalled();
    expect(
      await screen.findByTestId("preview-tab-__piwork_agent__:archive.zip"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("unsupported-preview-details")).toBeInTheDocument();
  });

  it("supports cmd, ctrl, and shift selection in Agent space without opening files", async () => {
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [
        { name: "a.txt", path: "a.txt", type: "file", size: 1 },
        { name: "b.txt", path: "b.txt", type: "file", size: 2 },
        { name: "c.txt", path: "c.txt", type: "file", size: 3 },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentTree = await screen.findByTestId("agent-space-tree");
    const aButton = within(agentTree).getByRole("button", { name: "预览 a.txt" });
    const bButton = within(agentTree).getByRole("button", { name: "预览 b.txt" });
    const cButton = within(agentTree).getByRole("button", { name: "预览 c.txt" });

    fireEvent.click(aButton, { metaKey: true });
    fireEvent.click(cButton, { shiftKey: true });

    expect(screen.getByTestId("agent-space-entry-a.txt")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("agent-space-entry-a.txt").className).toContain(
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(aButton).toHaveClass("pr-8", "overflow-hidden");
    expect(screen.getByTestId("agent-space-entry-b.txt")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("agent-space-entry-c.txt")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("agent-space-entry-a.txt")).toHaveAttribute(
      "data-selection-segment",
      "top",
    );
    expect(screen.getByTestId("agent-space-entry-b.txt")).toHaveAttribute(
      "data-selection-segment",
      "middle",
    );
    expect(screen.getByTestId("agent-space-entry-c.txt")).toHaveAttribute(
      "data-selection-segment",
      "bottom",
    );
    expect(screen.getByTestId("agent-space-entry-a.txt").firstElementChild).toHaveClass(
      "bg-[var(--piwork-list-selected)]",
    );
    expect(screen.getByTestId("agent-space-entry-a.txt").firstElementChild).not.toHaveClass(
      "bg-primary/10",
      "transition-colors",
    );
    expect(
      screen.getByTestId("agent-space-entry-a.txt").firstElementChild?.getAttribute("style"),
    ).toContain("border-bottom-left-radius: 0");
    expect(
      screen.getByTestId("agent-space-entry-b.txt").firstElementChild?.getAttribute("style"),
    ).toContain("border-top-left-radius: 0");
    expect(
      screen.getByTestId("agent-space-entry-c.txt").firstElementChild?.getAttribute("style"),
    ).toContain("border-top-left-radius: 0");

    fireEvent.click(bButton, { ctrlKey: true });
    expect(screen.getByTestId("agent-space-entry-a.txt")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("agent-space-entry-b.txt")).not.toHaveAttribute("data-selected");
    expect(screen.getByTestId("agent-space-entry-c.txt")).toHaveAttribute("data-selected", "true");
    expect(mockGetAgentSpaceFile).not.toHaveBeenCalled();
  });

  it("moves the complete Agent-space selection when dragging a selected entry", async () => {
    const tree = [
      { name: "archive", path: "archive", type: "directory" as const, children: [] },
      { name: "a.txt", path: "a.txt", type: "file" as const, size: 1 },
      { name: "b.txt", path: "b.txt", type: "file" as const, size: 2 },
    ];
    mockGetAgentSpaceTree
      .mockResolvedValueOnce({ path: "", rootName: "workspace", tree })
      .mockResolvedValue({
        path: "",
        rootName: "workspace",
        tree: [
          {
            name: "archive",
            path: "archive",
            type: "directory" as const,
            children: [
              { name: "a.txt", path: "archive/a.txt", type: "file" as const, size: 1 },
              { name: "b.txt", path: "archive/b.txt", type: "file" as const, size: 2 },
            ],
          },
        ],
      });
    mockMoveAgentSpaceEntries.mockResolvedValue({
      ok: true,
      moves: [
        { path: "a.txt", newPath: "archive/a.txt" },
        { path: "b.txt", newPath: "archive/b.txt" },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentTree = await screen.findByTestId("agent-space-tree");
    fireEvent.click(within(agentTree).getByRole("button", { name: "预览 a.txt" }), {
      metaKey: true,
    });
    fireEvent.click(within(agentTree).getByRole("button", { name: "预览 b.txt" }), {
      metaKey: true,
    });

    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(screen.getByTestId("agent-space-entry-b.txt"), { dataTransfer });
    const targetRow = screen.getByTestId("agent-space-entry-archive");
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });

    await waitFor(() =>
      expect(mockMoveAgentSpaceEntries).toHaveBeenCalledWith(
        "s1",
        expect.arrayContaining(["a.txt", "b.txt"]),
        "archive",
      ),
    );
    const paths = mockMoveAgentSpaceEntries.mock.calls[0]?.[1] as string[];
    expect(paths).toHaveLength(2);
    expect(await screen.findByRole("alert")).toHaveTextContent("已将 2 个项目移动到“archive”。");
    await waitFor(() =>
      expect(screen.getByTestId("agent-space-entry-archive/b.txt")).toHaveAttribute(
        "data-focused",
        "true",
      ),
    );
  });

  it("drags only the grabbed Agent-space row when it is outside the current selection", async () => {
    const tree = [
      { name: "archive", path: "archive", type: "directory" as const, children: [] },
      { name: "a.txt", path: "a.txt", type: "file" as const, size: 1 },
      { name: "b.txt", path: "b.txt", type: "file" as const, size: 2 },
      { name: "c.txt", path: "c.txt", type: "file" as const, size: 3 },
    ];
    mockGetAgentSpaceTree.mockResolvedValue({ path: "", rootName: "workspace", tree });
    mockMoveAgentSpaceEntries.mockResolvedValue({
      ok: true,
      moves: [{ path: "c.txt", newPath: "archive/c.txt" }],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentTree = await screen.findByTestId("agent-space-tree");
    fireEvent.click(within(agentTree).getByRole("button", { name: "预览 a.txt" }), {
      metaKey: true,
    });
    fireEvent.click(within(agentTree).getByRole("button", { name: "预览 b.txt" }), {
      metaKey: true,
    });

    const dataTransfer = createMockDataTransfer();
    const grabbedRow = screen.getByTestId("agent-space-entry-c.txt");
    fireEvent.dragStart(grabbedRow, { dataTransfer });

    expect(JSON.parse(dataTransfer.getData(WORKSPACE_INTERNAL_DRAG_TYPE))).toMatchObject({
      space: "agent",
      paths: ["c.txt"],
    });
    expect(grabbedRow).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("agent-space-entry-a.txt")).not.toHaveAttribute("data-selected");
    expect(screen.getByTestId("agent-space-entry-b.txt")).not.toHaveAttribute("data-selected");

    const targetRow = screen.getByTestId("agent-space-entry-archive");
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });

    await waitFor(() =>
      expect(mockMoveAgentSpaceEntries).toHaveBeenCalledWith("s1", ["c.txt"], "archive"),
    );
  });

  it("rejects a final drop when an active drag crosses from Agent space into User space", async () => {
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [{ name: "a.txt", path: "a.txt", type: "file" as const, size: 1 }],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentRow = await screen.findByTestId("agent-space-entry-a.txt");
    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(agentRow, { dataTransfer });

    fireEvent.click(screen.getByRole("tab", { name: "用户空间" }));
    const userTarget = await screen.findByTestId("user-space-entry-row-uw-mounted:docs");
    fireEvent.dragOver(userTarget, { dataTransfer });
    expect(userTarget).not.toHaveAttribute("data-drop-target");
    fireEvent.drop(userTarget, { dataTransfer });

    expect(mockMoveAgentSpaceEntries).not.toHaveBeenCalled();
    expect(mockExecuteUserSpaceOperation).not.toHaveBeenCalledWith(
      "move_entries",
      expect.anything(),
    );
  });

  it("preserves an unrelated Agent cut clipboard when another file is dragged", async () => {
    const tree = [
      { name: "archive", path: "archive", type: "directory" as const, children: [] },
      { name: "a.txt", path: "a.txt", type: "file" as const, size: 1 },
      { name: "b.txt", path: "b.txt", type: "file" as const, size: 2 },
    ];
    mockGetAgentSpaceTree.mockResolvedValue({ path: "", rootName: "workspace", tree });
    mockMoveAgentSpaceEntries.mockImplementation(
      (_sessionId: string, paths: string[], targetDirPath: string) =>
        Promise.resolve({
          ok: true,
          moves: paths.map((path) => ({
            path,
            newPath: `${targetDirPath}/${path.split("/").pop()}`,
          })),
        }),
    );
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    await screen.findByTestId("agent-space-tree");
    fireEvent.contextMenu(screen.getByTestId("agent-space-entry-a.txt"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "剪切" }));

    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(screen.getByTestId("agent-space-entry-b.txt"), { dataTransfer });
    const archiveRow = screen.getByTestId("agent-space-entry-archive");
    fireEvent.dragOver(archiveRow, { dataTransfer });
    fireEvent.drop(archiveRow, { dataTransfer });

    await waitFor(() =>
      expect(mockMoveAgentSpaceEntries).toHaveBeenCalledWith("s1", ["b.txt"], "archive"),
    );
    fireEvent.contextMenu(screen.getByTestId("agent-space-entry-archive"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "粘贴到此处" }));
    await waitFor(() =>
      expect(mockMoveAgentSpaceEntries).toHaveBeenCalledWith("s1", ["a.txt"], "archive"),
    );
  });

  it("pastes a nested Agent cut selection into the focused root with the keyboard", async () => {
    const tree = [
      {
        name: "folder",
        path: "folder",
        type: "directory" as const,
        children: [{ name: "a.txt", path: "folder/a.txt", type: "file" as const, size: 1 }],
      },
    ];
    mockGetAgentSpaceTree.mockResolvedValue({ path: "", rootName: "workspace", tree });
    mockMoveAgentSpaceEntries.mockResolvedValue({
      ok: true,
      moves: [{ path: "folder/a.txt", newPath: "a.txt" }],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    fireEvent.click(await screen.findByRole("button", { name: "展开 folder" }));
    const nestedFile = screen.getByRole("button", { name: "预览 a.txt" });
    fireEvent.click(nestedFile);
    fireEvent.contextMenu(nestedFile);
    fireEvent.click(await screen.findByRole("menuitem", { name: "剪切" }));

    const rootButton = screen.getByRole("button", { name: "收起 workspace" });
    rootButton.focus();
    fireEvent.keyDown(rootButton, { key: "v", ctrlKey: true });

    await waitFor(() =>
      expect(mockMoveAgentSpaceEntries).toHaveBeenCalledWith("s1", ["folder/a.txt"], ""),
    );
  });

  it("reloads the Agent tree and localizes coded move failures in both languages", async () => {
    const tree = [
      { name: "archive", path: "archive", type: "directory" as const, children: [] },
      { name: "a.txt", path: "a.txt", type: "file" as const, size: 1 },
      { name: "b.txt", path: "b.txt", type: "file" as const, size: 2 },
    ];
    mockGetAgentSpaceTree.mockResolvedValue({ path: "", rootName: "workspace", tree });
    mockMoveAgentSpaceEntries
      .mockRejectedValueOnce(
        Object.assign(new Error("target already exists"), {
          code: "agent_space_move_target_exists",
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("rollback failed"), {
          code: "agent_space_move_rollback_failed",
        }),
      );
    const view = render(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="zh-CN" />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    await screen.findByTestId("agent-space-tree");
    const archiveRow = screen.getByTestId("agent-space-entry-archive");
    const firstTransfer = createMockDataTransfer();
    fireEvent.dragStart(screen.getByTestId("agent-space-entry-a.txt"), {
      dataTransfer: firstTransfer,
    });
    fireEvent.dragOver(archiveRow, { dataTransfer: firstTransfer });
    fireEvent.drop(archiveRow, { dataTransfer: firstTransfer });

    expect(await screen.findByRole("alert")).toHaveTextContent("目标位置已有同名项目。");
    await waitFor(() => expect(mockGetAgentSpaceTree.mock.calls.length).toBeGreaterThanOrEqual(2));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    setUiCopyLanguage("en-US");
    view.rerender(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />,
    );
    const secondTransfer = createMockDataTransfer();
    fireEvent.dragStart(screen.getByTestId("agent-space-entry-b.txt"), {
      dataTransfer: secondTransfer,
    });
    fireEvent.dragOver(screen.getByTestId("agent-space-entry-archive"), {
      dataTransfer: secondTransfer,
    });
    fireEvent.drop(screen.getByTestId("agent-space-entry-archive"), {
      dataTransfer: secondTransfer,
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The move could not be fully rolled back. The file tree was reloaded; check the current file locations.",
    );
    await waitFor(() => expect(mockGetAgentSpaceTree.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it("disables concurrent Agent structural actions while a move is pending", async () => {
    const pendingMove = deferred<{
      ok: true;
      moves: Array<{ path: string; newPath: string }>;
    }>();
    const tree = [
      { name: "archive", path: "archive", type: "directory" as const, children: [] },
      { name: "a.txt", path: "a.txt", type: "file" as const, size: 1 },
    ];
    mockGetAgentSpaceTree.mockResolvedValue({ path: "", rootName: "workspace", tree });
    mockMoveAgentSpaceEntries.mockReturnValue(pendingMove.promise);
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    await screen.findByTestId("agent-space-tree");
    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(screen.getByTestId("agent-space-entry-a.txt"), { dataTransfer });
    const archiveRow = screen.getByTestId("agent-space-entry-archive");
    fireEvent.dragOver(archiveRow, { dataTransfer });
    fireEvent.drop(archiveRow, { dataTransfer });
    await waitFor(() => expect(mockMoveAgentSpaceEntries).toHaveBeenCalled());

    fireEvent.contextMenu(screen.getByTestId("agent-space-entry-a.txt"));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "传输到用户空间" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "删除" })).not.toBeInTheDocument();

    await act(async () => {
      pendingMove.resolve({ ok: true, moves: [{ path: "a.txt", newPath: "archive/a.txt" }] });
      await pendingMove.promise;
    });
  });

  it("clears user-space and Agent-space selections from blank area clicks", async () => {
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [{ name: "artifact.pdf", path: "artifact.pdf", type: "file", size: 128 }],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    fireEvent.click(readmeButton);
    expect(screen.getByTestId("user-space-entry-row-uw-mounted:README.md")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(
      screen
        .getByTestId("user-space-entry-row-uw-mounted:README.md")
        .firstElementChild?.getAttribute("style"),
    ).toContain("var(--piwork-control-radius)");
    expect(
      screen
        .getByTestId("user-space-entry-row-uw-mounted:README.md")
        .firstElementChild?.getAttribute("style"),
    ).not.toContain("min(");

    fireEvent.click(screen.getByTestId("user-space-tree-blank-area"));
    expect(screen.getByTestId("user-space-entry-row-uw-mounted:README.md")).not.toHaveAttribute(
      "data-selected",
    );
    expect(
      screen
        .getByTestId("user-space-entry-row-uw-mounted:README.md")
        .firstElementChild?.getAttribute("style"),
    ).toContain("var(--piwork-control-radius)");
    expect(
      screen
        .getByTestId("user-space-entry-row-uw-mounted:README.md")
        .firstElementChild?.getAttribute("style"),
    ).not.toContain("min(");

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentTree = await screen.findByTestId("agent-space-tree");
    fireEvent.click(within(agentTree).getByRole("button", { name: "预览 artifact.pdf" }));
    expect(screen.getByTestId("agent-space-entry-artifact.pdf")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(
      screen.getByTestId("agent-space-entry-artifact.pdf").firstElementChild?.getAttribute("style"),
    ).toContain("var(--piwork-control-radius)");
    expect(
      screen.getByTestId("agent-space-entry-artifact.pdf").firstElementChild?.getAttribute("style"),
    ).not.toContain("min(");

    fireEvent.click(screen.getByTestId("agent-space-tree-blank-area"));
    expect(screen.getByTestId("agent-space-entry-artifact.pdf")).not.toHaveAttribute(
      "data-selected",
    );
    expect(
      screen.getByTestId("agent-space-entry-artifact.pdf").firstElementChild?.getAttribute("style"),
    ).toContain("var(--piwork-control-radius)");
    expect(
      screen.getByTestId("agent-space-entry-artifact.pdf").firstElementChild?.getAttribute("style"),
    ).not.toContain("min(");
  });

  it("keeps the preview split fixed instead of exposing an intermediate resize state", async () => {
    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        previewOpen
        sessionPanelCollapsed={false}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));

    expect(screen.getByLabelText("工作区文件边栏")).toHaveStyle({
      gridTemplateColumns: "28.571429% minmax(0, 1fr)",
    });
    expect(screen.queryByTestId("user-space-inner-resize-handle")).not.toBeInTheDocument();
  });
  it("positions virtual file tree rows after layout measurements change", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await screen.findByText("README.md");

    const rows = screen.getAllByTestId("user-space-virtual-tree-row");
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.style.transform).toMatch(/^translate3d\(0, \d+(?:\.\d+)?px, 0\)$/);
    }
    expect(rows[1].style.transform).not.toBe(rows[0].style.transform);
    expect(rows[0].style.transform).toBe("translate3d(0, 0px, 0)");
    expect(rows[1].style.transform).toBe("translate3d(0, 34px, 0)");
    expect(rows[0].parentElement?.style.height).toMatch(/px$/);
  });

  it("switches the active tree when the selected agent provides a different workspace", async () => {
    // The file tree component stays mounted while agents switch. It must not
    // keep showing the previous agent's File System Access handle.
    const opsWorkspace = {
      mountId: "uw-ops",
      name: "Ops Files",
      rootName: "Ops Files",
      status: "mounted" as const,
      access: "readwrite" as const,
      includeHidden: true as const,
    };
    mockSnapshot = {
      supported: true,
      mounts: [mountedWorkspace, opsWorkspace],
      indexing: {},
      recentOperations: [],
    };
    let resolveOpsRoot: (value: {
      entries: Array<{ name: string; path: string; kind: "file"; size: number }>;
    }) => void = () => {};
    const opsRoot = new Promise<{
      entries: Array<{ name: string; path: string; kind: "file"; size: number }>;
    }>((resolve) => {
      resolveOpsRoot = resolve;
    });
    mockExecuteUserSpaceOperation.mockImplementation((_operation, input: { mountId?: string }) => {
      if (input.mountId === "uw-ops") {
        return opsRoot;
      }
      return Promise.resolve({
        entries: [{ name: "it-guide.md", path: "it-guide.md", kind: "file" as const, size: 8 }],
      });
    });

    const { rerender } = render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    expect(await screen.findByText("it-guide.md")).toBeInTheDocument();

    rerender(<UserSpaceExplorer sessionId="s1" mounts={[opsWorkspace]} />);

    expect(screen.getByRole("button", { name: "管理用户空间目录" })).toBeInTheDocument();
    expect(screen.queryByText("读取目录...")).not.toBeInTheDocument();
    expect(screen.queryByText("it-guide.md")).not.toBeInTheDocument();

    resolveOpsRoot({
      entries: [
        { name: "ops-runbook.md", path: "ops-runbook.md", kind: "file" as const, size: 11 },
      ],
    });

    expect(await screen.findByText("ops-runbook.md")).toBeInTheDocument();
    expect(screen.queryByText("it-guide.md")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "管理用户空间目录" })).toBeInTheDocument();
    expect(mockExecuteUserSpaceOperation).toHaveBeenLastCalledWith(
      "list_dir",
      expect.objectContaining({ mountId: "uw-ops", path: "" }),
    );
  });

  it("virtualizes large mounted root directories instead of rendering every row", async () => {
    const manyEntries = Array.from({ length: 500 }, (_, index) => ({
      name: `file-${index}.txt`,
      path: `file-${index}.txt`,
      kind: "file" as const,
      size: index + 1,
    }));
    mockExecuteUserSpaceOperation.mockResolvedValue({ entries: manyEntries });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    expect(await screen.findByText("file-0.txt")).toBeInTheDocument();
    expect(screen.queryByText("file-250.txt")).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("user-space-tree-pane")).getAllByRole("treeitem").length,
    ).toBeLessThan(100);
  });

  it("switches between mounted roots instead of rendering them all at once", async () => {
    const opsWorkspace = {
      mountId: "uw-ops",
      name: "Ops Files",
      rootName: "Ops Files",
      status: "mounted" as const,
      access: "readwrite" as const,
      includeHidden: true as const,
    };
    mockSnapshot = {
      supported: true,
      mounts: [mountedWorkspace, opsWorkspace],
      indexing: {},
      recentOperations: [],
    };
    mockExecuteUserSpaceOperation.mockImplementation((_operation, input: { mountId?: string }) => {
      if (input.mountId === "uw-ops") {
        return Promise.resolve({
          entries: [{ name: "ops-only.md", path: "ops-only.md", kind: "file" as const, size: 9 }],
        });
      }
      return Promise.resolve({
        entries: [
          { name: "client-only.md", path: "client-only.md", kind: "file" as const, size: 9 },
        ],
      });
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace, opsWorkspace]} />);

    expect(await screen.findByText("client-only.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "预览 client-only.md" }));
    expect(
      await screen.findByRole("button", { name: "切换预览 client-only.md" }),
    ).toBeInTheDocument();

    expect(screen.getByTestId("user-space-current-mount")).toHaveTextContent("Client Files");
    expect(screen.getByTestId("user-space-mount-switcher-button")).toHaveClass(
      "h-6",
      "w-6",
      "justify-center",
      "hover:bg-accent",
    );
    expect(
      screen.getByTestId("user-space-mount-switcher-button").querySelector("span"),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("user-space-mount-switcher-anchor")).queryByRole("button", {
        name: "取消挂载Client Files",
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-space-primary-action-button")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "展开Ops Files用户空间" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "收起Client Files用户空间" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("ops-only.md")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("user-space-mount-switcher-button"));
    const mountDialog = screen.getByRole("dialog", { name: "管理用户空间目录" });
    expect(screen.getByTestId("user-space-mount-switcher-button")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("user-space-mount-switcher-button")).toHaveClass(
      "bg-accent",
      "hover:bg-accent",
    );
    expect(screen.getByTestId("user-space-mount-switcher-anchor")).toHaveClass(
      "h-full",
      "items-center",
    );
    expect(screen.getByTestId("user-space-mount-switcher-button")).toHaveClass(
      "h-6",
      "w-6",
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(
      screen.getByTestId("user-space-mount-switcher-button").querySelector(".lucide-settings-2"),
    ).toHaveClass("h-4", "w-4");
    expect(screen.getByTestId("user-space-current-mount")).toHaveClass("pl-4");
    expect(screen.getByTestId("user-space-current-mount")).toHaveTextContent("Client Files");
    expect(
      screen.getByTestId("user-space-current-mount").querySelector(".lucide-folder-open"),
    ).not.toBeInTheDocument();
    expect(mountDialog).toHaveClass(
      "piwork-superellipse-panel",
      "rounded-[var(--piwork-panel-radius)]",
      "border",
      "bg-card",
      "!p-0",
    );
    expect(
      within(mountDialog).queryByText("切换、挂载或移除此会话可使用的目录。"),
    ).not.toBeInTheDocument();
    expect(within(mountDialog).getByRole("button", { name: "关闭" })).toHaveClass(
      "absolute",
      "right-3",
      "top-3",
      "bg-transparent",
    );
    expect(within(mountDialog).getByRole("list", { name: "用户空间目录" })).toBeInTheDocument();
    expect(screen.getByTestId("user-space-mount-option-uw-ops")).toHaveClass(
      "border-transparent",
      "bg-transparent",
      "hover:bg-accent",
      "transition-colors",
      "text-foreground",
    );
    expect(screen.getByTestId("user-space-mount-option-uw-mounted")).toHaveClass(
      "border-transparent",
      "bg-accent",
      "transition-colors",
      "text-foreground",
    );
    expect(screen.getByTestId("user-space-mount-option-uw-mounted")).not.toHaveClass(
      "hover:bg-accent",
      "hover:bg-accent/80",
    );
    expect(
      within(mountDialog).queryByRole("button", { name: "打开 wterm" }),
    ).not.toBeInTheDocument();
    const addMountButton = within(mountDialog).getByRole("button", { name: "添加目录" });
    expect(addMountButton.querySelector(".lucide-plus")).not.toBeInTheDocument();
    expect(addMountButton.closest('[data-slot="modal-footer"]')).toBeInTheDocument();
    expect(within(mountDialog).getByRole("button", { name: "保存配置" })).toBeInTheDocument();
    expect(
      within(screen.getByTestId("user-space-mount-option-uw-mounted")).getByRole("button", {
        name: "Client Files，当前目录",
      }),
    ).toBeDisabled();
    expect(screen.getByTestId("user-space-mount-option-uw-mounted")).not.toHaveTextContent(
      "当前目录",
    );
    expect(
      screen.getByTestId("user-space-mount-option-uw-mounted").querySelector(".lucide-check"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("user-space-mount-option-uw-mounted").querySelector(".lucide-folder"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("user-space-mount-option-uw-ops").querySelector(".lucide-folder"),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getByTestId("user-space-mount-option-uw-ops")
        .querySelector(".lucide-arrow-right-left"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("user-space-mount-option-uw-ops").querySelector(".lucide-check"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("user-space-mount-option-uw-mounted")).not.toHaveTextContent(
      "已连接",
    );
    expect(screen.getByTestId("user-space-mount-option-uw-mounted")).not.toHaveTextContent("读写");
    fireEvent.click(
      within(screen.getByTestId("user-space-mount-option-uw-ops")).getByRole("button", {
        name: "切换到 Ops Files",
      }),
    );

    expect(
      screen.getByTestId("user-space-mount-option-uw-ops").querySelector(".lucide-check"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("user-space-mount-option-uw-mounted").querySelector(".lucide-check"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("user-space-current-mount")).toHaveTextContent("Client Files");
    expect(mockConfigureUserSpace).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "切换预览 client-only.md", hidden: true }),
    ).toBeInTheDocument();
    fireEvent.click(within(mountDialog).getByRole("button", { name: "保存配置" }));

    expect(await screen.findByText("ops-only.md")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "切换预览 client-only.md" }),
    ).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem("piwork:user-space-active-mount:s1")).toBe("uw-ops");
    expect(screen.queryByText("client-only.md")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "收起Client Files用户空间" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("user-space-current-mount")).toHaveTextContent("Ops Files");
    expect(screen.queryByRole("button", { name: "收起Ops Files用户空间" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockConfigureUserSpace).toHaveBeenCalledWith(
        "s1",
        [
          expect.objectContaining({ mountId: "uw-mounted", rootName: "Client Files" }),
          expect.objectContaining({ mountId: "uw-ops", rootName: "Ops Files" }),
        ],
        "uw-ops",
      );
    });

    await openWtermFromBlankAreaMenu();
    const terminal = await screen.findByTestId("user-space-wterm-terminal");
    terminal.textContent = "ls\n";
    fireEvent.input(terminal);
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "shell_exec",
        expect.objectContaining({ mountId: "uw-ops", cwd: "/", script: "ls" }),
      ),
    );
  });

  it("keeps the active root unchanged until the mounted-root configuration is saved", async () => {
    const opsWorkspace = {
      mountId: "uw-ops",
      name: "Ops Files",
      rootName: "Ops Files",
      status: "mounted" as const,
      access: "readwrite" as const,
      includeHidden: true as const,
    };
    mockSnapshot = {
      supported: true,
      mounts: [mountedWorkspace, opsWorkspace],
      indexing: {},
      recentOperations: [],
    };
    mockExecuteUserSpaceOperation.mockImplementation((_operation, input: { mountId?: string }) => {
      if (input.mountId === "uw-ops") {
        return Promise.resolve({
          entries: [{ name: "ops-only.md", path: "ops-only.md", kind: "file" as const, size: 9 }],
        });
      }
      return Promise.resolve({
        entries: [
          { name: "client-only.md", path: "client-only.md", kind: "file" as const, size: 9 },
        ],
      });
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace, opsWorkspace]} />);

    expect(await screen.findByText("client-only.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("user-space-mount-switcher-button"));
    fireEvent.click(
      within(screen.getByTestId("user-space-mount-option-uw-ops")).getByRole("button", {
        name: "切换到 Ops Files",
      }),
    );

    expect(screen.getByTestId("user-space-current-mount")).toHaveTextContent("Client Files");
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    expect(await screen.findByText("ops-only.md")).toBeInTheDocument();
    expect(screen.getByTestId("user-space-current-mount")).toHaveTextContent("Ops Files");
    await waitFor(() => {
      expect(mockConfigureUserSpace).toHaveBeenCalledWith(
        "s1",
        [
          expect.objectContaining({ mountId: "uw-mounted" }),
          expect.objectContaining({ mountId: "uw-ops" }),
        ],
        "uw-ops",
      );
    });
  });

  it("restores the selected mounted root after a browser refresh", async () => {
    const opsWorkspace = {
      mountId: "uw-ops",
      name: "Ops Files",
      rootName: "Ops Files",
      status: "mounted" as const,
      access: "readwrite" as const,
      includeHidden: true as const,
    };
    window.sessionStorage.setItem("piwork:user-space-active-mount:s1", "uw-ops");
    mockSnapshot = {
      supported: true,
      mounts: [mountedWorkspace, opsWorkspace],
      indexing: {},
      recentOperations: [],
    };
    mockExecuteUserSpaceOperation.mockImplementation((_operation, input: { mountId?: string }) => {
      if (input.mountId === "uw-ops") {
        return Promise.resolve({
          entries: [{ name: "ops-only.md", path: "ops-only.md", kind: "file" as const, size: 9 }],
        });
      }
      return Promise.resolve({
        entries: [
          { name: "client-only.md", path: "client-only.md", kind: "file" as const, size: 9 },
        ],
      });
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace, opsWorkspace]} />);

    expect(screen.getByTestId("user-space-current-mount")).toHaveTextContent("Ops Files");
    expect(await screen.findByText("ops-only.md")).toBeInTheDocument();
    expect(screen.queryByText("client-only.md")).not.toBeInTheDocument();
    expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
      "list_dir",
      expect.objectContaining({ mountId: "uw-ops", path: "" }),
    );
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await screen.findByText("README.md");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("renders the active mounted root only in the switcher", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(screen.getByTestId("user-space-current-mount")).toHaveTextContent("Client Files");
    expect(
      screen.queryByRole("button", { name: "收起Client Files用户空间" }),
    ).not.toBeInTheDocument();
    const docsButton = screen.getByRole("button", { name: "展开 docs" });
    expect(docsButton.querySelectorAll("svg")).toHaveLength(1);
    expect(screen.getByTestId("user-space-entry-toggle-slot-uw-mounted:docs")).toHaveStyle({
      width: "24px",
    });
    expect(within(docsButton).getByText("docs")).toHaveStyle({ marginLeft: "-4px" });
    const rootFileIconSlot = screen.getByTestId("user-space-entry-icon-slot-uw-mounted:README.md");
    expect(rootFileIconSlot.querySelector("svg")).toBeInTheDocument();
    expect(rootFileIconSlot).toHaveClass("h-6", "w-6");
    expect(rootFileIconSlot).toHaveStyle({ width: "24px" });
    const rootFileContent = rootFileIconSlot.closest("button")?.parentElement;
    expect(rootFileContent).toHaveStyle({ paddingLeft: "12px" });
    expect(screen.getByText("README.md")).toHaveStyle({ marginLeft: "-4px" });

    fireEvent.click(docsButton);
    const nestedFileButton = await screen.findByRole("button", { name: "预览 notes.txt" });
    const nestedFileIconSlot = screen.getByTestId(
      "user-space-entry-icon-slot-uw-mounted:docs/notes.txt",
    );
    expect(nestedFileIconSlot).toHaveStyle({ width: "24px" });
    const nestedFileContent = nestedFileIconSlot.closest("button")?.parentElement;
    expect(nestedFileContent).toHaveStyle({ paddingLeft: "30px" });
    expect(nestedFileButton.getAttribute("style") || "").not.toContain("column-gap");
    expect(within(nestedFileButton).getByText("notes.txt")).toHaveStyle({ marginLeft: "-4px" });
  });

  it("aligns file and directory leading/text columns at every tree depth", async () => {
    mockExecuteUserSpaceOperation.mockImplementation(
      (_operation, input: { path?: string; cwd?: string }) => {
        if (input.path === "docs") {
          return Promise.resolve({
            entries: [
              { name: "reports", path: "docs/reports", kind: "directory" as const },
              { name: "sibling.txt", path: "docs/sibling.txt", kind: "file" as const, size: 7 },
            ],
          });
        }
        if (input.path === "docs/reports") {
          return Promise.resolve({
            entries: [
              {
                name: "report.txt",
                path: "docs/reports/report.txt",
                kind: "file" as const,
                size: 12,
              },
            ],
          });
        }
        if (input.cwd) {
          return Promise.resolve({
            stdout: "README.md\n",
            stderr: "",
            exitCode: 0,
            cwd: input.cwd,
          });
        }
        return Promise.resolve({ entries: rootEntries });
      },
    );
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "展开 docs" }));
    const reportsButton = await screen.findByRole("button", { name: "展开 reports" });
    const siblingButton = await screen.findByRole("button", { name: "预览 sibling.txt" });
    const reportsContent = screen
      .getByTestId("user-space-entry-toggle-slot-uw-mounted:docs/reports")
      .closest("button")?.parentElement;
    const siblingIconSlot = screen.getByTestId(
      "user-space-entry-icon-slot-uw-mounted:docs/sibling.txt",
    );
    const siblingContent = siblingIconSlot.closest("button")?.parentElement;

    expect(reportsContent).toHaveStyle({ paddingLeft: "30px" });
    expect(siblingContent).toHaveStyle({ paddingLeft: "30px" });
    expect(screen.getByTestId("user-space-entry-toggle-slot-uw-mounted:docs/reports")).toHaveStyle({
      width: "24px",
    });
    expect(siblingIconSlot).toHaveStyle({ width: "24px" });
    expect(within(reportsButton).getByText("reports")).toHaveStyle({ marginLeft: "-4px" });
    expect(within(siblingButton).getByText("sibling.txt")).toHaveStyle({ marginLeft: "-4px" });

    fireEvent.click(reportsButton);
    const deepFileIconSlot = await screen.findByTestId(
      "user-space-entry-icon-slot-uw-mounted:docs/reports/report.txt",
    );
    const deepFileContent = deepFileIconSlot.closest("button")?.parentElement;
    const deepFileButton = await screen.findByRole("button", { name: "预览 report.txt" });

    expect(deepFileContent).toHaveStyle({ paddingLeft: "48px" });
    expect(deepFileIconSlot).toHaveStyle({ width: "24px" });
    expect(deepFileButton.getAttribute("style") || "").not.toContain("column-gap");
    expect(screen.getByText("report.txt")).toHaveStyle({ marginLeft: "-4px" });
  });

  it("supports cmd and ctrl click selection without opening files", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    const indexButton = screen.getByRole("button", { name: "预览 index.html" });
    const readmeRow = screen.getByTestId("user-space-entry-row-uw-mounted:README.md");
    const indexRow = screen.getByTestId("user-space-entry-row-uw-mounted:index.html");
    expect(readmeRow.className).toContain("rounded-[var(--piwork-control-radius)]");
    expect(readmeButton).toHaveClass("pr-8", "overflow-hidden");

    fireEvent.click(readmeButton, { metaKey: true });
    expect(readmeRow).toHaveAttribute("data-selected", "true");
    expect(screen.queryByTestId("preview-tab-uw-mounted:README.md")).not.toBeInTheDocument();

    fireEvent.click(indexButton, { ctrlKey: true });
    expect(readmeRow).toHaveAttribute("data-selected", "true");
    expect(indexRow).toHaveAttribute("data-selected", "true");

    fireEvent.click(readmeButton, { ctrlKey: true });
    expect(readmeRow).not.toHaveAttribute("data-selected");
    expect(indexRow).toHaveAttribute("data-selected", "true");
    expect(mockGetUserSpaceFile).not.toHaveBeenCalled();
  });

  it("supports shift range selection across visible user-space rows", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "预览 app.ts" }), { shiftKey: true });

    expect(screen.getByTestId("user-space-entry-row-uw-mounted:docs")).not.toHaveAttribute(
      "data-selected",
    );
    expect(screen.getByTestId("user-space-entry-row-uw-mounted:README.md")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(screen.getByTestId("user-space-entry-row-uw-mounted:index.html")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(screen.getByTestId("user-space-entry-row-uw-mounted:Dockerfile.server")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(screen.getByTestId("user-space-entry-row-uw-mounted:app.ts")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(screen.getByTestId("user-space-entry-row-uw-mounted:README.md")).toHaveAttribute(
      "data-selection-segment",
      "top",
    );
    expect(screen.getByTestId("user-space-entry-row-uw-mounted:index.html")).toHaveAttribute(
      "data-selection-segment",
      "middle",
    );
    expect(screen.getByTestId("user-space-entry-row-uw-mounted:app.ts")).toHaveAttribute(
      "data-selection-segment",
      "bottom",
    );
    expect(
      screen.getByTestId("user-space-entry-row-uw-mounted:README.md").firstElementChild,
    ).toHaveClass("bg-[var(--piwork-list-selected)]");
    expect(
      screen.getByTestId("user-space-entry-row-uw-mounted:README.md").firstElementChild,
    ).not.toHaveClass("bg-primary/10", "transition-colors");
    expect(
      screen
        .getByTestId("user-space-entry-row-uw-mounted:README.md")
        .firstElementChild?.getAttribute("style"),
    ).toContain("min(var(--piwork-control-radius), 14px)");
    expect(
      screen.getByTestId("user-space-entry-row-uw-mounted:README.md").firstElementChild,
    ).toHaveStyle({ bottom: "-2px" });
    expect(
      screen.getByTestId("user-space-entry-row-uw-mounted:index.html").firstElementChild,
    ).toHaveStyle({ bottom: "-2px" });
    expect(
      screen
        .getByTestId("user-space-entry-row-uw-mounted:app.ts")
        .firstElementChild?.getAttribute("style"),
    ).not.toContain("bottom:");
    expect(
      screen
        .getByTestId("user-space-entry-row-uw-mounted:README.md")
        .firstElementChild?.getAttribute("style"),
    ).toContain("border-bottom-left-radius: 0");
    expect(
      screen
        .getByTestId("user-space-entry-row-uw-mounted:index.html")
        .firstElementChild?.getAttribute("style"),
    ).toContain("border-top-left-radius: 0");
    expect(
      screen
        .getByTestId("user-space-entry-row-uw-mounted:app.ts")
        .firstElementChild?.getAttribute("style"),
    ).toContain("border-top-left-radius: 0");
    expect(mockGetUserSpaceFile).not.toHaveBeenCalled();
  });

  it("opens the mount switcher modal even when there is only one mounted directory", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await screen.findByText("README.md");
    const switcherButton = screen.getByTestId("user-space-mount-switcher-button");
    fireEvent.click(switcherButton);

    expect(switcherButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("user-space-mount-switcher-anchor")).toHaveClass("h-full");
    const dialog = screen.getByRole("dialog", { name: "管理用户空间目录" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole("list", { name: "用户空间目录" })).toBeInTheDocument();
    expect(
      within(screen.getByTestId("user-space-mount-option-uw-mounted")).getByRole("button", {
        name: "Client Files，当前目录",
      }),
    ).toBeDisabled();
    expect(screen.getByTestId("user-space-mount-option-uw-mounted")).toHaveTextContent(
      "Client Files",
    );
    expect(screen.queryByRole("listbox", { name: "用户空间目录" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "管理用户空间目录" })).not.toBeInTheDocument();
  });

  it("enters alias editing only from rename and commits it only from save", async () => {
    const onMountsConfigured = vi.fn();
    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        onMountsConfigured={onMountsConfigured}
      />,
    );

    const dialog = await openUserSpaceManager();
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "重命名Client Files" }));
    const aliasInput = within(dialog).getByRole("textbox", { name: "Client Files的别名" });
    fireEvent.change(aliasInput, { target: { value: "客户资料" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "完成重命名客户资料" }));

    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(dialog).getByText("客户资料")).toBeInTheDocument();
    expect(mockRenameUserSpaceMount).not.toHaveBeenCalled();
    expect(onMountsConfigured).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "保存配置" }));
    await waitFor(() =>
      expect(mockRenameUserSpaceMount).toHaveBeenCalledWith("uw-mounted", "客户资料"),
    );
    expect(onMountsConfigured).toHaveBeenCalledWith([
      expect.objectContaining({ mountId: "uw-mounted", rootName: "客户资料" }),
    ]);
  });

  it("marks duplicate user-space aliases invalid and available aliases valid", async () => {
    const opsWorkspace = {
      ...mountedWorkspace,
      mountId: "uw-ops",
      name: "Ops Files",
      rootName: "Ops Files",
    };
    mockSnapshot = {
      ...mockSnapshot,
      mounts: [mountedWorkspace, opsWorkspace],
    };
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace, opsWorkspace]} />);

    const dialog = await openUserSpaceManager();
    fireEvent.click(within(dialog).getByRole("button", { name: "重命名Ops Files" }));
    const aliasInput = within(dialog).getByRole("textbox", { name: "Ops Files的别名" });
    expect(aliasInput).toHaveAttribute("data-name-availability", "available");
    expect(aliasInput).toHaveClass("border-success", "focus:ring-success/25");

    fireEvent.change(aliasInput, { target: { value: "client files" } });
    expect(aliasInput).toHaveAttribute("aria-invalid", "true");
    expect(aliasInput).toHaveAttribute("data-name-availability", "invalid");
    expect(aliasInput).toHaveClass("border-danger", "focus:ring-danger/25");
    expect(within(dialog).getByRole("button", { name: "完成重命名client files" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "保存配置" })).toBeDisabled();

    fireEvent.change(aliasInput, { target: { value: "Client Archive" } });
    expect(aliasInput).not.toHaveAttribute("aria-invalid");
    expect(aliasInput).toHaveAttribute("data-name-availability", "available");
    expect(aliasInput).toHaveClass("border-success", "focus:ring-success/25");
    expect(within(dialog).getByRole("button", { name: "完成重命名Client Archive" })).toBeEnabled();
  });

  it("keeps directory mounting available in the manager when no folder is mounted", async () => {
    mockSnapshot = {
      supported: true,
      mounts: [],
      indexing: {},
      recentOperations: [],
    };
    render(<UserSpaceExplorer sessionId="s1" mounts={[]} />);

    expect(screen.queryByTestId("user-space-primary-action-button")).not.toBeInTheDocument();
    const dialog = await openUserSpaceManager();
    expect(within(dialog).getByText("还没有挂载目录。")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "打开 wterm" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "添加目录" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "保存配置" })).toBeEnabled();
  });

  it("localizes the mount switcher button and modal in English", async () => {
    setUiCopyLanguage("en-US");
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />);

    await screen.findByText("README.md");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Manage user space folders",
      }),
    );

    const dialog = screen.getByRole("dialog", { name: "Manage user space folders" });
    expect(
      within(dialog).queryByText("Switch, mount, or remove folders available to this session."),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByRole("list", { name: "User space folder" })).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Client Files, current folder" }),
    ).not.toHaveTextContent("Connected");
    expect(
      screen.getByTestId("user-space-mount-switcher-button").querySelector("span"),
    ).not.toBeInTheDocument();
    const addMountButton = within(dialog).getByRole("button", { name: "Add folder" });
    expect(addMountButton.querySelector(".lucide-plus")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save configuration" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Unmount Client Files" }));
    expect(within(dialog).queryByText("Client Files")).not.toBeInTheDocument();
    expect(mockDetachUserSpaceFromSession).not.toHaveBeenCalled();
  });

  it("expands directories only when requested", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const docsButton = await screen.findByRole("button", { name: "展开 docs" });
    expect(docsButton.querySelector("[data-folder-state='closed']")).toBeInTheDocument();
    fireEvent.click(docsButton);

    await waitFor(() => {
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "list_dir",
        expect.objectContaining({ path: "docs" }),
      );
    });
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    expect(docsButton.querySelector("[data-folder-state='open']")).toBeInTheDocument();
    expect(screen.getByTestId("user-space-tree-guides")).toBeInTheDocument();
  });

  it("does not insert a transient spacer when expanding an empty folder", async () => {
    let resolveEmpty: (value: { entries: [] }) => void = () => {};
    const emptyLoad = new Promise<{ entries: [] }>((resolve) => {
      resolveEmpty = resolve;
    });
    mockExecuteUserSpaceOperation.mockImplementation((_operation, input: { path?: string }) => {
      if (input.path === "empty") return emptyLoad;
      return Promise.resolve({
        entries: [{ name: "empty", path: "empty", kind: "directory" as const }],
      });
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const emptyButton = await screen.findByRole("button", { name: "展开 empty" });
    expect(screen.queryByTestId("user-space-directory-loading-spacer")).not.toBeInTheDocument();

    fireEvent.click(emptyButton);

    expect(emptyButton.querySelector("[data-folder-state='open']")).toBeInTheDocument();
    expect(screen.queryByTestId("user-space-directory-loading-spacer")).not.toBeInTheDocument();

    resolveEmpty({ entries: [] });

    await waitFor(() => {
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "list_dir",
        expect.objectContaining({ path: "empty" }),
      );
    });
    expect(screen.queryByTestId("user-space-directory-loading-spacer")).not.toBeInTheDocument();
    expect(screen.queryByText("目录为空")).not.toBeInTheDocument();
  });

  it("keeps concurrent directory loads independent", async () => {
    let resolveDocs: (value: {
      entries: Array<{ name: string; path: string; kind: "file"; size: number }>;
    }) => void = () => {};
    let resolveAssets: (value: {
      entries: Array<{ name: string; path: string; kind: "file"; size: number }>;
    }) => void = () => {};
    const docsLoad = new Promise<{
      entries: Array<{ name: string; path: string; kind: "file"; size: number }>;
    }>((resolve) => {
      resolveDocs = resolve;
    });
    const assetsLoad = new Promise<{
      entries: Array<{ name: string; path: string; kind: "file"; size: number }>;
    }>((resolve) => {
      resolveAssets = resolve;
    });
    mockExecuteUserSpaceOperation.mockImplementation((_operation, input: { path?: string }) => {
      if (input.path === "docs") return docsLoad;
      if (input.path === "assets") return assetsLoad;
      return Promise.resolve({
        entries: [
          { name: "docs", path: "docs", kind: "directory" as const },
          { name: "assets", path: "assets", kind: "directory" as const },
        ],
      });
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "展开 docs" }));
    fireEvent.click(await screen.findByRole("button", { name: "展开 assets" }));

    resolveAssets({
      entries: [{ name: "logo.png", path: "assets/logo.png", kind: "file" as const, size: 12 }],
    });
    expect(await screen.findByText("logo.png")).toBeInTheDocument();
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();

    resolveDocs({
      entries: [{ name: "notes.txt", path: "docs/notes.txt", kind: "file" as const, size: 9 }],
    });
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
  });

  it("does not keep access buttons locked while persisting access changes", async () => {
    mockConfigureUserSpace.mockReturnValue(new Promise(() => {}));
    mockUpdateUserSpaceAccess.mockResolvedValue({
      ...mountedWorkspace,
      access: "readonly",
      canRead: true,
      canWrite: false,
    });
    const onMountsConfigured = vi.fn();
    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        onMountsConfigured={onMountsConfigured}
      />,
    );

    const readonlyButton = await screen.findByRole("button", { name: "设置Client Files为只读" });
    fireEvent.click(readonlyButton);

    await waitFor(() =>
      expect(mockUpdateUserSpaceAccess).toHaveBeenCalledWith("uw-mounted", "readonly"),
    );
    expect(onMountsConfigured).toHaveBeenCalledWith([
      expect.objectContaining({ mountId: "uw-mounted", access: "readonly", canWrite: false }),
    ]);
    await waitFor(() => expect(readonlyButton).toBeEnabled());
  });

  it("syncs directory metadata from the tree header", async () => {
    const onMountsConfigured = vi.fn();
    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        onMountsConfigured={onMountsConfigured}
      />,
    );

    await screen.findByText("README.md");
    fireEvent.click(screen.getByRole("button", { name: "预览 README.md" }));
    expect(await screen.findByRole("button", { name: "切换预览 README.md" })).toBeInTheDocument();
    expect(await screen.findByTestId("preview-body-uw-mounted:README.md")).toBeInTheDocument();
    mockExecuteUserSpaceOperation.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "同步Client Files空间索引" }));

    await waitFor(() => expect(mockSyncUserSpaceMetadata).toHaveBeenCalledWith("uw-mounted"));
    expect(onMountsConfigured).toHaveBeenCalledWith([
      expect.objectContaining({ mountId: "uw-mounted", fileCount: 8, lastIndexedAt: 123 }),
    ]);
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "list_dir",
        expect.objectContaining({ path: "" }),
      ),
    );
    expect(screen.getByRole("button", { name: "切换预览 README.md" })).toBeInTheDocument();
    expect(screen.getByTestId("preview-body-uw-mounted:README.md")).toBeInTheDocument();
  });

  it("renders Markdown and enables WYSIWYG editing in place", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    const markdownEditor = await screen.findByTestId("markdown-editor-uw-mounted:README.md");
    expect(
      (await within(markdownEditor).findByRole("heading", { name: "Hello" })).textContent,
    ).toBe("Hello");
    expect(within(markdownEditor).getByText("Native Center")).toHaveAttribute("align", "center");
    expect(markdownEditor).toHaveAttribute("data-readonly", "true");
    expect(screen.getByTestId("preview-body-uw-mounted:README.md")).toHaveClass("absolute");
    expect(screen.getByTestId("preview-body-uw-mounted:README.md")).toHaveClass("inset-0");
    expect(screen.getByRole("button", { name: "切换预览 README.md" })).toBeInTheDocument();
    expect(screen.queryByText(/README\.md ·/)).not.toBeInTheDocument();
    const toolbar = await screen.findByTestId("user-space-preview-toolbar");
    const toolbarFileName = within(toolbar).getByTestId("user-space-preview-toolbar-filename");
    const spacePanelToggle = screen.getByTestId("preview-space-panel-toggle");
    const sessionPanelToggle = screen.getByTestId("preview-session-panel-toggle");
    expect(toolbar).toHaveClass("bg-card");
    expect(toolbar).toHaveClass("pl-4", "pr-2");
    expect(toolbar).not.toHaveClass("px-2");
    expect(spacePanelToggle).toHaveClass("my-1", "ml-2", "mr-1", "h-8", "w-8");
    expect(spacePanelToggle).not.toHaveClass("m-1");
    expect(sessionPanelToggle).toHaveClass("my-1", "ml-1", "mr-2", "h-8", "w-8");
    expect(sessionPanelToggle).not.toHaveClass("m-1");
    expect(toolbarFileName).toHaveTextContent("README.md");
    expect(toolbarFileName).toHaveAttribute("title", "README.md");
    expect(toolbarFileName).toHaveClass("truncate", "text-sm", "leading-5", "text-foreground");
    expect(toolbarFileName).not.toHaveClass("break-all");
    expect(screen.queryByTestId("user-space-preview-view-switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "预览" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "文本" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("text-editor-uw-mounted:README.md")).not.toBeInTheDocument();
    const editButton = within(toolbar).getByRole("button", { name: "编辑" });
    expect(editButton).toHaveClass(
      "size-[var(--piwork-titlebar-control-size)]",
      "items-center",
      "justify-center",
      "bg-transparent",
      "hover:bg-accent",
    );
    expect(editButton).not.toHaveClass("border", "bg-secondary");
    expect(editButton.querySelector(".lucide-pencil")).toHaveClass("size-4");
    expect(editButton).toHaveTextContent("");
    const openInNewWindowButton = within(toolbar).getByTestId("preview-open-in-new-window");
    expect(openInNewWindowButton).toHaveClass(
      "size-[var(--piwork-titlebar-control-size)]",
      "items-center",
      "justify-center",
    );
    expect(openInNewWindowButton.querySelector(".lucide-external-link")).toHaveClass("size-4");
    expect(screen.queryByTestId("preview-tab-dirty-uw-mounted:README.md")).not.toBeInTheDocument();
    expect(within(toolbar).queryByText("未保存")).not.toBeInTheDocument();

    fireEvent.click(editButton);

    const wysiwygEditor = await within(markdownEditor).findByTestId("mock-crepe-editor");
    expect(wysiwygEditor).toHaveClass("ProseMirror");
    expect(wysiwygEditor).toHaveAttribute("contenteditable", "true");
    expect(within(markdownEditor).queryByTestId("codemirror-editor")).not.toBeInTheDocument();
    expect(markdownEditor).toHaveAttribute("data-readonly", "false");
    const editorToolbarSlot = await screen.findByTestId("user-space-preview-editor-toolbar-slot");
    expect(toolbar).toHaveClass("py-1");
    expect(toolbar).toHaveClass("pl-2", "pr-2");
    expect(toolbar).not.toHaveClass("pl-4");
    expect(toolbar).not.toHaveClass("py-1.5");
    expect(
      within(toolbar).queryByTestId("user-space-preview-toolbar-filename"),
    ).not.toBeInTheDocument();
    const markdownTopBar = await within(editorToolbarSlot).findByRole("toolbar", {
      name: "Markdown 编辑工具栏",
    });
    expect(markdownTopBar).toHaveClass("piwork-markdown-top-bar");
    expect(within(markdownTopBar).getByRole("button", { name: /段落样式/ })).toHaveClass(
      "piwork-markdown-style-picker",
    );
    expect(within(markdownTopBar).getByRole("button", { name: "加粗" })).toHaveAttribute(
      "title",
      "加粗",
    );
    expect(
      within(markdownTopBar).queryByRole("button", { name: "行内代码" }),
    ).not.toBeInTheDocument();
    expect(within(markdownTopBar).queryByRole("button", { name: "链接" })).not.toBeInTheDocument();
    expect(within(markdownTopBar).queryByRole("button", { name: "图片" })).not.toBeInTheDocument();
    expect(within(markdownTopBar).queryByRole("button", { name: "公式" })).not.toBeInTheDocument();
    (wysiwygEditor as HTMLElement).dataset.markdown = "# Hello\n\nEdited visually";
    fireEvent.input(wysiwygEditor);
    expect(screen.getByTestId("preview-tab-dirty-uw-mounted:README.md")).toBeInTheDocument();
    const saveButton = within(toolbar).getByRole("button", { name: "保存" });
    expect(saveButton).toHaveClass(
      "size-[var(--piwork-titlebar-control-size)]",
      "items-center",
      "justify-center",
      "text-foreground",
      "hover:bg-accent",
    );
    expect(saveButton).not.toHaveClass("border", "bg-secondary");
    expect(saveButton.querySelector(".lucide-save")).toHaveClass("size-4");
    expect(saveButton).toHaveTextContent("");
    expect(saveButton).toBeEnabled();
  });

  it("does not mark Markdown dirty while the rendered preview initializes", async () => {
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "late.md",
          path: "late.md",
          kind: "file" as const,
          size: 32,
          previewKind: "text" as const,
        },
      ],
    });
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) => {
      if (path === "late.md")
        return Promise.resolve(
          new File(["# Late Normalize"], "late.md", { type: "text/markdown" }),
        );
      return defaultMockGetUserSpaceFile(_mountId, path);
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 late.md" }));
    const markdownEditor = await screen.findByTestId("markdown-editor-uw-mounted:late.md");
    const toolbar = await screen.findByTestId("user-space-preview-toolbar");

    expect(
      (await within(markdownEditor).findByRole("heading", { name: "Late Normalize" })).textContent,
    ).toBe("Late Normalize");
    expect(screen.queryByTestId("preview-tab-dirty-uw-mounted:late.md")).not.toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "编辑" })).toBeEnabled();
  });

  it("starts Markdown editing without collapsing the session area", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));

    const markdownEditor = await screen.findByTestId("markdown-editor-uw-mounted:README.md");
    expect(markdownEditor).toHaveAttribute("data-readonly", "true");
    const toolbar = await screen.findByTestId("user-space-preview-toolbar");
    const editButton = within(toolbar).getByRole("button", { name: "编辑" });
    expect(editButton).toHaveClass(
      "size-[var(--piwork-titlebar-control-size)]",
      "items-center",
      "justify-center",
      "hover:bg-accent",
    );
    expect(editButton).not.toHaveClass("border", "bg-secondary");
    expect(editButton.querySelector(".lucide-pencil")).toBeInTheDocument();
    expect(editButton).toHaveTextContent("");
    expect(within(toolbar).queryByRole("button", { name: "保存" })).not.toBeInTheDocument();

    fireEvent.click(editButton);

    const wysiwygEditor = await within(markdownEditor).findByTestId("mock-crepe-editor");
    expect(wysiwygEditor).toHaveAttribute("contenteditable", "true");
    expect(within(markdownEditor).queryByTestId("codemirror-editor")).not.toBeInTheDocument();
    expect(markdownEditor).toHaveAttribute("data-readonly", "false");
    expect(
      within(await screen.findByTestId("user-space-preview-toolbar")).getByRole("button", {
        name: "保存",
      }),
    ).toBeEnabled();
    expect(
      within(await screen.findByTestId("user-space-preview-toolbar")).queryByText("未保存"),
    ).not.toBeInTheDocument();
  });

  it("keeps Markdown in rendered preview mode even when the old text preference is stored", async () => {
    mockFilePreviewDefaults = {
      ...createDefaultFilePreviewDefaults(),
      markdown: "alternate",
    };
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));

    const toolbar = await screen.findByTestId("user-space-preview-toolbar");
    expect(await within(toolbar).findByRole("button", { name: "编辑" })).toBeEnabled();
    expect(within(toolbar).queryByText("未保存")).not.toBeInTheDocument();
    expect(toolbar).toHaveClass("bg-card");
    const markdownEditor = await screen.findByTestId("markdown-editor-uw-mounted:README.md");
    expect(
      (await within(markdownEditor).findByRole("heading", { name: "Hello" })).textContent,
    ).toBe("Hello");
    expect(markdownEditor).toHaveAttribute("data-editing", "false");
    expect(screen.queryByTestId("text-editor-uw-mounted:README.md")).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-space-preview-view-switch")).not.toBeInTheDocument();
  });

  it("loads relative images referenced by markdown previews from the same user space", async () => {
    const createObjectURL = vi.mocked(globalThis.URL.createObjectURL);
    const revokeObjectURL = vi.mocked(globalThis.URL.revokeObjectURL);
    createObjectURL.mockImplementation((blob) =>
      blob instanceof File && blob.name === "diagram.png"
        ? "blob:http://localhost/markdown-image"
        : "blob:http://localhost/workspace-preview",
    );
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "guide.md",
          path: "docs/guide.md",
          kind: "file" as const,
          size: 64,
          previewKind: "text" as const,
        },
      ],
    });
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) => {
      if (path === "docs/guide.md") {
        return Promise.resolve(
          new File(
            [
              "# Guide\n\n![Diagram](assets/diagram.png)\n\n![Remote](https://example.com/remote.png)\n\n",
              "x".repeat(280 * 1024),
            ],
            "guide.md",
            { type: "text/markdown" },
          ),
        );
      }
      if (path === "docs/assets/diagram.png") {
        return Promise.resolve(new File(["png"], "diagram.png", { type: "image/png" }));
      }
      return defaultMockGetUserSpaceFile(_mountId, path);
    });
    const readonlyWorkspace = { ...mountedWorkspace, access: "readonly" as const, canWrite: false };
    mockSnapshot = {
      ...mockSnapshot,
      mounts: [readonlyWorkspace],
    };

    const { unmount } = render(<UserSpaceExplorer sessionId="s1" mounts={[readonlyWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 guide.md" }));

    await waitFor(() => {
      expect(mockGetUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "docs/assets/diagram.png");
    });
    await waitFor(() => {
      expect(screen.getByAltText("Diagram")).toHaveAttribute(
        "src",
        "blob:http://localhost/markdown-image",
      );
    });
    expect(mockGetUserSpaceFile).not.toHaveBeenCalledWith(
      "uw-mounted",
      "https://example.com/remote.png",
    );
    unmount();
    await waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/markdown-image"),
    );
  });

  it("keeps relative image sources intact while editing rendered Markdown", async () => {
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "guide.md",
          path: "docs/guide.md",
          kind: "file" as const,
          size: 64,
          previewKind: "text" as const,
        },
      ],
    });
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) => {
      if (path === "docs/guide.md") {
        return Promise.resolve(
          new File(
            [
              "# Guide\n\n![Diagram](assets/diagram.png)\n\n![Remote](https://example.com/remote.png)\n",
            ],
            "guide.md",
            { type: "text/markdown" },
          ),
        );
      }
      if (path === "docs/assets/diagram.png") {
        return Promise.resolve(new File(["png"], "diagram.png", { type: "image/png" }));
      }
      return defaultMockGetUserSpaceFile(_mountId, path);
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 guide.md" }));
    const markdownEditor = await screen.findByTestId("markdown-editor-uw-mounted:docs/guide.md");
    await within(markdownEditor).findByAltText("Diagram");

    await waitFor(() => {
      expect(mockGetUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "docs/assets/diagram.png");
    });
    await waitFor(() => {
      expect(within(markdownEditor).getByAltText("Diagram")).toHaveAttribute(
        "src",
        "blob:http://localhost/workspace-preview",
      );
    });
    expect(mockGetUserSpaceFile).not.toHaveBeenCalledWith(
      "uw-mounted",
      "https://example.com/remote.png",
    );

    const toolbar = await screen.findByTestId("user-space-preview-toolbar");
    mockExecuteUserSpaceOperation.mockClear();
    fireEvent.click(within(toolbar).getByRole("button", { name: "编辑" }));
    const wysiwygEditor = (await within(markdownEditor).findByTestId(
      "mock-crepe-editor",
    )) as HTMLDivElement;
    wysiwygEditor.dataset.markdown =
      "# Guide\n\n![Diagram](blob:http://localhost/workspace-preview)\n\nUpdated\n";
    fireEvent.input(wysiwygEditor);
    await waitFor(() =>
      expect(screen.getByTestId("preview-tab-dirty-uw-mounted:docs/guide.md")).toBeInTheDocument(),
    );

    fireEvent.click(within(toolbar).getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("write_file", {
        mountId: "uw-mounted",
        path: "docs/guide.md",
        content: "# Guide\n\n![Diagram](assets/diagram.png)\n\nUpdated\n",
        createParents: false,
      }),
    );
  });

  it("edits and saves Markdown through the WYSIWYG editor", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    const markdownEditor = await screen.findByTestId("markdown-editor-uw-mounted:README.md");

    const toolbar = await screen.findByTestId("user-space-preview-toolbar");
    expect(within(toolbar).queryByRole("button", { name: "预览" })).not.toBeInTheDocument();
    expect(within(toolbar).queryByRole("button", { name: "文本" })).not.toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "编辑" })).toBeEnabled();
    expect(within(toolbar).queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    expect(within(toolbar).queryByText("未保存")).not.toBeInTheDocument();
    expect(markdownEditor).toHaveAttribute("data-readonly", "true");
    mockExecuteUserSpaceOperation.mockClear();

    fireEvent.click(within(toolbar).getByRole("button", { name: "编辑" }));
    const wysiwygEditor = await within(markdownEditor).findByTestId("mock-crepe-editor");
    expect(markdownEditor).toHaveAttribute("data-readonly", "false");
    expect(wysiwygEditor).toHaveAttribute("contenteditable", "true");
    expect(within(toolbar).getByRole("button", { name: "保存" })).toBeEnabled();

    (wysiwygEditor as HTMLElement).dataset.markdown = "# Hello\n\nUpdated from WYSIWYG";
    fireEvent.input(wysiwygEditor);
    await waitFor(() =>
      expect(screen.getByTestId("preview-tab-dirty-uw-mounted:README.md")).toBeInTheDocument(),
    );
    expect(within(toolbar).getByRole("button", { name: "保存" })).toBeEnabled();
    expect(within(toolbar).queryByText("未保存")).not.toBeInTheDocument();

    fireEvent.click(within(toolbar).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("write_file", {
        mountId: "uw-mounted",
        path: "README.md",
        content: "# Hello\n\nUpdated from WYSIWYG",
        createParents: false,
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("preview-tab-dirty-uw-mounted:README.md"),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(within(toolbar).getByRole("button", { name: "编辑" })).toBeEnabled(),
    );
    expect(within(toolbar).queryByText("未保存")).not.toBeInTheDocument();
  });

  it("renders indexed text through the generic editor in readonly mode", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 app.ts" }));
    expect(await screen.findByRole("button", { name: "切换预览 app.ts" })).toBeInTheDocument();
    expect(screen.queryByText(/app\.ts ·/)).not.toBeInTheDocument();
    const editor = await screen.findByTestId("text-editor-uw-mounted:app.ts");
    const textArea = within(editor).getByTestId("codemirror-editor");
    expect(textArea).toHaveValue("const answer: number = 42;");
    expect(textArea).toHaveAttribute("data-readonly", "true");
    expect(textArea).toHaveAttribute("data-editable", "false");
    expect(editor).toHaveClass("bg-background");
    const basicSetup = JSON.parse(textArea.getAttribute("data-basic-setup") || "{}") as Record<
      string,
      unknown
    >;
    expect(basicSetup).toMatchObject({
      lineNumbers: true,
      highlightActiveLineGutter: false,
      autocompletion: false,
      lintKeymap: false,
      foldGutter: false,
      foldKeymap: false,
      completionKeymap: false,
    });
    expect(editor).toHaveAttribute("data-language-mode", "language");
  });

  it("edits and saves text previews through the user space write operation shortcut", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 app.ts" }));
    const editor = await screen.findByTestId("text-editor-uw-mounted:app.ts");
    const textArea = within(editor).getByTestId("codemirror-editor");
    expect(within(editor).queryByText("app.ts")).not.toBeInTheDocument();
    mockExecuteUserSpaceOperation.mockClear();
    let resolveWrite: (() => void) | undefined;
    mockExecuteUserSpaceOperation.mockImplementation((operation) => {
      if (operation === "write_file") {
        return new Promise((resolve) => {
          resolveWrite = () => resolve({});
        });
      }
      return Promise.resolve({ entries: rootEntries });
    });

    const toolbar = await screen.findByTestId("user-space-preview-toolbar");
    expect(within(editor).queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    fireEvent.click(await within(toolbar).findByRole("button", { name: "编辑" }));
    expect(textArea).toHaveAttribute("data-editable", "true");
    fireEvent.change(textArea, { target: { value: "const answer = 43;" } });
    await waitFor(() =>
      expect(screen.getByTestId("preview-tab-dirty-uw-mounted:app.ts")).toBeInTheDocument(),
    );
    fireEvent.click(within(toolbar).getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("write_file", {
        mountId: "uw-mounted",
        path: "app.ts",
        content: "const answer = 43;",
        createParents: false,
      }),
    );
    await waitFor(() =>
      expect(within(toolbar).getByRole("button", { name: "保存" })).toBeDisabled(),
    );
    expect(within(toolbar).queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    expect(resolveWrite).toBeDefined();
    await act(async () => {
      resolveWrite?.();
    });
    await waitFor(() =>
      expect(within(editor).getByTestId("codemirror-editor")).toHaveAttribute(
        "data-readonly",
        "true",
      ),
    );
    expect(within(toolbar).queryByText("已保存")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId("preview-tab-dirty-uw-mounted:app.ts")).not.toBeInTheDocument(),
    );
  });

  it("keeps an unsaved text draft alive after moving the open file and saves to its new path", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 app.ts" }));
    const editor = await screen.findByTestId("text-editor-uw-mounted:app.ts");
    const textArea = within(editor).getByTestId("codemirror-editor");
    const toolbar = await screen.findByTestId("user-space-preview-toolbar");
    fireEvent.click(await within(toolbar).findByRole("button", { name: "编辑" }));
    fireEvent.change(textArea, { target: { value: "const answer = 99;" } });
    await waitFor(() =>
      expect(screen.getByTestId("preview-tab-dirty-uw-mounted:app.ts")).toBeInTheDocument(),
    );

    mockExecuteUserSpaceOperation.mockClear();
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "move_entries") {
        return Promise.resolve({
          ok: true,
          moves: [{ sourcePath: "app.ts", path: "docs/app.ts", kind: "file" }],
        });
      }
      if (operation === "write_file") return Promise.resolve({ ok: true });
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [
            {
              name: "app.ts",
              path: "docs/app.ts",
              kind: "file",
              size: 18,
              previewKind: "text",
              supportsLineEdit: true,
            },
          ],
        });
      }
      return Promise.resolve({ entries: rootEntries });
    });

    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(screen.getByTestId("user-space-entry-row-uw-mounted:app.ts"), {
      dataTransfer,
    });
    const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("move_entries", {
        mountId: "uw-mounted",
        paths: ["app.ts"],
        targetDirPath: "docs",
      }),
    );
    expect(within(editor).getByTestId("codemirror-editor")).toBe(textArea);
    expect(textArea).toHaveValue("const answer = 99;");
    expect(textArea).toHaveAttribute("data-editable", "true");
    expect(screen.getByTestId("preview-tab-dirty-uw-mounted:app.ts")).toBeInTheDocument();

    fireEvent.click(within(toolbar).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("write_file", {
        mountId: "uw-mounted",
        path: "docs/app.ts",
        content: "const answer = 99;",
        createParents: false,
      }),
    );
  });

  it("waits for a pending move before saving text to the relocated path", async () => {
    const pendingMove = deferred<{
      ok: true;
      moves: Array<{ sourcePath: string; path: string; kind: "file" }>;
    }>();
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 app.ts" }));
    const editor = await screen.findByTestId("text-editor-uw-mounted:app.ts");
    const textArea = within(editor).getByTestId("codemirror-editor");
    const toolbar = await screen.findByTestId("user-space-preview-toolbar");
    fireEvent.click(await within(toolbar).findByRole("button", { name: "编辑" }));
    fireEvent.change(textArea, { target: { value: "const answer = 202;" } });
    await waitFor(() =>
      expect(screen.getByTestId("preview-tab-dirty-uw-mounted:app.ts")).toBeInTheDocument(),
    );

    mockExecuteUserSpaceOperation.mockClear();
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "move_entries") return pendingMove.promise;
      if (operation === "write_file") return Promise.resolve({ ok: true });
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [
            {
              name: "app.ts",
              path: "docs/app.ts",
              kind: "file",
              size: 19,
              previewKind: "text",
              supportsLineEdit: true,
            },
          ],
        });
      }
      return Promise.resolve({ entries: rootEntries });
    });

    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(screen.getByTestId("user-space-entry-row-uw-mounted:app.ts"), {
      dataTransfer,
    });
    const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("move_entries", {
        mountId: "uw-mounted",
        paths: ["app.ts"],
        targetDirPath: "docs",
      }),
    );

    fireEvent.click(within(toolbar).getByRole("button", { name: "保存" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      mockExecuteUserSpaceOperation.mock.calls.some(([operation]) => operation === "write_file"),
    ).toBe(false);

    await act(async () => {
      pendingMove.resolve({
        ok: true,
        moves: [{ sourcePath: "app.ts", path: "docs/app.ts", kind: "file" }],
      });
      await pendingMove.promise;
    });

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("write_file", {
        mountId: "uw-mounted",
        path: "docs/app.ts",
        content: "const answer = 202;",
        createParents: false,
      }),
    );
    expect(mockExecuteUserSpaceOperation).not.toHaveBeenCalledWith(
      "write_file",
      expect.objectContaining({ path: "app.ts" }),
    );
  });

  it("reconciles a pending move after switching spaces and keeps the dirty draft on its new path", async () => {
    const pendingMove = deferred<{
      ok: true;
      moves: Array<{ sourcePath: string; path: string; kind: "file" }>;
    }>();
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 app.ts" }));
    const editor = await screen.findByTestId("text-editor-uw-mounted:app.ts");
    const textArea = within(editor).getByTestId("codemirror-editor");
    const toolbar = await screen.findByTestId("user-space-preview-toolbar");
    fireEvent.click(await within(toolbar).findByRole("button", { name: "编辑" }));
    fireEvent.change(textArea, { target: { value: "const answer = 101;" } });

    mockExecuteUserSpaceOperation.mockClear();
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "move_entries") return pendingMove.promise;
      if (operation === "write_file") return Promise.resolve({ ok: true });
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [
            {
              name: "app.ts",
              path: "docs/app.ts",
              kind: "file",
              size: 19,
              previewKind: "text",
              supportsLineEdit: true,
            },
          ],
        });
      }
      return Promise.resolve({ entries: rootEntries });
    });

    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(screen.getByTestId("user-space-entry-row-uw-mounted:app.ts"), {
      dataTransfer,
    });
    const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("move_entries", {
        mountId: "uw-mounted",
        paths: ["app.ts"],
        targetDirPath: "docs",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "预览 index.html" }));
    await screen.findByTestId("preview-tab-uw-mounted:index.html");
    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    await act(async () => {
      pendingMove.resolve({
        ok: true,
        moves: [{ sourcePath: "app.ts", path: "docs/app.ts", kind: "file" }],
      });
      await pendingMove.promise;
    });

    expect(screen.getByRole("tab", { name: "Agent空间" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-tab-uw-mounted:index.html")).toHaveClass("bg-accent");
    expect(within(editor).getByTestId("codemirror-editor")).toBe(textArea);
    expect(textArea).toHaveValue("const answer = 101;");
    expect(screen.getByTestId("preview-tab-dirty-uw-mounted:app.ts")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "切换预览 app.ts" }));
    fireEvent.click(within(toolbar).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("write_file", {
        mountId: "uw-mounted",
        path: "docs/app.ts",
        content: "const answer = 101;",
        createParents: false,
      }),
    );
  });

  it("saves the focused editor with the platform save shortcut while editing", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 app.ts" }));
    const editor = await screen.findByTestId("text-editor-uw-mounted:app.ts");
    const textArea = within(editor).getByTestId("codemirror-editor");
    mockExecuteUserSpaceOperation.mockClear();

    const toolbar = await screen.findByTestId("user-space-preview-toolbar");
    fireEvent.click(await within(toolbar).findByRole("button", { name: "编辑" }));
    fireEvent.change(textArea, { target: { value: "const answer = 45;" } });
    await waitFor(() =>
      expect(screen.getByTestId("preview-tab-dirty-uw-mounted:app.ts")).toBeInTheDocument(),
    );
    fireEvent.keyDown(editor, { key: "s", metaKey: true });

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("write_file", {
        mountId: "uw-mounted",
        path: "app.ts",
        content: "const answer = 45;",
        createParents: false,
      }),
    );
    await waitFor(() =>
      expect(within(editor).getByTestId("codemirror-editor")).toHaveAttribute(
        "data-readonly",
        "true",
      ),
    );
    expect(within(toolbar).queryByText("已保存")).not.toBeInTheDocument();
  });

  it("marks unsaved preview tabs and confirms before closing them", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 app.ts" }));
    const editor = await screen.findByTestId("text-editor-uw-mounted:app.ts");
    const textArea = within(editor).getByTestId("codemirror-editor");

    const toolbar = await screen.findByTestId("user-space-preview-toolbar");
    fireEvent.click(await within(toolbar).findByRole("button", { name: "编辑" }));
    fireEvent.change(textArea, { target: { value: "const answer = 44;" } });

    await waitFor(() =>
      expect(screen.getByTestId("preview-tab-dirty-uw-mounted:app.ts")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭预览 app.ts" }));

    const closeDialog = screen.getByRole("alertdialog", { name: "关闭未保存文件？" });
    expect(closeDialog).toHaveClass(
      "piwork-superellipse-panel",
      "rounded-[var(--piwork-panel-radius)]",
      "border",
      "bg-card",
    );
    expect(within(closeDialog).queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
    expect(
      within(closeDialog).getByText("app.ts 有未保存的修改，继续关闭会丢失这些更改。"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "切换预览 app.ts", hidden: true }),
    ).toBeInTheDocument();

    expect(within(closeDialog).getByRole("button", { name: "取消" })).toHaveClass(
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(within(closeDialog).getByRole("button", { name: "继续关闭" })).toHaveClass(
      "rounded-[var(--piwork-control-radius)]",
    );
    fireEvent.click(within(closeDialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog", { name: "关闭未保存文件？" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换预览 app.ts" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭预览 app.ts" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog", { name: "关闭未保存文件？" })).getByRole("button", {
        name: "继续关闭",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "切换预览 app.ts" })).not.toBeInTheDocument(),
    );
  });

  it("reuses already-open preview tabs when files are selected from the tree", async () => {
    const revokeObjectURL = vi.mocked(globalThis.URL.revokeObjectURL);
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeTreeButton = await screen.findByRole("button", { name: "预览 README.md" });
    const appTreeButton = screen.getByRole("button", { name: "预览 app.ts" });

    fireEvent.click(appTreeButton);
    const appEditor = await screen.findByTestId("text-editor-uw-mounted:app.ts");
    const appTextArea = within(appEditor).getByTestId("codemirror-editor");

    mockGetUserSpaceFile.mockClear();
    revokeObjectURL.mockClear();
    fireEvent.click(appTreeButton);

    expect(mockGetUserSpaceFile).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(screen.getByTestId("text-editor-uw-mounted:app.ts")).toBe(appEditor);

    fireEvent.click(screen.getByRole("button", { name: "预览 README.md" }));
    expect(await screen.findByRole("button", { name: "切换预览 README.md" })).toBeInTheDocument();

    mockGetUserSpaceFile.mockClear();
    revokeObjectURL.mockClear();
    fireEvent.click(appTreeButton);

    expect(mockGetUserSpaceFile).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(screen.getByTestId("text-editor-uw-mounted:app.ts")).toBe(appEditor);
    expect(within(appEditor).getByTestId("codemirror-editor")).toBe(appTextArea);
    expect(screen.getByTestId("preview-tab-uw-mounted:app.ts")).toHaveClass(
      "bg-accent",
      "text-foreground",
    );
    expect(screen.getByTestId("preview-tab-uw-mounted:app.ts")).not.toHaveClass(
      "piwork-theme-selected-tab",
    );
  });

  it("keeps all preview tabs mounted and switches mounted tabs without reloading", async () => {
    const createObjectURL = vi.mocked(globalThis.URL.createObjectURL);
    let nextUrl = 0;
    createObjectURL.mockImplementation(() => `blob:http://localhost/preview-${++nextUrl}`);
    const fileNames = Array.from(
      { length: 11 },
      (_, index) => `tab-${String(index).padStart(2, "0")}.txt`,
    );
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: fileNames.map((fileName) => ({
        name: fileName,
        path: fileName,
        kind: "file" as const,
        size: 12,
        previewKind: "text" as const,
        supportsLineEdit: true,
      })),
    });
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) =>
      Promise.resolve(new File([`content for ${path}`], path, { type: "text/plain" })),
    );
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);
    const tabScroller = screen.getByTestId("user-space-preview-tab-scroll");
    Object.defineProperties(tabScroller, {
      clientWidth: { configurable: true, value: 320 },
      scrollWidth: { configurable: true, value: 1_120 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });

    for (const [index, fileName] of fileNames.entries()) {
      if (index === fileNames.length - 1) tabScroller.scrollLeft = 0;
      fireEvent.click(await screen.findByRole("button", { name: `预览 ${fileName}` }));
      expect(
        await screen.findByRole("button", { name: `切换预览 ${fileName}` }),
      ).toBeInTheDocument();
    }

    await waitFor(() => {
      expect(screen.getAllByTestId(/^preview-tab-uw-mounted:/)).toHaveLength(11);
    });
    for (const fileName of fileNames) {
      expect(screen.getByRole("button", { name: `切换预览 ${fileName}` })).toBeInTheDocument();
    }
    expect(tabScroller.scrollLeft).toBe(800);
    expect(tabScroller.lastElementChild).toBe(
      screen.getByTestId("preview-tab-uw-mounted:tab-10.txt"),
    );

    const tab03Editor = screen.getByTestId("text-editor-uw-mounted:tab-03.txt");
    mockGetUserSpaceFile.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "切换预览 tab-10.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "切换预览 tab-03.txt" }));

    expect(mockGetUserSpaceFile).not.toHaveBeenCalled();
    expect(screen.getByTestId("text-editor-uw-mounted:tab-03.txt")).toBe(tab03Editor);
    createObjectURL.mockReturnValue("blob:http://localhost/workspace-preview");
  });

  it("renders preview tabs as a compact document tab bar", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));

    const tabbar = screen.getByTestId("user-space-preview-tabbar");
    const readmeTab = screen.getByTestId("preview-tab-uw-mounted:README.md");

    expect(tabbar).toHaveClass("h-10", "items-stretch", "border-b", "border-border", "bg-card");
    const tabScroll = screen.getByTestId("user-space-preview-tab-scroll");
    expect(tabScroll).toHaveClass("gap-1", "p-1");
    expect(tabScroll).not.toHaveClass("gap-0.5");
    expect(readmeTab).toHaveClass("h-full", "text-sm", "bg-accent", "text-foreground");
    expect(readmeTab).toHaveClass("border", "border-border");
    expect(readmeTab).not.toHaveClass("piwork-theme-selected-tab");
    expect(readmeTab.className).toContain("rounded-[var(--piwork-control-radius)]");
    expect(readmeTab).not.toHaveClass("rounded-none", "border-r");
    expect(screen.getByRole("button", { name: "切换预览 README.md" })).toHaveClass(
      "absolute",
      "inset-0",
      "z-0",
    );
    const tabIconSlot = screen.getByTestId("preview-tab-icon-uw-mounted:README.md");
    expect(tabIconSlot).toHaveClass("h-6", "w-6", "shrink-0", "items-center", "justify-center");
    expectFileIcon(tabIconSlot.querySelector("[data-file-icon='markdown']"), "h-5");
    const readmeTabTitle = within(readmeTab).getByText("README.md");
    expect(readmeTabTitle).toHaveClass("min-w-0", "flex-1", "truncate");
    expect(readmeTabTitle).not.toHaveClass("break-all");
    const closeButton = screen.getByRole("button", { name: "关闭预览 README.md" });
    expect(closeButton).toHaveClass(
      "h-5",
      "w-5",
      "shrink-0",
      "justify-center",
      "opacity-0",
      "group-hover/tab:opacity-100",
    );
    expect(closeButton).not.toHaveClass("justify-start", "pl-0.5");
    expect(closeButton).not.toHaveClass("-translate-x-1");
    expect(closeButton).not.toHaveClass("absolute");

    fireEvent.click(await screen.findByRole("button", { name: "预览 app.ts" }));

    expect(screen.getByTestId("preview-tab-uw-mounted:README.md")).toHaveClass(
      "bg-transparent",
      "text-foreground",
      "border",
      "border-border",
    );
    expect(screen.getByTestId("preview-tab-uw-mounted:README.md")).not.toHaveClass(
      "text-muted-foreground",
      "hover:text-foreground",
    );
    expect(screen.getByTestId("preview-tab-uw-mounted:app.ts")).toHaveClass(
      "bg-accent",
      "text-foreground",
      "border",
      "border-border",
    );
    expect(screen.getByTestId("preview-tab-uw-mounted:app.ts")).not.toHaveClass(
      "piwork-theme-selected-tab",
    );
  });

  it("keeps the session panel toggle fixed at the right edge of the preview tab bar", async () => {
    const onSessionPanelCollapsedChange = vi.fn();
    const { rerender } = render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        previewOpen
        sessionPanelCollapsed={false}
        onSessionPanelCollapsedChange={onSessionPanelCollapsedChange}
        uiLanguage="zh-CN"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    const tabbar = screen.getByTestId("user-space-preview-tabbar");
    const collapseButton = screen.getByRole("button", { name: "折叠会话面板" });
    expect(tabbar.lastElementChild).toBe(collapseButton);
    expect(collapseButton).toHaveClass(
      "my-1",
      "ml-1",
      "mr-2",
      "h-8",
      "w-8",
      "shrink-0",
      "rounded-[var(--piwork-control-radius)]",
      "hover:bg-accent",
    );
    expect(collapseButton).not.toHaveClass("border-l", "border-border");
    expect(collapseButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(collapseButton);
    expect(onSessionPanelCollapsedChange).toHaveBeenCalledWith(true);

    setUiCopyLanguage("en-US");
    rerender(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        previewOpen
        sessionPanelCollapsed
        onSessionPanelCollapsedChange={onSessionPanelCollapsedChange}
        uiLanguage="en-US"
      />,
    );

    const expandButton = await screen.findByRole("button", { name: "Expand session panel" });
    expect(expandButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Workspace file sidebar")).toHaveStyle({
      gridTemplateColumns: "20% minmax(0, 1fr)",
    });
    fireEvent.click(expandButton);
    expect(onSessionPanelCollapsedChange).toHaveBeenLastCalledWith(false);
  });

  it("collapses and expands the User and Agent space panel from the left edge of the preview tab bar", async () => {
    const { rerender } = render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        previewOpen
        uiLanguage="zh-CN"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    const tabbar = screen.getByTestId("user-space-preview-tabbar");
    const treePanel = screen.getByTestId("user-space-tree-panel");
    const collapseButton = screen.getByRole("button", {
      name: "折叠用户｜Agent空间面板",
    });
    expect(tabbar.firstElementChild).toBe(collapseButton);
    expect(collapseButton).toHaveClass(
      "my-1",
      "ml-2",
      "mr-1",
      "h-8",
      "w-8",
      "shrink-0",
      "rounded-[var(--piwork-control-radius)]",
      "hover:bg-accent",
    );
    expect(collapseButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(collapseButton);

    expect(screen.getByLabelText("工作区文件边栏")).toHaveStyle({
      gridTemplateColumns: "0px minmax(0, 1fr)",
    });
    expect(treePanel).toHaveAttribute("aria-hidden", "true");
    expect(treePanel).toHaveClass("pointer-events-none", "invisible", "overflow-hidden");

    setUiCopyLanguage("en-US");
    rerender(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        previewOpen
        uiLanguage="en-US"
      />,
    );

    const expandButton = await screen.findByRole("button", {
      name: "Expand User | Agent space panel",
    });
    expect(expandButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(expandButton);

    expect(screen.getByLabelText("Workspace file sidebar")).toHaveStyle({
      gridTemplateColumns: "28.571429% minmax(0, 1fr)",
    });
    expect(treePanel).not.toHaveAttribute("aria-hidden");
  });

  it("collapses and expands the User and Agent space panel from a parent shortcut request", async () => {
    const { rerender } = render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        previewOpen
        toggleSpacePanelRequest={0}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    const sidebar = screen.getByLabelText("工作区文件边栏");
    expect(sidebar).toHaveStyle({ gridTemplateColumns: "28.571429% minmax(0, 1fr)" });

    rerender(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        previewOpen
        toggleSpacePanelRequest={1}
      />,
    );
    expect(sidebar).toHaveStyle({ gridTemplateColumns: "0px minmax(0, 1fr)" });

    rerender(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        previewOpen
        toggleSpacePanelRequest={2}
      />,
    );
    expect(sidebar).toHaveStyle({ gridTemplateColumns: "28.571429% minmax(0, 1fr)" });
  });

  it("keeps a single preview tab draggable", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));

    const readmeTab = screen.getByTestId("preview-tab-uw-mounted:README.md");
    vi.spyOn(readmeTab, "getBoundingClientRect").mockReturnValue(
      createDomRect({
        x: 150,
        y: 72,
        width: 186,
        height: 31,
      }),
    );

    expect(readmeTab).toHaveAttribute("draggable", "false");

    fireEvent.pointerDown(readmeTab, { button: 0, pointerId: 1, clientX: 240, clientY: 90 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 252, clientY: 94 });

    const proxy = screen.getByTestId("preview-tab-drag-proxy");
    expect(proxy).toHaveTextContent("README.md");
    expect(proxy).toHaveClass("transition-none");
    expect(proxy).toHaveStyle({ width: "186px", height: "31px" });
  });

  it("keeps ordinary preview tab clicks out of the drag capture path", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "预览 app.ts" }));

    const readmeTab = screen.getByTestId("preview-tab-uw-mounted:README.md");
    const readmeSelectButton = screen.getByRole("button", { name: "切换预览 README.md" });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const hasPointerCapture = vi.fn(() => false);
    Object.assign(readmeTab, { setPointerCapture, releasePointerCapture, hasPointerCapture });

    fireEvent.pointerDown(readmeTab, { button: 0, pointerId: 1, clientX: 160, clientY: 18 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 160, clientY: 18 });
    fireEvent.click(readmeSelectButton);

    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(releasePointerCapture).not.toHaveBeenCalled();
    expect(screen.queryByTestId("preview-tab-drag-proxy")).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-space-preview-pointer-shield")).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-tab-uw-mounted:README.md")).toHaveClass(
      "bg-accent",
      "text-foreground",
    );
    expect(screen.getByTestId("preview-tab-uw-mounted:app.ts")).toHaveClass("bg-transparent");
  });

  it("renders a full tab surface when dragging an inactive preview tab", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "预览 app.ts" }));

    const readmeTab = screen.getByTestId("preview-tab-uw-mounted:README.md");
    vi.spyOn(readmeTab, "getBoundingClientRect").mockReturnValue(
      createDomRect({
        x: 150,
        y: 72,
        width: 186,
        height: 31,
      }),
    );

    expect(readmeTab).toHaveClass("bg-transparent");

    fireEvent.pointerDown(readmeTab, { button: 0, pointerId: 1, clientX: 240, clientY: 90 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 252, clientY: 94 });

    const proxy = screen.getByTestId("preview-tab-drag-proxy");
    expect(readmeTab).toHaveClass("bg-transparent");
    expect(proxy).toHaveClass("bg-accent", "text-foreground", "transition-none");
    expect(proxy).toHaveStyle({ width: "186px", height: "31px" });
  });

  it("supports manually reordering preview tabs without remounting the preview body", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "预览 app.ts" }));

    const tabbar = screen.getByTestId("user-space-preview-tabbar");
    const appEditor = await screen.findByTestId("text-editor-uw-mounted:app.ts");
    const readmeTab = screen.getByTestId("preview-tab-uw-mounted:README.md");
    const appTab = screen.getByTestId("preview-tab-uw-mounted:app.ts");
    mockElementRect(readmeTab, {
      x: 100,
      y: 4,
      width: 180,
      height: 32,
    });
    mockElementRect(appTab, {
      x: 280,
      y: 4,
      width: 180,
      height: 32,
    });

    mockElementFromPoint(readmeTab);
    dispatchElementPointerDown(appTab, { button: 0, pointerId: 1, clientX: 360, clientY: 18 });
    dispatchWindowPointerDragEvent("pointermove", { clientX: 290, clientY: 18 });
    expect(screen.queryByTestId("preview-tab-drop-indicator")).not.toBeInTheDocument();
    dispatchWindowPointerDragEvent("pointermove", { clientX: 210, clientY: 18 });
    expect(screen.getByTestId("preview-tab-drop-indicator")).toHaveAttribute(
      "data-drop-edge",
      "before",
    );
    expect(screen.getByTestId("preview-tab-drop-indicator")).toHaveClass(
      "left-0",
      "w-0.5",
      "bg-preview-drop-indicator",
    );
    expect(screen.getByTestId("preview-tab-drop-indicator")).not.toHaveClass(
      "border-x",
      "border-background",
    );
    dispatchWindowPointerDragEvent("pointerup", { clientX: 210, clientY: 18 });

    expect(
      within(tabbar)
        .getAllByTestId(/^preview-tab-uw-mounted:/)
        .map((tab) => tab.getAttribute("data-testid")),
    ).toEqual(["preview-tab-uw-mounted:app.ts", "preview-tab-uw-mounted:README.md"]);
    expect(screen.getByTestId("text-editor-uw-mounted:app.ts")).toBe(appEditor);
    expect(screen.getByTestId("preview-tab-uw-mounted:app.ts")).toHaveClass(
      "bg-accent",
      "text-foreground",
    );
    expect(screen.getByTestId("preview-tab-uw-mounted:app.ts")).not.toHaveClass(
      "piwork-theme-selected-tab",
    );
  });

  it("automatically scrolls the preview tab strip while dragging near its horizontal edges", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "预览 app.ts" }));

    const scroller = screen.getByTestId("user-space-preview-tab-scroll");
    const readmeTab = screen.getByTestId("preview-tab-uw-mounted:README.md");
    const appTab = screen.getByTestId("preview-tab-uw-mounted:app.ts");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 900 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });
    mockElementRect(scroller, { x: 100, y: 0, width: 300, height: 40 });
    mockElementRect(readmeTab, { x: 104, y: 4, width: 180, height: 32 });
    mockElementRect(appTab, { x: 286, y: 4, width: 180, height: 32 });
    mockElementFromPoint(appTab);

    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    const cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);

    dispatchElementPointerDown(readmeTab, { button: 0, pointerId: 1, clientX: 180, clientY: 18 });
    dispatchWindowPointerDragEvent("pointermove", { clientX: 396, clientY: 18 });

    expect(requestFrame).toHaveBeenCalledTimes(1);
    act(() => frames.shift()?.(0));
    expect(scroller.scrollLeft).toBeGreaterThan(0);
    expect(requestFrame).toHaveBeenCalledTimes(2);

    dispatchWindowPointerDragEvent("pointerup", { clientX: 396, clientY: 18 });
    expect(cancelFrame).toHaveBeenCalled();
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it("restores preview tab hover styling and close buttons when dragging ends", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "预览 app.ts" }));

    const readmeTab = screen.getByTestId("preview-tab-uw-mounted:README.md");
    const appTab = screen.getByTestId("preview-tab-uw-mounted:app.ts");
    const readmeCloseButton = screen.getByRole("button", { name: "关闭预览 README.md" });
    vi.spyOn(screen.getByTestId("user-space-preview-tabbar"), "matches").mockReturnValue(true);
    const readmeClassName = readmeTab.className;
    const appClassName = appTab.className;

    expect(readmeTab).toHaveClass("hover:bg-accent");
    expect(readmeCloseButton).toHaveClass("group-hover/tab:opacity-100");

    fireEvent.pointerDown(appTab, { button: 0, pointerId: 1, clientX: 260, clientY: 18 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 274, clientY: 18 });

    expect(readmeTab).not.toHaveClass("hover:bg-accent");
    expect(readmeCloseButton).not.toHaveClass("group-hover/tab:opacity-100");
    expect(appTab.className).toBe(appClassName);
    expect(screen.getByTestId("preview-tab-drag-proxy")).toHaveTextContent("app.ts");

    mockElementFromPoint(readmeTab);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 140, clientY: 18 });

    expect(readmeTab).not.toHaveClass("hover:bg-accent");
    expect(appTab.className).toBe(appClassName);

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 140, clientY: 18 });

    expect(readmeTab.className).toBe(readmeClassName);
    expect(readmeCloseButton).toHaveClass("group-hover/tab:opacity-100");
    expect(appTab.className).toBe(appClassName);
    expect(screen.getByTestId("user-space-preview-tabbar")).not.toHaveStyle({
      pointerEvents: "none",
    });
    expect(screen.queryByTestId("preview-tab-drag-proxy")).not.toBeInTheDocument();
  });

  it("ignores the synthetic preview tab click that can follow a native drag end", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "预览 app.ts" }));

    const tabbar = screen.getByTestId("user-space-preview-tabbar");
    const readmeTab = screen.getByTestId("preview-tab-uw-mounted:README.md");
    const appTab = screen.getByTestId("preview-tab-uw-mounted:app.ts");
    const readmeSelectButton = within(tabbar).getByRole("button", { name: "切换预览 README.md" });

    expect(readmeTab).toHaveClass("bg-transparent");
    expect(appTab).toHaveClass("bg-accent");

    fireEvent.pointerDown(readmeTab, { button: 0, pointerId: 1, clientX: 120, clientY: 18 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 136, clientY: 18 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 136, clientY: 18 });
    readmeSelectButton.focus();
    fireEvent.mouseUp(readmeSelectButton);
    fireEvent.click(readmeSelectButton);

    expect(readmeTab).toHaveClass("bg-transparent");
    expect(appTab).toHaveClass("bg-accent");
    expect(document.activeElement).not.toBe(readmeSelectButton);
  });

  it("moves an earlier preview tab after a later drop target", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "预览 app.ts" }));

    const tabbar = screen.getByTestId("user-space-preview-tabbar");
    const readmeTab = screen.getByTestId("preview-tab-uw-mounted:README.md");
    const appTab = screen.getByTestId("preview-tab-uw-mounted:app.ts");
    mockElementRect(readmeTab, {
      x: 20,
      y: 4,
      width: 180,
      height: 32,
    });
    mockElementRect(appTab, {
      x: 200,
      y: 4,
      width: 180,
      height: 32,
    });

    mockElementFromPoint(appTab);
    dispatchElementPointerDown(readmeTab, { button: 0, pointerId: 1, clientX: 120, clientY: 18 });
    dispatchWindowPointerDragEvent("pointermove", { clientX: 180, clientY: 18 });
    expect(screen.queryByTestId("preview-tab-drop-indicator")).not.toBeInTheDocument();
    dispatchWindowPointerDragEvent("pointermove", { clientX: 199, clientY: 18 });
    expect(screen.queryByTestId("preview-tab-drop-indicator")).not.toBeInTheDocument();
    dispatchWindowPointerDragEvent("pointermove", { clientX: 200, clientY: 18 });
    expect(screen.getByTestId("preview-tab-drop-indicator")).toHaveAttribute(
      "data-drop-edge",
      "after",
    );
    expect(screen.getByTestId("preview-tab-drop-indicator")).toHaveClass("right-0");
    dispatchWindowPointerDragEvent("pointerup", { clientX: 200, clientY: 18 });

    expect(
      within(tabbar)
        .getAllByTestId(/^preview-tab-uw-mounted:/)
        .map((tab) => tab.getAttribute("data-testid")),
    ).toEqual(["preview-tab-uw-mounted:app.ts", "preview-tab-uw-mounted:README.md"]);
  });

  it("keeps the insertion indicator on one edge around an equivalent middle slot", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "预览 app.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "预览 index.html" }));

    const readmeTab = screen.getByTestId("preview-tab-uw-mounted:README.md");
    const appTab = screen.getByTestId("preview-tab-uw-mounted:app.ts");
    const indexTab = screen.getByTestId("preview-tab-uw-mounted:index.html");
    mockElementRect(readmeTab, { x: 20, y: 4, width: 180, height: 32 });
    mockElementRect(appTab, { x: 200, y: 4, width: 180, height: 32 });
    mockElementRect(indexTab, { x: 382, y: 4, width: 180, height: 32 });

    mockElementFromPoint(appTab);
    dispatchElementPointerDown(readmeTab, { button: 0, pointerId: 1, clientX: 120, clientY: 18 });
    dispatchWindowPointerDragEvent("pointermove", { clientX: 289, clientY: 18 });

    let indicator = screen.getByTestId("preview-tab-drop-indicator");
    expect(indicator).toHaveAttribute("data-drop-edge", "before");
    expect(indicator.parentElement).toBe(indexTab);

    mockElementFromPoint(indexTab);
    dispatchWindowPointerDragEvent("pointermove", { clientX: 293, clientY: 18 });

    indicator = screen.getByTestId("preview-tab-drop-indicator");
    expect(indicator).toHaveAttribute("data-drop-edge", "before");
    expect(indicator.parentElement).toBe(indexTab);
  });

  it("keeps file tree focus synchronized with active preview tabs", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeTreeButton = await screen.findByRole("button", { name: "预览 README.md" });
    const appTreeButton = screen.getByRole("button", { name: "预览 app.ts" });

    fireEvent.click(readmeTreeButton);
    expect(treeItemForButton(readmeTreeButton)).toHaveAttribute("aria-selected", "true");

    fireEvent.click(appTreeButton);
    expect(treeItemForButton(readmeTreeButton)).toHaveAttribute("aria-selected", "false");
    expect(treeItemForButton(appTreeButton)).toHaveAttribute("aria-selected", "true");

    fireEvent.click(await screen.findByRole("button", { name: "切换预览 README.md" }));

    expect(treeItemForButton(readmeTreeButton)).toHaveAttribute("aria-selected", "true");
    expect(treeItemForButton(appTreeButton)).toHaveAttribute("aria-selected", "false");

    fireEvent.click(screen.getByRole("button", { name: "关闭预览 README.md" }));

    expect(treeItemForButton(readmeTreeButton)).toHaveAttribute("aria-selected", "false");
    expect(treeItemForButton(appTreeButton)).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "关闭预览 app.ts" }));

    expect(treeItemForButton(appTreeButton)).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("user-space-preview-pane")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByLabelText("工作区文件边栏")).toHaveStyle({
      gridTemplateColumns: "minmax(0, 1fr) 0px",
    });

    fireEvent.click(screen.getByRole("button", { name: "展开文件预览" }));
    expect(screen.getByTestId("user-space-preview-pane")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "展开文件预览" })).toBeDisabled();
  });

  it("renders HTML in iframe preview mode without exposing a text view", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 index.html" }));

    const htmlPreviewFrame = await screen.findByTitle("HTML 预览 index.html");
    expect(htmlPreviewFrame).toHaveAttribute("src", "blob:http://localhost/workspace-preview");
    expect(screen.getByTestId("user-space-preview-toolbar-filename")).toHaveTextContent(
      "index.html",
    );
    expect(
      within(screen.getByTestId("user-space-preview-toolbar")).queryByRole("button", {
        name: "编辑",
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-space-preview-view-switch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("text-editor-uw-mounted:index.html")).not.toBeInTheDocument();
  });

  it("releases all preview object URLs when a preview tab closes", async () => {
    const createObjectURL = vi.mocked(globalThis.URL.createObjectURL);
    const revokeObjectURL = vi.mocked(globalThis.URL.revokeObjectURL);
    createObjectURL.mockImplementationOnce(() => "blob:http://localhost/html-preview");

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 index.html" }));
    expect(await screen.findByTitle("HTML 预览 index.html")).toHaveAttribute(
      "src",
      "blob:http://localhost/html-preview",
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭预览 index.html" }));

    expect(screen.queryByTitle("HTML 预览 index.html")).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/html-preview");
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:http://localhost/html-source");
    createObjectURL.mockReturnValue("blob:http://localhost/workspace-preview");
  });

  it("renders large text as plaintext in CodeMirror", async () => {
    const largeContent = `export const huge = "${"x".repeat(280 * 1024)}";`;
    mockExecuteUserSpaceOperation.mockResolvedValueOnce({
      entries: [
        {
          name: "huge.ts",
          path: "huge.ts",
          kind: "file" as const,
          size: largeContent.length,
          previewKind: "text" as const,
          supportsLineEdit: true,
        },
      ],
    });
    mockGetUserSpaceFile.mockImplementationOnce(() =>
      Promise.resolve(new File([largeContent], "huge.ts", { type: "text/typescript" })),
    );
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 huge.ts" }));

    const editor = await screen.findByTestId("text-editor-uw-mounted:huge.ts");
    const textArea = within(editor).getByTestId("codemirror-editor");
    expect(editor).toHaveAttribute("data-language-mode", "plaintext");
    expect(editor).toHaveClass("bg-background");
    expect(textArea).toHaveAttribute("data-extension-count", "3");
  });

  it("adds files to the composer reference queue from the file context menu", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const previewButton = await screen.findByRole("button", { name: "预览 README.md" });
    expect(screen.queryByRole("button", { name: "引用 README.md" })).not.toBeInTheDocument();

    fireEvent.contextMenu(previewButton, { clientX: 121, clientY: 233 });
    const addToSessionItem = await screen.findByRole("menuitem", { name: "添加到会话" });
    expect(screen.getByTestId("user-space-context-target-outline")).toHaveClass(
      "piwork-context-target-border",
      "bg-[var(--piwork-list-selected)]",
    );
    expect(screen.getByTestId("user-space-context-target-outline")).not.toHaveClass(
      "bg-primary/10",
    );
    expect(screen.getByTestId("user-space-context-target-outline").className).toContain(
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(screen.getByTestId("user-space-context-target-outline")).toHaveClass(
      "left-1",
      "right-1",
    );
    expect(addToSessionItem.className).toContain("rounded-[var(--piwork-control-radius)]");
    expect(addToSessionItem.className).toContain("hover:bg-accent");
    fireEvent.click(addToSessionItem);

    expect(getUserSpaceFileRefs("s1")).toEqual([
      expect.objectContaining({
        rootName: "Client Files",
        path: "README.md",
        name: "README.md",
      }),
    ]);
    expect(mockGetUserSpaceFile).not.toHaveBeenCalled();
  });

  it("opens an HTML file as text from the context menu", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const htmlButton = await screen.findByRole("button", { name: "预览 index.html" });
    fireEvent.contextMenu(htmlButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "通过文本打开" }));

    expect(await screen.findByTestId("text-editor-uw-mounted:index.html")).toBeInTheDocument();
    expect(screen.queryByTitle("HTML 预览 index.html")).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole("button", { name: "预览 README.md" }));
    expect(screen.queryByRole("menuitem", { name: "通过文本打开" })).not.toBeInTheDocument();
  });

  it("localizes the HTML text-open context action in English", async () => {
    setUiCopyLanguage("en-US");
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "Preview index.html" }));
    expect(await screen.findByRole("menuitem", { name: "Open as text" })).toBeInTheDocument();
  });

  it("groups open actions and opens every selected file in the preview panel", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    const appButton = await screen.findByRole("button", { name: "预览 app.ts" });
    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.click(appButton, { metaKey: true });
    fireEvent.contextMenu(appButton);

    const openMenuItem = await screen.findByRole("menuitem", { name: "打开" });
    const openInNewWindowMenuItem = screen.getByRole("menuitem", { name: "在新窗口打开" });
    expect(openMenuItem.querySelector(".lucide-file")).toBeInTheDocument();
    expect(openInNewWindowMenuItem.querySelector(".lucide-external-link")).toBeInTheDocument();
    expect(openMenuItem.nextElementSibling).toBe(openInNewWindowMenuItem);

    fireEvent.click(openMenuItem);

    expect(await screen.findByRole("button", { name: "切换预览 README.md" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "切换预览 app.ts" })).toBeInTheDocument();
  });

  it("opens and pins every selected user-space file from the context menu", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    const appButton = screen.getByRole("button", { name: "预览 app.ts" });
    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.click(appButton, { metaKey: true });
    fireEvent.contextMenu(appButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "打开并固定" }));

    const pinnedGroup = await screen.findByTestId("preview-pinned-tab-group");
    expect(screen.getByTestId("preview-pinned-tab-group-toggle")).toHaveTextContent("2");
    fireEvent.pointerEnter(pinnedGroup);
    expect(screen.getByTestId("preview-tab-uw-mounted:README.md")).toBeInTheDocument();
    expect(screen.getByTestId("preview-tab-uw-mounted:app.ts")).toBeInTheDocument();
  });

  it("localizes the open-and-pin context action in English", async () => {
    setUiCopyLanguage("en-US");
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "Preview README.md" }));

    expect(await screen.findByRole("menuitem", { name: "Open and pin" })).toBeInTheDocument();
  });

  it("outlines every discontinuous selected region while its context menu is open", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    const appButton = screen.getByRole("button", { name: "预览 app.ts" });
    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.click(appButton, { metaKey: true });
    fireEvent.contextMenu(appButton);

    const readmeRow = screen.getByTestId("user-space-entry-row-uw-mounted:README.md");
    const appRow = screen.getByTestId("user-space-entry-row-uw-mounted:app.ts");
    expect(readmeRow).toHaveAttribute("data-selection-segment", "single");
    expect(appRow).toHaveAttribute("data-selection-segment", "single");
    expect(appRow).toHaveAttribute("data-state", "open");
    expect(readmeRow.firstElementChild).toHaveClass("piwork-selection-surface");
    expect(appRow.firstElementChild).toHaveClass("piwork-selection-surface");
    expect(screen.queryByTestId("user-space-context-target-outline")).not.toBeInTheDocument();
  });

  it("opens all selected files at once when the site can create multiple popups", async () => {
    setUiCopyLanguage("en-US");
    const readmePopout = createMockDetachedPreviewWindow();
    const appPopout = createMockDetachedPreviewWindow();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValueOnce(readmePopout.popoutWindow)
      .mockReturnValueOnce(appPopout.popoutWindow);
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />);

    const readmeButton = await screen.findByRole("button", { name: "Preview README.md" });
    const appButton = await screen.findByRole("button", { name: "Preview app.ts" });
    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.click(appButton, { metaKey: true });
    fireEvent.contextMenu(appButton);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in new window" }));

    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("dialog", { name: "Allow multiple separate windows" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("user-space-preview-pane")).toHaveAttribute("aria-hidden", "true");
    await waitFor(() =>
      expect(
        readmePopout.popoutDocument.querySelector(
          "[data-testid='markdown-editor-uw-mounted:README.md']",
        ),
      ).not.toBeNull(),
    );

    await waitFor(() =>
      expect(
        appPopout.popoutDocument.querySelector("[data-testid='text-editor-uw-mounted:app.ts']"),
      ).not.toBeNull(),
    );
    expect(readmePopout.popoutWindow.close).not.toHaveBeenCalled();
    expect(appPopout.popoutWindow.close).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("guides popup permission and retries only windows Chrome blocked", async () => {
    setUiCopyLanguage("en-US");
    const readmePopout = createMockDetachedPreviewWindow();
    const appPopout = createMockDetachedPreviewWindow();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValueOnce(readmePopout.popoutWindow)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(appPopout.popoutWindow);
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />);

    const readmeButton = await screen.findByRole("button", { name: "Preview README.md" });
    const appButton = screen.getByRole("button", { name: "Preview app.ts" });
    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.click(appButton, { metaKey: true });
    fireEvent.contextMenu(appButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in new window" }));

    expect(openSpy).toHaveBeenCalledTimes(2);
    const permissionDialog = await screen.findByRole("dialog", {
      name: "Allow multiple separate windows",
    });
    expect(permissionDialog).toHaveTextContent("Chrome blocked 1 separate window.");
    fireEvent.click(within(permissionDialog).getByRole("button", { name: "Retry opening" }));

    expect(openSpy).toHaveBeenCalledTimes(3);
    expect(
      screen.queryByRole("dialog", { name: "Allow multiple separate windows" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        appPopout.popoutDocument.querySelector("[data-testid='text-editor-uw-mounted:app.ts']"),
      ).not.toBeNull(),
    );
    expect(readmePopout.popoutWindow.close).not.toHaveBeenCalled();
    expect(appPopout.popoutWindow.close).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("localizes the blocked-popup permission guide in Chinese", async () => {
    const popout = createMockDetachedPreviewWindow();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValueOnce(popout.popoutWindow)
      .mockReturnValueOnce(null);
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    const appButton = screen.getByRole("button", { name: "预览 app.ts" });
    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.click(appButton, { metaKey: true });
    fireEvent.contextMenu(appButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "在新窗口打开" }));

    const permissionDialog = await screen.findByRole("dialog", {
      name: "允许打开多个独立窗口",
    });
    expect(permissionDialog).toHaveTextContent(
      "Chrome 阻止了 1 个独立窗口。请在地址栏的弹出式窗口提示中选择始终允许此网站，然后重试。",
    );
    fireEvent.click(within(permissionDialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "允许打开多个独立窗口" })).not.toBeInTheDocument();
    openSpy.mockRestore();
  });

  it("opens a single selected file in a new window without expanding the preview panel", async () => {
    setUiCopyLanguage("en-US");
    const popout = createMockDetachedPreviewWindow();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popout.popoutWindow);
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "Preview app.ts" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in new window" }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("user-space-preview-pane")).toHaveAttribute("aria-hidden", "true");
    await waitFor(() =>
      expect(
        popout.popoutDocument.querySelector("[data-testid='text-editor-uw-mounted:app.ts']"),
      ).not.toBeNull(),
    );

    const returnButton = popout.popoutDocument.querySelector(
      "button[aria-label='Return to tab group']",
    ) as HTMLButtonElement;
    expect(returnButton).not.toBeNull();
    act(() => {
      returnButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await waitFor(() =>
      expect(screen.getByTestId("user-space-preview-pane")).not.toHaveAttribute(
        "aria-hidden",
        "true",
      ),
    );
    expect(screen.getByRole("button", { name: "Switch preview app.ts" })).toBeInTheDocument();
    expect(popout.popoutWindow.close).toHaveBeenCalledTimes(1);
    openSpy.mockRestore();
  });

  it("opens details for a single user-space file from the context menu", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "详情" }));

    const dialog = await screen.findByRole("dialog", { name: "详情" });
    expect(dialog).toHaveClass("sm:max-w-[480px]", "bg-card", "text-foreground");
    expect(dialog).not.toHaveClass("bg-card/80", "bg-background/80", "backdrop-blur");
    expect(within(dialog).getByText("名称")).toBeInTheDocument();
    expect(within(dialog).getByText("路径")).toBeInTheDocument();
    expect(within(dialog).getByText("类型")).toBeInTheDocument();
    expect(within(dialog).getByText("大小")).toBeInTheDocument();
    expect(within(dialog).getByText("修改时间")).toBeInTheDocument();
    expect(within(dialog).getAllByText("README.md")).toHaveLength(1);
    expect(within(dialog).getByText("Client Files")).toBeInTheDocument();
    expect(within(dialog).getByText("Markdown文稿")).toBeInTheDocument();
    expect(within(dialog).getByText("14 B")).toBeInTheDocument();
    expect(within(dialog).getByText("未知")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("button")).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "关闭" })).toHaveClass(
      "rounded-[var(--piwork-control-radius)]",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "详情" })).not.toBeInTheDocument(),
    );
    fireEvent.contextMenu(await screen.findByRole("button", { name: "预览 report.docx" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "详情" }));

    const officeDialog = await screen.findByRole("dialog", { name: "详情" });
    expect(within(officeDialog).getByText("Office Open XML字处理文稿")).toBeInTheDocument();
    expect(within(officeDialog).queryByText("DOCX 文件")).not.toBeInTheDocument();
  });

  it("opens details for all selected user-space entries from the context menu", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    const appButton = await screen.findByRole("button", { name: "预览 app.ts" });
    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.click(appButton, { metaKey: true });

    fireEvent.contextMenu(appButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "详情" }));

    const dialog = await screen.findByRole("dialog", { name: "详情" });
    expect(within(dialog).getByText("文件总数量")).toBeInTheDocument();
    expect(within(dialog).getByText("不同文件类型数量")).toBeInTheDocument();
    expect(within(dialog).getByText("总计大小")).toBeInTheDocument();
    expect(within(dialog).getByText("2")).toBeInTheDocument();
    expect(within(dialog).getByText("Markdown文稿 1")).toBeInTheDocument();
    expect(within(dialog).getByText("文件 1")).toBeInTheDocument();
    expect(within(dialog).getByText("40 B")).toBeInTheDocument();
    expect(within(dialog).queryByText("app.ts")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("README.md")).not.toBeInTheDocument();
  });

  it("opens aggregate details for a user-space folder from the context menu", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "展开 docs" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "详情" }));

    const dialog = await screen.findByRole("dialog", { name: "详情" });
    expect(within(dialog).getByText("文件总数量")).toBeInTheDocument();
    expect(within(dialog).getByText("1")).toBeInTheDocument();
    expect(within(dialog).getByText("纯文本文稿 1")).toBeInTheDocument();
    expect(within(dialog).getByText("9 B")).toBeInTheDocument();
  });

  it("adds all selected user-space files to the composer reference queue", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    const appButton = await screen.findByRole("button", { name: "预览 app.ts" });

    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.click(appButton, { metaKey: true });
    fireEvent.contextMenu(appButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "添加到会话" }));

    expect(getUserSpaceFileRefs("s1")).toEqual([
      expect.objectContaining({
        rootName: "Client Files",
        path: "README.md",
        name: "README.md",
      }),
      expect.objectContaining({
        rootName: "Client Files",
        path: "app.ts",
        name: "app.ts",
      }),
    ]);
    expect(mockGetUserSpaceFile).not.toHaveBeenCalled();
  });

  it("moves a single user-space file into a directory by drag and drop", async () => {
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "move_entries") {
        return Promise.resolve({
          ok: true,
          moves: [
            {
              sourcePath: "README.md",
              path: "docs/README.md",
              kind: "file",
            },
          ],
        });
      }
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [{ name: "notes.txt", path: "docs/notes.txt", kind: "file", size: 9 }],
        });
      }
      return Promise.resolve({ entries: rootEntries });
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const sourceRow = await screen.findByTestId("user-space-entry-row-uw-mounted:README.md");
    const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
    const dataTransfer = createMockDataTransfer();

    fireEvent.dragStart(sourceRow, { dataTransfer });
    expect(sourceRow).toHaveAttribute("data-dragging", "true");
    fireEvent.dragOver(targetRow, { dataTransfer });
    expect(targetRow).toHaveAttribute("data-drop-target", "true");
    fireEvent.drop(targetRow, { dataTransfer });

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("move_entries", {
        mountId: "uw-mounted",
        paths: ["README.md"],
        targetDirPath: "docs",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("已将 1 个项目移动到“docs”。");
  });

  it("uses an immediate localized drag proxy without the native return animation", async () => {
    const view = render(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="zh-CN" />,
    );

    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    const indexButton = screen.getByRole("button", { name: "预览 index.html" });
    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.click(indexButton, { metaKey: true });

    const chineseTransfer = createMockDataTransfer();
    const chineseGrabbedRow = screen.getByTestId("user-space-entry-row-uw-mounted:index.html");
    fireEvent.dragStart(chineseGrabbedRow, {
      clientX: 120,
      clientY: 80,
      dataTransfer: chineseTransfer,
    });
    expect(chineseTransfer.setDragImage).toHaveBeenCalledTimes(1);
    const chineseDragImage = vi.mocked(chineseTransfer.setDragImage).mock.calls[0]?.[0];
    expect(chineseDragImage).toHaveClass("opacity-0");
    expect(chineseDragImage).toBeInTheDocument();
    const chineseDragProxy = screen.getByTestId("workspace-drag-proxy");
    expect(chineseDragProxy).toHaveTextContent("2 个项目");
    expect(chineseDragProxy).toHaveClass("transition-none", "z-[var(--piwork-z-drag)]");
    expect(chineseDragProxy.parentElement).toBe(document.body);
    expect(chineseGrabbedRow).toHaveAttribute("data-dragging", "true");
    fireEvent.mouseUp(window);
    expect(screen.queryByTestId("workspace-drag-proxy")).not.toBeInTheDocument();
    expect(chineseGrabbedRow).not.toHaveAttribute("data-dragging");
    expect(chineseDragImage).toBeInTheDocument();
    fireEvent.dragEnd(chineseGrabbedRow, { dataTransfer: chineseTransfer });
    expect(chineseDragImage).not.toBeInTheDocument();

    setUiCopyLanguage("en-US");
    view.rerender(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />,
    );
    const englishTransfer = createMockDataTransfer();
    const englishGrabbedRow = await screen.findByTestId(
      "user-space-entry-row-uw-mounted:index.html",
    );
    fireEvent.dragStart(englishGrabbedRow, { dataTransfer: englishTransfer });
    expect(englishTransfer.setDragImage).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("workspace-drag-proxy")).toHaveTextContent("2 items");
    fireEvent.dragEnd(englishGrabbedRow, { dataTransfer: englishTransfer });
  });

  it("keeps embedded previews transparent while a workspace file is dragged globally", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const grabbedRow = await screen.findByTestId("user-space-entry-row-uw-mounted:README.md");
    const dataTransfer = createMockDataTransfer();

    fireEvent.dragStart(grabbedRow, { dataTransfer });
    expect(document.documentElement).toHaveAttribute("data-piwork-workspace-dragging", "true");

    fireEvent.dragEnd(grabbedRow, { dataTransfer });
    expect(document.documentElement).not.toHaveAttribute("data-piwork-workspace-dragging");
  });

  it("drags only the grabbed user-space row when it is outside the current selection", async () => {
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "move_entries") {
        return Promise.resolve({
          ok: true,
          moves: [{ sourcePath: "app.ts", path: "docs/app.ts", kind: "file" }],
        });
      }
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [
            { name: "app.ts", path: "docs/app.ts", kind: "file", size: 26 },
            { name: "notes.txt", path: "docs/notes.txt", kind: "file", size: 9 },
          ],
        });
      }
      return Promise.resolve({ entries: rootEntries });
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    const indexButton = screen.getByRole("button", { name: "预览 index.html" });
    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.click(indexButton, { metaKey: true });

    const dataTransfer = createMockDataTransfer();
    const grabbedRow = screen.getByTestId("user-space-entry-row-uw-mounted:app.ts");
    fireEvent.dragStart(grabbedRow, { dataTransfer });

    expect(JSON.parse(dataTransfer.getData(WORKSPACE_INTERNAL_DRAG_TYPE))).toMatchObject({
      space: "user",
      mountId: "uw-mounted",
      paths: ["app.ts"],
    });
    expect(grabbedRow).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("user-space-entry-row-uw-mounted:README.md")).not.toHaveAttribute(
      "data-selected",
    );
    expect(screen.getByTestId("user-space-entry-row-uw-mounted:index.html")).not.toHaveAttribute(
      "data-selected",
    );

    const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("move_entries", {
        mountId: "uw-mounted",
        paths: ["app.ts"],
        targetDirPath: "docs",
      }),
    );
  });

  it("loads through a paginated destination and reveals the moved user-space file", async () => {
    const firstDestinationPage = Array.from({ length: 80 }, (_, index) => ({
      name: `existing-${String(index).padStart(3, "0")}.txt`,
      path: `docs/existing-${String(index).padStart(3, "0")}.txt`,
      kind: "file" as const,
      size: index,
    }));
    mockExecuteUserSpaceOperation.mockImplementation(
      (operation, input: { path?: string; cursor?: string }) => {
        if (operation === "move_entries") {
          return Promise.resolve({
            ok: true,
            moves: [
              {
                sourcePath: "README.md",
                path: "docs/README.md",
                kind: "file",
              },
            ],
          });
        }
        if (input.path === "docs") {
          return input.cursor === "80"
            ? Promise.resolve({
                entries: [{ name: "README.md", path: "docs/README.md", kind: "file", size: 14 }],
              })
            : Promise.resolve({ entries: firstDestinationPage, nextCursor: "80" });
        }
        return Promise.resolve({ entries: rootEntries });
      },
    );
    const originalOffsetHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        const element = this as HTMLElement;
        if (element.dataset.testid === "user-space-tree-pane") return 640;
        return Number.parseFloat(element.style.height) || 0;
      },
    });
    try {
      render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

      const sourceRow = await screen.findByTestId("user-space-entry-row-uw-mounted:README.md");
      const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
      const treePane = screen.getByTestId("user-space-tree-pane");
      Object.defineProperties(treePane, {
        clientHeight: { configurable: true, value: 640 },
        scrollHeight: { configurable: true, value: 4_000 },
      });
      const scrollTo = vi.fn((options: ScrollToOptions) => {
        treePane.scrollTop = options.top || 0;
        fireEvent.scroll(treePane);
      });
      Object.defineProperty(treePane, "scrollTo", { configurable: true, value: scrollTo });
      const dataTransfer = createMockDataTransfer();
      fireEvent.dragStart(sourceRow, { dataTransfer });
      fireEvent.dragOver(targetRow, { dataTransfer });
      fireEvent.drop(targetRow, { dataTransfer });

      await waitFor(() =>
        expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
          "list_dir",
          expect.objectContaining({ path: "docs", cursor: "80" }),
        ),
      );
      await waitFor(() => expect(scrollTo).toHaveBeenCalled());
      await waitFor(() => expect(treePane.scrollTop).toBeGreaterThan(0));
      const movedRow = await screen.findByTestId("user-space-entry-row-uw-mounted:docs/README.md");
      expect(movedRow).toHaveAttribute("data-focused", "true");
      await waitFor(() => expect(within(movedRow).getByRole("button")).toHaveFocus());
    } finally {
      if (originalOffsetHeight) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
      } else {
        delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
      }
    }
  });

  it("refreshes the source and destination directories after a failed user-space move", async () => {
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "move_entries") {
        return Promise.reject(new Error("目标位置已有同名项目。"));
      }
      if (input.path === "docs") return Promise.resolve({ entries: [] });
      return Promise.resolve({ entries: rootEntries });
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const sourceRow = await screen.findByTestId("user-space-entry-row-uw-mounted:README.md");
    const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
    mockExecuteUserSpaceOperation.mockClear();
    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(sourceRow, { dataTransfer });
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });

    expect(await screen.findByRole("alert")).toHaveTextContent("目标位置已有同名项目。");
    await waitFor(() => {
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "list_dir",
        expect.objectContaining({ mountId: "uw-mounted", path: "" }),
      );
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "list_dir",
        expect.objectContaining({ mountId: "uw-mounted", path: "docs" }),
      );
    });
  });

  it("keeps a loading preview tab and restarts it from the relocated user-space path", async () => {
    const originalFile = deferred<File>();
    const relocatedFile = deferred<File>();
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) => {
      if (path === "app.ts") return originalFile.promise;
      if (path === "docs/app.ts") return relocatedFile.promise;
      return defaultMockGetUserSpaceFile(_mountId, path);
    });
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "move_entries") {
        return Promise.resolve({
          ok: true,
          moves: [{ sourcePath: "app.ts", path: "docs/app.ts", kind: "file" }],
        });
      }
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [
            { name: "app.ts", path: "docs/app.ts", kind: "file", size: 31 },
            { name: "notes.txt", path: "docs/notes.txt", kind: "file", size: 9 },
          ],
        });
      }
      return Promise.resolve({ entries: rootEntries });
    });
    const createObjectURL = vi.mocked(globalThis.URL.createObjectURL);
    const revokeObjectURL = vi.mocked(globalThis.URL.revokeObjectURL);
    createObjectURL
      .mockReturnValueOnce("blob:http://localhost/relocated-preview")
      .mockReturnValueOnce("blob:http://localhost/stale-preview");

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 app.ts" }));
    const stableTabId = "preview-tab-uw-mounted:app.ts";
    expect(await screen.findByTestId(stableTabId)).toBeInTheDocument();
    expect(
      within(screen.getByTestId("preview-body-uw-mounted:app.ts")).getByTestId(
        "preview-loading-state",
      ),
    ).toBeInTheDocument();

    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(screen.getByTestId("user-space-entry-row-uw-mounted:app.ts"), {
      dataTransfer,
    });
    const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });

    await waitFor(() =>
      expect(mockGetUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "docs/app.ts"),
    );
    expect(screen.getByTestId(stableTabId)).toBeInTheDocument();
    expect(screen.queryByTestId("preview-tab-uw-mounted:docs/app.ts")).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("preview-body-uw-mounted:app.ts")).getByTestId(
        "preview-loading-state",
      ),
    ).toBeInTheDocument();

    await act(async () => {
      relocatedFile.resolve(
        new File(["export const relocated = true;"], "app.ts", { type: "text/typescript" }),
      );
      await relocatedFile.promise;
    });

    const editor = await screen.findByTestId("text-editor-uw-mounted:app.ts");
    expect((within(editor).getByTestId("codemirror-editor") as HTMLTextAreaElement).value).toBe(
      "export const relocated = true;",
    );

    await act(async () => {
      originalFile.resolve(
        new File(["export const stale = true;"], "app.ts", { type: "text/typescript" }),
      );
      await originalFile.promise;
    });

    await waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/stale-preview"),
    );
    expect((within(editor).getByTestId("codemirror-editor") as HTMLTextAreaElement).value).toBe(
      "export const relocated = true;",
    );
    await waitFor(() => {
      const ownerKey = JSON.stringify(["", "", "", "s1"]);
      const persisted = window.sessionStorage.getItem(previewSessionStorageKey(ownerKey));
      expect(persisted).not.toBeNull();
      expect(JSON.parse(persisted || "null")).toMatchObject({
        activeTabId: "uw-mounted:docs/app.ts",
        tabs: [
          {
            id: "uw-mounted:docs/app.ts",
            mountId: "uw-mounted",
            path: "docs/app.ts",
          },
        ],
      });
    });
  });

  it("re-evaluates the copy modifier on drop instead of using the last drag-over state", async () => {
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "copy_entries") {
        return Promise.resolve({
          ok: true,
          moves: [
            {
              sourcePath: "README.md",
              path: "docs/README.md",
              kind: "file",
            },
          ],
        });
      }
      if (input.path === "docs") return Promise.resolve({ entries: [] });
      return Promise.resolve({ entries: rootEntries });
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const sourceRow = await screen.findByTestId("user-space-entry-row-uw-mounted:README.md");
    const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(sourceRow, { dataTransfer });
    fireEvent.dragOver(targetRow, { dataTransfer });
    const dropEvent = new MouseEvent("drop", {
      bubbles: true,
      cancelable: true,
      altKey: true,
      ctrlKey: true,
    });
    Object.defineProperty(dropEvent, "dataTransfer", { value: dataTransfer });
    fireEvent(targetRow, dropEvent);

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("copy_entries", {
        mountId: "uw-mounted",
        paths: ["README.md"],
        targetDirPath: "docs",
      }),
    );
    expect(mockExecuteUserSpaceOperation).not.toHaveBeenCalledWith(
      "move_entries",
      expect.anything(),
    );
  });

  it("announces English processing and copy-success status messages", async () => {
    const pendingCopy = deferred<{
      ok: true;
      moves: Array<{ sourcePath: string; path: string; kind: "file" }>;
    }>();
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "copy_entries") return pendingCopy.promise;
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [
            { name: "README.md", path: "docs/README.md", kind: "file", size: 14 },
            { name: "notes.txt", path: "docs/notes.txt", kind: "file", size: 9 },
          ],
        });
      }
      return Promise.resolve({ entries: rootEntries });
    });
    setUiCopyLanguage("en-US");
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />);

    const sourceRow = await screen.findByTestId("user-space-entry-row-uw-mounted:README.md");
    const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(sourceRow, { dataTransfer });
    const dragOverEvent = new MouseEvent("dragover", {
      bubbles: true,
      cancelable: true,
      altKey: true,
      ctrlKey: true,
    });
    Object.defineProperty(dragOverEvent, "dataTransfer", { value: dataTransfer });
    fireEvent(targetRow, dragOverEvent);
    const dropEvent = new MouseEvent("drop", {
      bubbles: true,
      cancelable: true,
      altKey: true,
      ctrlKey: true,
    });
    Object.defineProperty(dropEvent, "dataTransfer", { value: dataTransfer });
    fireEvent(targetRow, dropEvent);

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("copy_entries", {
        mountId: "uw-mounted",
        paths: ["README.md"],
        targetDirPath: "docs",
      }),
    );
    expect(screen.getByTestId("user-space-tree-pane")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Processing files…");

    await act(async () => {
      pendingCopy.resolve({
        ok: true,
        moves: [{ sourcePath: "README.md", path: "docs/README.md", kind: "file" }],
      });
      await pendingCopy.promise;
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Copied 1 item to “docs”.");
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("disables every User-space paste affordance while a move is pending", async () => {
    const pendingMove = deferred<{
      ok: true;
      moves: Array<{ sourcePath: string; path: string; kind: "file" }>;
    }>();
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "move_entries") return pendingMove.promise;
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [
            { name: "app.ts", path: "docs/app.ts", kind: "file", size: 26 },
            { name: "notes.txt", path: "docs/notes.txt", kind: "file", size: 9 },
          ],
        });
      }
      return Promise.resolve({ entries: rootEntries });
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制" }));

    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(screen.getByTestId("user-space-entry-row-uw-mounted:app.ts"), {
      dataTransfer,
    });
    const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("move_entries", {
        mountId: "uw-mounted",
        paths: ["app.ts"],
        targetDirPath: "docs",
      }),
    );

    expect(screen.getByRole("button", { name: "粘贴到Client Files根目录" })).toBeDisabled();
    fireEvent.contextMenu(targetRow);
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "粘贴到此处" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    fireEvent.contextMenu(screen.getByTestId("user-space-tree-blank-area"));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "粘贴到此处" })).not.toBeInTheDocument();

    await act(async () => {
      pendingMove.resolve({
        ok: true,
        moves: [{ sourcePath: "app.ts", path: "docs/app.ts", kind: "file" }],
      });
      await pendingMove.promise;
    });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("moves the complete user-space selection and keeps the grabbed entry focused", async () => {
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "move_entries") {
        return Promise.resolve({
          ok: true,
          moves: [
            { sourcePath: "README.md", path: "docs/README.md", kind: "file" },
            { sourcePath: "index.html", path: "docs/index.html", kind: "file" },
          ],
        });
      }
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [
            { name: "README.md", path: "docs/README.md", kind: "file", size: 14 },
            { name: "index.html", path: "docs/index.html", kind: "file", size: 42 },
            { name: "notes.txt", path: "docs/notes.txt", kind: "file", size: 9 },
          ],
        });
      }
      return Promise.resolve({ entries: rootEntries });
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    const indexButton = screen.getByRole("button", { name: "预览 index.html" });
    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.click(indexButton, { metaKey: true });

    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(screen.getByTestId("user-space-entry-row-uw-mounted:index.html"), {
      dataTransfer,
    });
    const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });

    await waitFor(() => {
      const moveCall = mockExecuteUserSpaceOperation.mock.calls.find(
        ([operation]) => operation === "move_entries",
      );
      expect(moveCall?.[1]).toMatchObject({
        mountId: "uw-mounted",
        targetDirPath: "docs",
      });
      expect(moveCall?.[1].paths).toEqual(expect.arrayContaining(["README.md", "index.html"]));
      expect(moveCall?.[1].paths).toHaveLength(2);
    });
    await waitFor(() =>
      expect(screen.getByTestId("user-space-entry-row-uw-mounted:docs/index.html")).toHaveAttribute(
        "data-focused",
        "true",
      ),
    );
    expect(
      screen.getByTestId("user-space-entry-row-uw-mounted:docs/README.md"),
    ).not.toHaveAttribute("data-focused", "true");
  });

  it("does not submit a user-space move when dropping into the current directory", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const sourceRow = await screen.findByTestId("user-space-entry-row-uw-mounted:README.md");
    const rootDropSurface = screen.getByTestId("user-space-tree-blank-area");
    const dataTransfer = createMockDataTransfer();

    fireEvent.dragStart(sourceRow, { dataTransfer });
    fireEvent.dragOver(rootDropSurface, { dataTransfer });
    expect(rootDropSurface).not.toHaveAttribute("data-drop-target");
    fireEvent.drop(rootDropSurface, { dataTransfer });

    expect(mockExecuteUserSpaceOperation).not.toHaveBeenCalledWith(
      "move_entries",
      expect.anything(),
    );
  });

  it("allows a last-moment copy modifier when the same-parent dragover was invalid", async () => {
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "copy_entries") {
        return Promise.resolve({
          ok: true,
          moves: [{ sourcePath: "README.md", path: "README copy.md", kind: "file" }],
        });
      }
      return Promise.resolve({ entries: input.path ? [] : rootEntries });
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const sourceRow = await screen.findByTestId("user-space-entry-row-uw-mounted:README.md");
    const rootDropSurface = screen.getByTestId("user-space-tree-blank-area");
    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(sourceRow, { dataTransfer });

    const dragOverEvent = new MouseEvent("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(dragOverEvent, "dataTransfer", { value: dataTransfer });
    expect(fireEvent(rootDropSurface, dragOverEvent)).toBe(false);

    const dropEvent = new MouseEvent("drop", {
      bubbles: true,
      cancelable: true,
      altKey: true,
      ctrlKey: true,
    });
    Object.defineProperty(dropEvent, "dataTransfer", { value: dataTransfer });
    fireEvent(rootDropSurface, dropEvent);

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("copy_entries", {
        mountId: "uw-mounted",
        paths: ["README.md"],
        targetDirPath: "",
      }),
    );
  });

  it("ignores a completed move from the mount that is no longer active", async () => {
    const opsWorkspace = {
      mountId: "uw-ops",
      name: "Ops Files",
      rootName: "Ops Files",
      status: "mounted" as const,
      access: "readwrite" as const,
      includeHidden: true as const,
    };
    mockSnapshot = {
      supported: true,
      mounts: [mountedWorkspace, opsWorkspace],
      indexing: {},
      recentOperations: [],
      recentFileChanges: [],
    };
    const pendingMove = deferred<{
      ok: true;
      moves: Array<{ sourcePath: string; path: string; kind: "file" }>;
    }>();
    mockExecuteUserSpaceOperation.mockImplementation(
      (operation, input: { mountId?: string; path?: string }) => {
        if (operation === "move_entries") return pendingMove.promise;
        if (input.mountId === "uw-ops") {
          return Promise.resolve({
            entries: [{ name: "ops.txt", path: "ops.txt", kind: "file", size: 3 }],
          });
        }
        if (input.path === "docs") return Promise.resolve({ entries: [] });
        return Promise.resolve({ entries: rootEntries });
      },
    );
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace, opsWorkspace]} />);

    const dataTransfer = createMockDataTransfer();
    fireEvent.dragStart(await screen.findByTestId("user-space-entry-row-uw-mounted:README.md"), {
      dataTransfer,
    });
    const targetRow = screen.getByTestId("user-space-entry-row-uw-mounted:docs");
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("move_entries", {
        mountId: "uw-mounted",
        paths: ["README.md"],
        targetDirPath: "docs",
      }),
    );
    const treePanel = screen.getByTestId("user-space-tree-panel");
    const treePane = screen.getByTestId("user-space-tree-pane");
    const moveStatus = screen.getByRole("status");
    expect(treePanel).not.toHaveAttribute("aria-busy");
    expect(treePane).toHaveAttribute("aria-busy", "true");
    expect(moveStatus).toHaveTextContent("正在处理文件…");
    expect(treePane).not.toContainElement(moveStatus);
    fireEvent.click(screen.getByTestId("user-space-mount-switcher-button"));
    fireEvent.click(
      within(screen.getByTestId("user-space-mount-option-uw-ops")).getByRole("button", {
        name: "切换到 Ops Files",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("ops.txt")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());

    await act(async () => {
      pendingMove.resolve({
        ok: true,
        moves: [{ sourcePath: "README.md", path: "docs/README.md", kind: "file" }],
      });
      await pendingMove.promise;
    });

    await waitFor(() =>
      expect(screen.getByTestId("user-space-current-mount")).toHaveTextContent("Ops Files"),
    );
    expect(screen.getByTestId("user-space-tree-pane")).not.toHaveAttribute("aria-busy");
    expect(screen.queryByTestId("workspace-move-status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("user-space-entry-row-uw-mounted:docs/README.md"),
    ).not.toBeInTheDocument();
  });

  it("moves a cut file on paste and localizes the non-drag fallback in Chinese and English", async () => {
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "move_entries") {
        return Promise.resolve({
          ok: true,
          moves: [
            {
              sourcePath: "README.md",
              path: "docs/README.md",
              kind: "file",
            },
          ],
        });
      }
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [{ name: "notes.txt", path: "docs/notes.txt", kind: "file", size: 9 }],
        });
      }
      return Promise.resolve({ entries: rootEntries });
    });
    const view = render(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="zh-CN" />,
    );

    fireEvent.contextMenu(await screen.findByRole("button", { name: "预览 README.md" }));
    const cutItem = await screen.findByRole("menuitem", { name: "剪切" });
    expect(cutItem).toBeVisible();
    fireEvent.click(cutItem);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "展开 docs" }));
    const pasteItem = await screen.findByRole("menuitem", { name: "粘贴到此处" });
    expect(pasteItem).toBeVisible();
    fireEvent.click(pasteItem);

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("move_entries", {
        mountId: "uw-mounted",
        paths: ["README.md"],
        targetDirPath: "docs",
      }),
    );

    setUiCopyLanguage("en-US");
    view.rerender(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />,
    );
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Preview index.html" }));
    const englishCutItem = await screen.findByRole("menuitem", { name: "Cut" });
    expect(englishCutItem).toBeVisible();
    fireEvent.click(englishCutItem);
    fireEvent.contextMenu(screen.getByTestId("user-space-entry-row-uw-mounted:docs"));
    expect(await screen.findByRole("menuitem", { name: "Paste here" })).toBeVisible();
  });

  it("politely announces a multi-item User Space cut and Escape cancellation in Chinese", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="zh-CN" />);

    const docsButton = await screen.findByRole("button", { name: "展开 docs" });
    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    fireEvent.click(docsButton, { metaKey: true });
    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.contextMenu(readmeButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "剪切" }));

    const announcement = screen.getByTestId("workspace-clipboard-announcement");
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(announcement).toHaveAttribute("aria-atomic", "true");
    expect(announcement).toHaveTextContent("已在用户空间剪切 2 个项目。");

    fireEvent.keyDown(readmeButton, { key: "Escape" });
    expect(announcement).toHaveTextContent("已取消剪切。");
  });

  it("politely announces a keyboard multi-item Agent Space cut and cancellation in English", async () => {
    setUiCopyLanguage("en-US");
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [
        { name: "a.txt", path: "a.txt", type: "file" as const, size: 1 },
        { name: "b.txt", path: "b.txt", type: "file" as const, size: 2 },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent space" }));
    const agentTree = await screen.findByTestId("agent-space-tree");
    const firstFile = within(agentTree).getByRole("button", { name: "Preview a.txt" });
    const secondFile = within(agentTree).getByRole("button", { name: "Preview b.txt" });
    fireEvent.click(firstFile, { ctrlKey: true });
    fireEvent.click(secondFile, { ctrlKey: true });
    secondFile.focus();
    fireEvent.keyDown(secondFile, { key: "x", ctrlKey: true });

    const announcement = screen.getByTestId("workspace-clipboard-announcement");
    expect(announcement).toHaveTextContent("Cut 2 items in Agent space.");

    fireEvent.keyDown(secondFile, { key: "Escape" });
    expect(announcement).toHaveTextContent("Cut cancelled.");
  });

  it("lets keyboard users paste a nested cut file into the User Space root", async () => {
    mockExecuteUserSpaceOperation.mockImplementation((operation, input: { path?: string }) => {
      if (operation === "move_entries") {
        return Promise.resolve({
          ok: true,
          moves: [{ sourcePath: "docs/notes.txt", path: "notes.txt", kind: "file" }],
        });
      }
      if (input.path === "docs") {
        return Promise.resolve({
          entries: [{ name: "notes.txt", path: "docs/notes.txt", kind: "file", size: 9 }],
        });
      }
      return Promise.resolve({ entries: rootEntries });
    });
    const view = render(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="zh-CN" />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "展开 docs" }));
    const nestedFile = await screen.findByRole("button", { name: "预览 notes.txt" });
    fireEvent.click(nestedFile);
    fireEvent.contextMenu(nestedFile);
    fireEvent.click(await screen.findByRole("menuitem", { name: "剪切" }));

    const rootPasteButton = await screen.findByRole("button", {
      name: "粘贴到Client Files根目录",
    });
    expect(rootPasteButton).toBeEnabled();
    setUiCopyLanguage("en-US");
    view.rerender(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} uiLanguage="en-US" />,
    );
    const englishRootPasteButton = await screen.findByRole("button", {
      name: "Paste into the Client Files root folder",
    });
    englishRootPasteButton.focus();
    expect(englishRootPasteButton).toHaveFocus();
    fireEvent.click(englishRootPasteButton);

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("move_entries", {
        mountId: "uw-mounted",
        paths: ["docs/notes.txt"],
        targetDirPath: "",
      }),
    );
  });

  it("copies a file into a directory from user-space context menus", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制" }));

    fireEvent.contextMenu(await screen.findByRole("button", { name: "展开 docs" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "粘贴到此处" }));

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("copy_entries", {
        mountId: "uw-mounted",
        paths: ["README.md"],
        targetDirPath: "docs",
      }),
    );
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "list_dir",
        expect.objectContaining({
          mountId: "uw-mounted",
          path: "docs",
        }),
      ),
    );

    fireEvent.contextMenu(await screen.findByRole("button", { name: "展开 docs" }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "粘贴到此处" })).not.toBeInTheDocument();
  });

  it("copies all selected user-space objects into the target directory and clears the clipboard", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const docsButton = await screen.findByRole("button", { name: "展开 docs" });
    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });

    fireEvent.click(docsButton, { metaKey: true });
    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.contextMenu(readmeButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制" }));

    const blankArea = screen.getByTestId("user-space-tree-blank-area");
    fireEvent.contextMenu(blankArea);
    fireEvent.click(await screen.findByRole("menuitem", { name: "粘贴到此处" }));

    await waitFor(() => {
      const copyCalls = mockExecuteUserSpaceOperation.mock.calls.filter(
        ([operation]) => operation === "copy_entries",
      );
      expect(copyCalls).toEqual([
        [
          "copy_entries",
          {
            mountId: "uw-mounted",
            paths: expect.arrayContaining(["docs", "README.md"]),
            targetDirPath: "",
          },
        ],
      ]);
    });
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "list_dir",
        expect.objectContaining({
          mountId: "uw-mounted",
          path: "",
        }),
      ),
    );

    fireEvent.contextMenu(blankArea);
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "粘贴到此处" })).not.toBeInTheDocument();
  });

  it("transfers user-space entries to Agent space from the context menu", async () => {
    mockTransferUserToAgent.mockResolvedValueOnce({
      ok: true,
      files: [{ source: "README.md", target: "shared/README.md", status: "ok", size: 12 }],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "传输到Agent空间" }));

    await waitFor(() => expect(mockTransferUserToAgent).toHaveBeenCalledWith("s1", "README.md"));
    await waitFor(() => expect(mockGetAgentSpaceTree).toHaveBeenCalledWith("s1"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("bg-success-muted");
    expect(alert).toHaveTextContent("文件传输成功");
    expect(alert).not.toHaveTextContent("已传输 1 个文件到 Agent 空间。");
    expect(alert.querySelector('[data-slot="alert-description"]')).toBeNull();
    const closeButton = within(alert).getByRole("button", { name: "关闭" });
    expect(closeButton.querySelector("svg")).toBeInTheDocument();
    expect(closeButton).toHaveClass(
      "bg-transparent!",
      "text-foreground",
      "hover:bg-transparent!",
      "data-[hovered]:bg-transparent!",
    );
    fireEvent.click(closeButton);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stacks workspace alerts and dismisses each alert independently", async () => {
    mockTransferUserToAgent.mockResolvedValue({
      ok: true,
      files: [{ source: "README.md", target: "shared/README.md", status: "ok", size: 12 }],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    for (let index = 0; index < 2; index += 1) {
      fireEvent.contextMenu(readmeButton);
      fireEvent.click(await screen.findByRole("menuitem", { name: "传输到Agent空间" }));
      await waitFor(() => expect(mockTransferUserToAgent).toHaveBeenCalledTimes(index + 1));
      await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(index + 1));
    }

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    const stack = screen.getByTestId("workspace-alert-stack");
    expect(stack).toHaveAttribute("data-expanded", "false");
    expect(alerts[0]).toHaveClass("col-start-1", "row-start-1");
    expect(alerts[1]).toHaveClass("col-start-1", "row-start-1");
    expect(alerts[0]).toHaveClass("border", "border-success/70");
    expect(alerts[1]).toHaveStyle({ transform: "translateY(10px) scale(0.985)" });

    fireEvent.mouseEnter(stack);
    expect(stack).toHaveAttribute("data-expanded", "true");
    expect(stack).toHaveClass("pointer-events-auto", "gap-2");
    expect(alerts[0]).not.toHaveClass("col-start-1", "row-start-1");
    expect(alerts[1]).not.toHaveClass("col-start-1", "row-start-1");

    fireEvent.mouseLeave(stack);
    expect(stack).toHaveAttribute("data-expanded", "false");
    fireEvent.click(within(alerts[0]!).getByRole("button", { name: "关闭" }));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("transfers all selected user-space files to Agent space from the context menu", async () => {
    mockTransferUserToAgent
      .mockResolvedValueOnce({
        ok: true,
        files: [{ source: "README.md", target: "shared/README.md", status: "ok", size: 12 }],
      })
      .mockResolvedValueOnce({
        ok: true,
        files: [{ source: "app.ts", target: "shared/app.ts", status: "ok", size: 26 }],
      });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const readmeButton = await screen.findByRole("button", { name: "预览 README.md" });
    const appButton = await screen.findByRole("button", { name: "预览 app.ts" });

    fireEvent.click(readmeButton, { metaKey: true });
    fireEvent.click(appButton, { metaKey: true });
    fireEvent.contextMenu(readmeButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "传输到Agent空间" }));

    await waitFor(() => expect(mockTransferUserToAgent).toHaveBeenCalledTimes(2));
    expect(mockTransferUserToAgent.mock.calls).toEqual([
      ["s1", "app.ts"],
      ["s1", "README.md"],
    ]);
    await waitFor(() => expect(mockGetAgentSpaceTree).toHaveBeenCalledWith("s1"));
    expect(await screen.findByRole("alert")).toHaveTextContent("文件传输成功");
  });

  it("shows an already-exists alert when a transfer is skipped by matching hash", async () => {
    mockTransferUserToAgent.mockResolvedValueOnce({
      ok: true,
      files: [
        { source: "README.md", target: "workspace/shared/README.md", status: "exists", size: 12 },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "传输到Agent空间" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("文件已存在");
    expect(alert).not.toHaveTextContent("文件传输成功");
    fireEvent.click(within(alert).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("transfers Agent space entries back to user-space from the context menu", async () => {
    mockTransferAgentToUser.mockResolvedValueOnce({
      ok: true,
      files: [{ source: "artifact.pdf", target: "shared/artifact.pdf", status: "ok", size: 128 }],
    });
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [{ name: "artifact.pdf", path: "artifact.pdf", type: "file", size: 128 }],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentFile = await screen.findByTestId("agent-space-entry-artifact.pdf");
    mockExecuteUserSpaceOperation.mockClear();

    fireEvent.contextMenu(agentFile);
    fireEvent.click(await screen.findByRole("menuitem", { name: "传输到用户空间" }));

    await waitFor(() => expect(mockTransferAgentToUser).toHaveBeenCalledWith("s1", "artifact.pdf"));
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "list_dir",
        expect.objectContaining({
          mountId: "uw-mounted",
          path: "",
        }),
      ),
    );
    expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
      "list_dir",
      expect.objectContaining({
        mountId: "uw-mounted",
        path: "shared",
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("文件传输成功");
    expect(alert).not.toHaveTextContent("已传输 1 个文件到用户空间。");
    fireEvent.click(within(alert).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("transfers all selected Agent space entries back to user-space from the context menu", async () => {
    mockTransferAgentToUser
      .mockResolvedValueOnce({
        ok: true,
        files: [{ source: "a.txt", target: "shared/a.txt", status: "ok", size: 1 }],
      })
      .mockResolvedValueOnce({
        ok: true,
        files: [{ source: "b.txt", target: "shared/b.txt", status: "ok", size: 2 }],
      });
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [
        { name: "a.txt", path: "a.txt", type: "file", size: 1 },
        { name: "b.txt", path: "b.txt", type: "file", size: 2 },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentTree = await screen.findByTestId("agent-space-tree");
    fireEvent.click(within(agentTree).getByRole("button", { name: "预览 a.txt" }), {
      metaKey: true,
    });
    fireEvent.click(within(agentTree).getByRole("button", { name: "预览 b.txt" }), {
      metaKey: true,
    });
    mockExecuteUserSpaceOperation.mockClear();

    fireEvent.contextMenu(screen.getByTestId("agent-space-entry-a.txt"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "传输到用户空间" }));

    await waitFor(() => expect(mockTransferAgentToUser).toHaveBeenCalledTimes(2));
    expect(mockTransferAgentToUser.mock.calls).toEqual([
      ["s1", "a.txt"],
      ["s1", "b.txt"],
    ]);
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "list_dir",
        expect.objectContaining({
          mountId: "uw-mounted",
          path: "",
        }),
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("文件传输成功");
  });

  it("opens details for all selected Agent space entries from the context menu", async () => {
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [
        { name: "a.txt", path: "a.txt", type: "file", size: 1 },
        { name: "build", path: "build", type: "directory", children: [] },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentTree = await screen.findByTestId("agent-space-tree");
    fireEvent.click(within(agentTree).getByRole("button", { name: "预览 a.txt" }), {
      metaKey: true,
    });
    fireEvent.click(within(agentTree).getByRole("button", { name: "展开 build" }), {
      metaKey: true,
    });

    fireEvent.contextMenu(screen.getByTestId("agent-space-entry-build"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "详情" }));

    const dialog = await screen.findByRole("dialog", { name: "详情" });
    expect(within(dialog).getByText("文件总数量")).toBeInTheDocument();
    expect(within(dialog).getByText("不同文件类型数量")).toBeInTheDocument();
    expect(within(dialog).getByText("总计大小")).toBeInTheDocument();
    expect(within(dialog).getByText("1")).toBeInTheDocument();
    expect(within(dialog).getByText("纯文本文稿 1")).toBeInTheDocument();
    expect(within(dialog).getByText("1 B")).toBeInTheDocument();
    expect(within(dialog).queryByText("a.txt")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("build")).not.toBeInTheDocument();
  });

  it("opens aggregate details for an Agent space folder from the context menu", async () => {
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [
        {
          name: "build",
          path: "build",
          type: "directory",
          children: [
            { name: "a.txt", path: "build/a.txt", type: "file", size: 1 },
            { name: "bundle.js", path: "build/bundle.js", type: "file", size: 15 },
          ],
        },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentTree = await screen.findByTestId("agent-space-tree");
    fireEvent.contextMenu(within(agentTree).getByTestId("agent-space-entry-build"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "详情" }));

    const dialog = await screen.findByRole("dialog", { name: "详情" });
    expect(within(dialog).getByText("文件总数量")).toBeInTheDocument();
    expect(within(dialog).getByText("2")).toBeInTheDocument();
    expect(within(dialog).getByText("文件 1")).toBeInTheDocument();
    expect(within(dialog).getByText("纯文本文稿 1")).toBeInTheDocument();
    expect(within(dialog).getByText("16 B")).toBeInTheDocument();
  });

  it("deletes Agent space files from the context menu", async () => {
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [{ name: "artifact.pdf", path: "artifact.pdf", type: "file", size: 128 }],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentFile = await screen.findByTestId("agent-space-entry-artifact.pdf");

    fireEvent.contextMenu(agentFile);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    const deleteDialog = await screen.findByRole("alertdialog", { name: "删除文件？" });
    expect(within(deleteDialog).getByRole("button", { name: "取消" })).toHaveClass(
      "border",
      "border-border",
      "bg-secondary",
      "text-foreground",
    );
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(mockDeleteAgentSpaceEntry).toHaveBeenCalledWith("s1", "artifact.pdf", false),
    );
    await waitFor(() => expect(mockGetAgentSpaceTree).toHaveBeenCalledTimes(2));
  });

  it("deletes Agent space folders recursively from the context menu", async () => {
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [
        {
          name: "build",
          path: "build",
          type: "directory",
          children: [{ name: "out.txt", path: "build/out.txt", type: "file", size: 12 }],
        },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentFolder = await screen.findByTestId("agent-space-entry-build");

    fireEvent.contextMenu(agentFolder);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除文件夹" }));
    const deleteDialog = await screen.findByRole("alertdialog", { name: "删除文件夹？" });
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(mockDeleteAgentSpaceEntry).toHaveBeenCalledWith("s1", "build", true),
    );
  });

  it("deletes the maximal selected Agent space range when nested selections overlap", async () => {
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [
        {
          name: "build",
          path: "build",
          type: "directory",
          children: [{ name: "out.txt", path: "build/out.txt", type: "file", size: 12 }],
        },
      ],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentTree = await screen.findByTestId("agent-space-tree");
    fireEvent.click(within(agentTree).getByRole("button", { name: "展开 build" }));
    const outFile = await screen.findByTestId("agent-space-entry-build/out.txt");
    fireEvent.click(within(outFile).getByRole("button", { name: "预览 out.txt" }), {
      metaKey: true,
    });

    fireEvent.contextMenu(outFile);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    const deleteDialog = await screen.findByRole("alertdialog", { name: "删除文件夹？" });
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(mockDeleteAgentSpaceEntry.mock.calls).toEqual([["s1", "build", true]]);
    });
  });

  it("closes an Agent space preview tab after deleting that file", async () => {
    mockGetAgentSpaceTree.mockResolvedValue({
      path: "",
      rootName: "workspace",
      tree: [{ name: "app.ts", path: "app.ts", type: "file", size: 42 }],
    });
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Agent空间" }));
    const agentFile = await screen.findByTestId("agent-space-entry-app.ts");
    fireEvent.click(within(agentFile).getByRole("button", { name: "预览 app.ts" }));
    expect(await screen.findByTestId("preview-tab-__piwork_agent__:app.ts")).toBeInTheDocument();

    fireEvent.contextMenu(agentFile);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    const deleteDialog = await screen.findByRole("alertdialog", { name: "删除文件？" });
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(mockDeleteAgentSpaceEntry).toHaveBeenCalledWith("s1", "app.ts", false),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("preview-tab-__piwork_agent__:app.ts")).not.toBeInTheDocument(),
    );
  });

  it("creates typed files from the context submenu and renames files inline", async () => {
    let docsEntries = [
      { name: "notes.txt", path: "docs/notes.txt", kind: "file" as const, size: 9 },
    ];
    mockExecuteUserSpaceOperation.mockImplementation(
      (operation, input: { parentPath?: string; path?: string; name?: string; cwd?: string }) => {
        if (operation === "create_entry" && input.parentPath === "docs" && input.name) {
          docsEntries = [
            ...docsEntries,
            { name: input.name, path: `docs/${input.name}`, kind: "file" as const, size: 0 },
          ];
          return Promise.resolve({ path: `docs/${input.name}`, kind: "file" });
        }
        if (operation === "shell_exec") {
          return Promise.resolve({
            stdout: "README.md\n",
            stderr: "",
            exitCode: 0,
            cwd: input.cwd || "",
          });
        }
        if (input.path === "docs") return Promise.resolve({ entries: docsEntries });
        return Promise.resolve({ entries: rootEntries });
      },
    );
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "展开 docs" }));
    const newFileMenu = await screen.findByRole("menuitem", { name: "新建文件" });
    fireEvent.pointerMove(newFileMenu);
    fireEvent.keyDown(newFileMenu, { key: "ArrowRight" });
    const wordMenuItem = await screen.findByRole("menuitem", { name: "Word 文档" });
    const pptMenuItem = screen.getByRole("menuitem", { name: "PPT 演示文稿" });
    const excelMenuItem = screen.getByRole("menuitem", { name: "Excel 表格" });
    const textMenuItem = screen.getByRole("menuitem", { name: "TXT 文本" });
    expect(wordMenuItem.querySelector("[data-office-icon='word']")).toBeInTheDocument();
    expect(pptMenuItem.querySelector("[data-office-icon='presentation']")).toBeInTheDocument();
    expect(excelMenuItem.querySelector("[data-office-icon='spreadsheet']")).toBeInTheDocument();
    expect(textMenuItem.querySelector("[data-file-icon='text']")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Markdown" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "JSON" })).not.toBeInTheDocument();
    fireEvent.click(textMenuItem);

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("create_entry", {
        mountId: "uw-mounted",
        parentPath: "docs",
        name: "新建txt.txt",
        kind: "file",
        content: "",
      }),
    );
    const createdRenameInput = await screen.findByRole("textbox", { name: "重命名 新建txt.txt" });
    expect(createdRenameInput).toHaveValue("新建txt.txt");
    await waitFor(() => {
      expect(createdRenameInput).toHaveProperty("selectionStart", 0);
      expect(createdRenameInput).toHaveProperty("selectionEnd", "新建txt".length);
    });
    fireEvent.change(createdRenameInput, { target: { value: "idea.txt" } });
    fireEvent.keyDown(createdRenameInput, { key: "Enter" });

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("rename_entry", {
        mountId: "uw-mounted",
        path: "docs/新建txt.txt",
        name: "idea.txt",
      }),
    );

    fireEvent.contextMenu(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const renameInput = await screen.findByRole("textbox", { name: "重命名 README.md" });
    expect(screen.queryByRole("dialog", { name: "重命名文件" })).not.toBeInTheDocument();
    expect(renameInput).toHaveValue("README.md");
    expect(renameInput.parentElement).toHaveAttribute("data-name-availability", "available");
    expect(renameInput.parentElement).toHaveClass("border-success", "ring-success/20");
    await waitFor(() => {
      expect(renameInput).toHaveProperty("selectionStart", 0);
      expect(renameInput).toHaveProperty("selectionEnd", "README".length);
    });
    fireEvent.change(renameInput, { target: { value: "ROAD/MAP.md" } });
    expect(renameInput).toHaveAttribute("aria-invalid", "true");
    expect(renameInput.parentElement).toHaveAttribute("data-name-availability", "invalid");
    expect(renameInput.parentElement).toHaveClass("border-danger", "ring-danger/20");
    fireEvent.change(renameInput, { target: { value: "ROADMAP.md" } });
    expect(renameInput).not.toHaveAttribute("aria-invalid");
    expect(renameInput.parentElement).toHaveAttribute("data-name-availability", "available");
    expect(renameInput.parentElement).toHaveClass("border-success", "ring-success/20");
    fireEvent.keyDown(renameInput, { key: "Enter" });

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("rename_entry", {
        mountId: "uw-mounted",
        path: "README.md",
        name: "ROADMAP.md",
      }),
    );
  });

  it("creates a Word file from the user-space blank-area context menu", async () => {
    let currentRootEntries = rootEntries.slice();
    mockExecuteUserSpaceOperation.mockImplementation(
      (operation, input: { parentPath?: string; path?: string; name?: string; cwd?: string }) => {
        if (operation === "create_entry" && input.parentPath === "" && input.name) {
          currentRootEntries = [
            ...currentRootEntries,
            { name: input.name, path: input.name, kind: "file" as const, size: 0 },
          ];
          return Promise.resolve({ path: input.name, kind: "file" });
        }
        if (operation === "shell_exec") {
          return Promise.resolve({
            stdout: "README.md\n",
            stderr: "",
            exitCode: 0,
            cwd: input.cwd || "",
          });
        }
        if (input.path === "docs") {
          return Promise.resolve({
            entries: [
              { name: "notes.txt", path: "docs/notes.txt", kind: "file" as const, size: 9 },
            ],
          });
        }
        return Promise.resolve({ entries: currentRootEntries });
      },
    );
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await screen.findByRole("button", { name: "预览 README.md" });
    fireEvent.contextMenu(screen.getByTestId("user-space-tree-blank-area"));
    const newFileMenu = await screen.findByRole("menuitem", { name: "新建文件" });
    fireEvent.pointerMove(newFileMenu);
    fireEvent.keyDown(newFileMenu, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Word 文档" }));

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("create_entry", {
        mountId: "uw-mounted",
        parentPath: "",
        name: "新建word.docx",
        kind: "file",
        content: "",
      }),
    );
    expect(await screen.findByRole("textbox", { name: "重命名 新建word.docx" })).toHaveValue(
      "新建word.docx",
    );
  });

  it("keeps the workspace context menu active on Tab and cancels it on Escape", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await screen.findByRole("button", { name: "预览 README.md" });
    fireEvent.contextMenu(screen.getByTestId("user-space-tree-blank-area"));
    const menu = await screen.findByRole("menu");

    fireEvent.keyDown(menu, { key: "Tab" });
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("localizes the new text-file menu item in English", async () => {
    setUiCopyLanguage("en-US");
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await screen.findByRole("button", { name: "Preview README.md" });
    fireEvent.contextMenu(screen.getByTestId("user-space-tree-blank-area"));
    expect(await screen.findByRole("menuitem", { name: "Open wterm" })).toBeInTheDocument();
    const newFileMenu = await screen.findByRole("menuitem", { name: "New file" });
    fireEvent.pointerMove(newFileMenu);
    fireEvent.keyDown(newFileMenu, { key: "ArrowRight" });

    expect(await screen.findByRole("menuitem", { name: "Text file" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Markdown" })).not.toBeInTheDocument();
  });

  it("confirms before changing a file extension during inline rename", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const renameInput = await screen.findByRole("textbox", { name: "重命名 README.md" });
    fireEvent.change(renameInput, { target: { value: "README.txt" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });

    const confirmDialog = await screen.findByRole("alertdialog", { name: "更改文件扩展名？" });
    expect(
      within(confirmDialog).getByText(
        "“README.md”将重命名为“README.txt”。更改扩展名可能导致文件无法正常打开。",
      ),
    ).toBeInTheDocument();
    expect(mockExecuteUserSpaceOperation).not.toHaveBeenCalledWith(
      "rename_entry",
      expect.anything(),
    );

    fireEvent.click(within(confirmDialog).getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "更改文件扩展名？" }),
      ).not.toBeInTheDocument(),
    );
    expect(renameInput).toHaveValue("README.md");
    await waitFor(() => expect(renameInput).toHaveFocus());

    fireEvent.change(renameInput, { target: { value: "README.txt" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "仍要更改" }));

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("rename_entry", {
        mountId: "uw-mounted",
        path: "README.md",
        name: "README.txt",
      }),
    );
  });

  it("localizes the file-extension rename confirmation in English", async () => {
    setUiCopyLanguage("en-US");
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "Preview README.md" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const renameInput = await screen.findByRole("textbox", { name: "Rename README.md" });
    fireEvent.change(renameInput, { target: { value: "README.txt" } });
    fireEvent.blur(renameInput);

    const confirmDialog = await screen.findByRole("alertdialog", {
      name: "Change file extension?",
    });
    expect(
      within(confirmDialog).getByText(
        "“README.md” will be renamed to “README.txt”. Changing the extension may prevent the file from opening correctly.",
      ),
    ).toBeInTheDocument();
    expect(
      within(confirmDialog).getByRole("button", { name: "Change anyway" }),
    ).toBeInTheDocument();
  });

  it("confirms destructive deletes from the user-space context menu", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "预览 README.md" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    const deleteDialog = await screen.findByRole("alertdialog", { name: "删除文件？" });
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith("delete_entry", {
        mountId: "uw-mounted",
        path: "README.md",
        recursive: false,
      }),
    );
  });

  it("deletes the maximal selected workspace range when nested selections overlap", async () => {
    mockExecuteUserSpaceOperation.mockImplementation(
      (operation, input: { path?: string; cwd?: string }) => {
        if (operation === "delete_entry") return Promise.resolve({ ok: true });
        if (operation === "shell_exec") {
          return Promise.resolve({
            stdout: "README.md\n",
            stderr: "",
            exitCode: 0,
            cwd: input.cwd || "",
          });
        }
        if (input.path === "docs") {
          return Promise.resolve({
            entries: [
              { name: "reports", path: "docs/reports", kind: "directory" as const },
              { name: "sibling.txt", path: "docs/sibling.txt", kind: "file" as const, size: 7 },
            ],
          });
        }
        if (input.path === "docs/reports") {
          return Promise.resolve({
            entries: [
              {
                name: "report.txt",
                path: "docs/reports/report.txt",
                kind: "file" as const,
                size: 12,
              },
            ],
          });
        }
        return Promise.resolve({ entries: rootEntries });
      },
    );
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const docsButton = await screen.findByRole("button", { name: "展开 docs" });
    fireEvent.click(docsButton);
    const reportsButton = await screen.findByRole("button", { name: "展开 reports" });
    fireEvent.click(reportsButton);
    const reportButton = await screen.findByRole("button", { name: "预览 report.txt" });

    fireEvent.click(docsButton, { metaKey: true });
    fireEvent.click(reportsButton, { metaKey: true });
    fireEvent.click(reportButton, { metaKey: true });
    fireEvent.contextMenu(reportButton);
    expect(screen.queryByRole("menuitem", { name: "重命名" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));

    const deleteDialog = await screen.findByRole("alertdialog", { name: "删除文件夹？" });
    expect(within(deleteDialog).getByText("将删除 docs 以及其中的内容。")).toBeInTheDocument();
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "删除" }));

    await waitFor(() => {
      const deleteCalls = mockExecuteUserSpaceOperation.mock.calls.filter(
        ([operation]) => operation === "delete_entry",
      );
      expect(deleteCalls).toEqual([
        [
          "delete_entry",
          {
            mountId: "uw-mounted",
            path: "docs",
            recursive: true,
          },
        ],
      ]);
    });
  });

  it("renders large text with CodeMirror instead of legacy native iframe scrolling", async () => {
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 big.txt" }));

    const editor = await screen.findByTestId("text-editor-uw-mounted:big.txt");
    expect(
      (within(editor).getByTestId("codemirror-editor") as HTMLTextAreaElement).value,
    ).toContain("line 1");
    expect(screen.queryByText(/滑动窗口/)).not.toBeInTheDocument();
  });

  it("revokes an object URL created after an async preview outlives component unmount", async () => {
    let resolveFile!: (file: File) => void;
    const pendingFile = new Promise<File>((resolve) => {
      resolveFile = resolve;
    });
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) =>
      path === "README.md" ? pendingFile : defaultMockGetUserSpaceFile(_mountId, path),
    );
    const createObjectURL = vi.mocked(globalThis.URL.createObjectURL);
    const revokeObjectURL = vi.mocked(globalThis.URL.revokeObjectURL);
    createObjectURL.mockReturnValue("blob:http://localhost/late-preview");
    const { unmount } = render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    await waitFor(() =>
      expect(mockGetUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "README.md"),
    );
    unmount();
    resolveFile(new File(["# Late preview"], "README.md", { type: "text/markdown" }));

    await waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/late-preview"),
    );
  });

  it("revokes an object URL created after the preview owner switches", async () => {
    let resolveFile!: (file: File) => void;
    const pendingFile = new Promise<File>((resolve) => {
      resolveFile = resolve;
    });
    mockGetUserSpaceFile.mockImplementation((_mountId: string, path: string) =>
      path === "README.md" ? pendingFile : defaultMockGetUserSpaceFile(_mountId, path),
    );
    const createObjectURL = vi.mocked(globalThis.URL.createObjectURL);
    const revokeObjectURL = vi.mocked(globalThis.URL.revokeObjectURL);
    createObjectURL.mockReturnValue("blob:http://localhost/switched-preview");
    const { rerender } = render(
      <UserSpaceExplorer sessionId="s1" agentId="agent-a" mounts={[mountedWorkspace]} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    await waitFor(() =>
      expect(mockGetUserSpaceFile).toHaveBeenCalledWith("uw-mounted", "README.md"),
    );
    rerender(<UserSpaceExplorer sessionId="s1" agentId="agent-b" mounts={[mountedWorkspace]} />);
    resolveFile(new File(["# Switched preview"], "README.md", { type: "text/markdown" }));

    await waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/switched-preview"),
    );
  });

  it("does not let an old owner preview win after the new owner reopens the same path", async () => {
    let resolveOldFile!: (file: File) => void;
    let resolveNewFile!: (file: File) => void;
    const oldFile = new Promise<File>((resolve) => {
      resolveOldFile = resolve;
    });
    const newFile = new Promise<File>((resolve) => {
      resolveNewFile = resolve;
    });
    mockGetUserSpaceFile
      .mockImplementationOnce(() => oldFile)
      .mockImplementationOnce(() => newFile);
    const createObjectURL = vi.mocked(globalThis.URL.createObjectURL);
    const revokeObjectURL = vi.mocked(globalThis.URL.revokeObjectURL);
    createObjectURL
      .mockReturnValueOnce("blob:http://localhost/new-owner-preview")
      .mockReturnValueOnce("blob:http://localhost/old-owner-preview");
    const { rerender } = render(
      <UserSpaceExplorer sessionId="s1" agentId="agent-a" mounts={[mountedWorkspace]} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    await waitFor(() => expect(mockGetUserSpaceFile).toHaveBeenCalledTimes(1));
    rerender(<UserSpaceExplorer sessionId="s1" agentId="agent-b" mounts={[mountedWorkspace]} />);
    fireEvent.click(await screen.findByRole("button", { name: "预览 README.md" }));
    await waitFor(() => expect(mockGetUserSpaceFile).toHaveBeenCalledTimes(2));

    resolveNewFile(new File(["# New owner"], "README.md", { type: "text/markdown" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    resolveOldFile(new File(["# Old owner"], "README.md", { type: "text/markdown" }));

    await waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/old-owner-preview"),
    );
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:http://localhost/new-owner-preview");
  });

  it("renders PDF and Office preview surfaces", async () => {
    const { unmount } = render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    fireEvent.click(await screen.findByRole("button", { name: "预览 manual.pdf" }));
    expect(await screen.findByTitle("PDF 预览 manual.pdf")).toHaveAttribute(
      "src",
      "blob:http://localhost/workspace-preview",
    );
    expect(screen.getByTestId("user-space-preview-toolbar-filename")).toHaveTextContent(
      "manual.pdf",
    );
    expect(
      within(screen.getByTestId("user-space-preview-toolbar")).queryByRole("button", {
        name: "编辑",
      }),
    ).not.toBeInTheDocument();

    unmount();
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);
    fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

    const officePreview = await screen.findByTitle("Office 本地编辑 report.docx");
    expect(screen.getByTestId("user-space-preview-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("user-space-preview-toolbar-filename")).toHaveTextContent(
      "report.docx",
    );
    expect(officePreview).toHaveAttribute("data-piwork-office-preview-path", "report.docx");
    expect(mockCreateOfficeEditor).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        fileName: "report.docx",
        hostUrl: expect.any(Function),
        mode: "edit",
        readonly: false,
      }),
    );
    expect(mockCreateOfficeEditor.mock.calls.at(-1)?.[1]).not.toHaveProperty(
      "hardResetOnLastDestroy",
    );
    expect(screen.getByTestId("onlyoffice-browser-preview")).toHaveClass(
      "h-full",
      "min-h-0",
      "w-full",
      "overflow-hidden",
      "bg-background",
    );
    expect(officePreview).toHaveClass(
      "piwork-onlyoffice-browser-host",
      "absolute",
      "inset-0",
      "block",
      "h-full",
      "min-h-0",
      "w-full",
      "bg-background",
    );
    expect(officePreview).toHaveStyle({ width: "1280px", height: "720px" });
    const officeHostFrame = officePreview.querySelector("iframe.office-editor-host-frame");
    expect(officeHostFrame).toBeInTheDocument();
    expect(officeHostFrame).not.toHaveAttribute("sandbox");
    expect(officePreview.querySelector('iframe[name="frameEditor"]')).not.toBeInTheDocument();
  });

  it("commits Office width once after browser resizing settles", async () => {
    let previewWidth = 640;
    const originalInnerWidth = window.innerWidth;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.matches('[data-testid="onlyoffice-browser-preview"]')) {
          return createDomRect({ x: 0, y: 0, width: previewWidth, height: 720 });
        }
        return createDomRect({ x: 0, y: 0, width: 0, height: 0 });
      });

    try {
      render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);
      fireEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));

      const officeHost = await screen.findByTitle("Office 本地编辑 report.docx");
      vi.useFakeTimers();
      previewWidth = 520;
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth - 100,
      });
      fireEvent(window, new Event("resize"));
      expect(officeHost).toHaveStyle({ width: "640px", right: "auto" });
      expect(screen.getByTestId("onlyoffice-browser-resize-mask")).toHaveClass(
        "absolute",
        "inset-0",
        "bg-background/90",
      );

      previewWidth = 460;
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth - 180,
      });
      fireEvent(window, new Event("resize"));
      act(() => vi.advanceTimersByTime(179));
      expect(officeHost).toHaveStyle({ width: "640px" });

      act(() => vi.advanceTimersByTime(1));
      expect(officeHost.style.width).toBe("");
      expect(officeHost.style.right).toBe("");
      expect(screen.queryByTestId("onlyoffice-browser-resize-mask")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      rectSpy.mockRestore();
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth,
      });
    }
  });

  it("times out a stalled directory read so the tree can recover", async () => {
    mockExecuteUserSpaceOperation.mockReturnValueOnce(new Promise(() => {}));

    render(
      <UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} directoryLoadTimeoutMs={1} />,
    );

    await waitFor(() => expect(screen.getByText("目录读取超时，请重试。")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByText("读取目录...")).not.toBeInTheDocument();
  });

  it("automatically retries a timed out root directory read", async () => {
    mockExecuteUserSpaceOperation
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce({ entries: rootEntries });

    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        directoryLoadTimeoutMs={1}
        directoryRetryDelayMs={1}
      />,
    );

    await waitFor(() => expect(screen.getByText("目录读取超时，请重试。")).toBeInTheDocument());
    await waitFor(() => {
      expect(
        mockExecuteUserSpaceOperation.mock.calls.filter(([operation]) => operation === "list_dir"),
      ).toHaveLength(2);
    });

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(screen.queryByText("目录读取超时，请重试。")).not.toBeInTheDocument();
  });

  it("automatically recovers when a refreshed runtime disposes the first directory request", async () => {
    mockExecuteUserSpaceOperation
      .mockRejectedValueOnce(new Error("User space runtime disposed."))
      .mockResolvedValueOnce({ entries: rootEntries });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await waitFor(() => {
      expect(
        mockExecuteUserSpaceOperation.mock.calls.filter(([operation]) => operation === "list_dir"),
      ).toHaveLength(2);
    });
    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(screen.queryByText("User space runtime disposed.")).not.toBeInTheDocument();
  });

  it("adds a new active user-space without detaching existing roots", async () => {
    const onMountsConfigured = vi.fn();
    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        persistenceScope={persistenceScope}
        onMountsConfigured={onMountsConfigured}
      />,
    );

    await mountDirectoryFromUserSpaceManager();

    await waitFor(() => expect(mockMountUserSpace).toHaveBeenCalledOnce());
    const manager = screen.getByRole("dialog", { name: "管理用户空间目录" });
    expect(mockAttachUserSpaceMountsToSession).not.toHaveBeenCalled();
    expect(mockConfigureUserSpace).not.toHaveBeenCalled();
    await within(manager).findByText("Next Files");
    fireEvent.click(within(manager).getByRole("button", { name: "保存配置" }));
    expect(mockMountUserSpace).toHaveBeenCalledWith(
      "readwrite",
      expect.objectContaining({ persistenceScope }),
    );
    expect(mockDetachUserSpaceFromSession).not.toHaveBeenCalledWith("s1", "uw-mounted");
    await waitFor(() =>
      expect(mockAttachUserSpaceMountsToSession).toHaveBeenCalledWith("s1", [
        "uw-mounted",
        "uw-next",
      ]),
    );
    expect(onMountsConfigured).toHaveBeenCalledWith([
      expect.objectContaining({ mountId: "uw-mounted", rootName: "Client Files" }),
      expect.objectContaining({ mountId: "uw-next", rootName: "Next Files" }),
    ]);
    expect(mockConfigureUserSpace).toHaveBeenCalledWith(
      "s1",
      [
        expect.objectContaining({ mountId: "uw-mounted" }),
        expect.objectContaining({ mountId: "uw-next" }),
      ],
      "uw-next",
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("bg-success-muted");
    expect(alert).toHaveTextContent("用户空间配置已保存。");
    expect(alert.querySelector('[data-slot="alert-description"]')).toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not show an add user space modal while the directory picker is pending", async () => {
    mockMountUserSpace.mockImplementationOnce(
      (_access: unknown, options?: { onProgress?: (progress: unknown) => void }) => {
        options?.onProgress?.({ phase: "indexing", rootName: "Next Files" });
        return new Promise(() => {});
      },
    );
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await mountDirectoryFromUserSpaceManager();

    await waitFor(() => expect(mockMountUserSpace).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog", { name: "添加用户空间" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-space-mount-progress-dialog")).not.toBeInTheDocument();
  });

  it("adds a new root without waiting for the root list to finish", async () => {
    const onMountsConfigured = vi.fn();
    const nextMount = {
      mountId: "uw-next",
      name: "Next Files",
      rootName: "Next Files",
      status: "mounted",
      access: "readwrite",
      includeHidden: true,
      fileCount: 1,
    } as const;
    const nextRootLoad = new Promise<{
      entries: Array<{ name: string; path: string; kind: "file"; size: number }>;
    }>(() => {});
    mockMountUserSpace.mockImplementationOnce(async () => {
      mockSnapshot = {
        ...mockSnapshot,
        mounts: [mountedWorkspace, nextMount],
      };
      return nextMount;
    });
    mockExecuteUserSpaceOperation.mockImplementation((_operation, input: { mountId?: string }) => {
      if (input.mountId === "uw-next") return nextRootLoad;
      return Promise.resolve({ entries: rootEntries });
    });

    function Harness() {
      const [configuredMounts, setConfiguredMounts] = useState<UserSpaceMount[]>([
        mountedWorkspace,
      ]);
      return (
        <UserSpaceExplorer
          sessionId="s1"
          mounts={configuredMounts}
          onMountsConfigured={(nextMounts) => {
            onMountsConfigured(nextMounts);
            setConfiguredMounts(nextMounts);
          }}
        />
      );
    }

    render(<Harness />);

    await mountDirectoryFromUserSpaceManager();
    const manager = screen.getByRole("dialog", { name: "管理用户空间目录" });
    await within(manager).findByText("Next Files");
    expect(onMountsConfigured).not.toHaveBeenCalled();
    fireEvent.click(within(manager).getByRole("button", { name: "保存配置" }));

    await waitFor(() =>
      expect(onMountsConfigured).toHaveBeenCalledWith([
        expect.objectContaining({
          mountId: "uw-mounted",
          rootName: "Client Files",
          status: "mounted",
        }),
        expect.objectContaining({ mountId: "uw-next", rootName: "Next Files", status: "mounted" }),
      ]),
    );
    expect(screen.queryByRole("dialog", { name: "添加用户空间" })).not.toBeInTheDocument();
    expect(screen.getByTestId("user-space-current-mount")).toHaveTextContent("Next Files");
    expect(
      screen.queryByRole("button", { name: "收起Next Files用户空间" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(mockExecuteUserSpaceOperation).toHaveBeenCalledWith(
        "list_dir",
        expect.objectContaining({ mountId: "uw-next", path: "" }),
      ),
    );
  });

  it("shows an error instead of adding a duplicate user space", async () => {
    mockMountUserSpace.mockResolvedValueOnce(mountedWorkspace);
    const onMountsConfigured = vi.fn();
    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        onMountsConfigured={onMountsConfigured}
      />,
    );

    await mountDirectoryFromUserSpaceManager();

    expect(await screen.findByText("用户空间“Client Files”已经挂载。")).toBeInTheDocument();
    expect(mockAttachUserSpaceMountsToSession).not.toHaveBeenCalledWith("s1", ["uw-next"]);
    expect(onMountsConfigured).not.toHaveBeenCalled();
    expect(mockConfigureUserSpace).not.toHaveBeenCalled();
  });

  it("asks to change a same-named user space before mounting it", async () => {
    const onMountsConfigured = vi.fn();
    mockMountUserSpace.mockImplementationOnce(
      async (
        _access: unknown,
        options?: {
          onNameConflict?: (conflict: {
            name: string;
            existingNames: string[];
          }) => Promise<string | null>;
        },
      ) => {
        const renamed = await options?.onNameConflict?.({
          name: "Client Files",
          existingNames: ["Client Files"],
        });
        if (!renamed) throw new DOMException("Cancelled", "AbortError");
        return {
          ...mountedWorkspace,
          mountId: "uw-renamed",
          name: renamed,
          rootName: renamed,
        };
      },
    );
    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        onMountsConfigured={onMountsConfigured}
      />,
    );

    await mountDirectoryFromUserSpaceManager();

    const renameDialog = await screen.findByRole("dialog", { name: "设置用户空间别名" });
    expect(renameDialog).toHaveTextContent("“Client Files”已被使用，请输入一个新的用户空间名称。");
    const input = within(renameDialog).getByRole("textbox", { name: "用户空间别名" });
    const submitButton = within(renameDialog).getByRole("button", { name: "设置别名并挂载" });
    expect(input).toHaveValue("Client Files");
    expect(submitButton).toBeDisabled();
    expect(renameDialog).not.toHaveTextContent("别名“Client Files”已被使用，请输入其他别名。");
    expect(within(renameDialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(input).toHaveClass("border-danger");
    expect(input).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(input, { target: { value: "client files" } });
    expect(renameDialog).not.toHaveTextContent("别名“client files”已被使用，请输入其他别名。");
    expect(input).toHaveClass("border-danger");
    expect(submitButton).toBeDisabled();

    fireEvent.change(input, { target: { value: "Client Archive" } });
    expect(within(renameDialog).queryByText("名称“Client Archive”可用。")).not.toBeInTheDocument();
    expect(input).toHaveClass("border-success");
    expect(input).not.toHaveClass("border-danger");
    expect(submitButton).toBeEnabled();
    fireEvent.click(submitButton);

    const manager = screen.getByRole("dialog", { name: "管理用户空间目录" });
    await within(manager).findByText("Client Archive");
    expect(onMountsConfigured).not.toHaveBeenCalled();
    fireEvent.click(within(manager).getByRole("button", { name: "保存配置" }));

    await waitFor(() =>
      expect(onMountsConfigured).toHaveBeenCalledWith([
        expect.objectContaining({ mountId: "uw-mounted", rootName: "Client Files" }),
        expect.objectContaining({ mountId: "uw-renamed", rootName: "Client Archive" }),
      ]),
    );
    expect(mockMountUserSpace).toHaveBeenCalledWith(
      "readwrite",
      expect.objectContaining({ existingRootNames: ["Client Files"] }),
    );
  });

  it("localizes the same-name mount flow in English and allows cancellation", async () => {
    setUiCopyLanguage("en-US");
    mockMountUserSpace.mockImplementationOnce(
      async (
        _access: unknown,
        options?: {
          onNameConflict?: (conflict: {
            name: string;
            existingNames: string[];
          }) => Promise<string | null>;
        },
      ) => {
        const renamed = await options?.onNameConflict?.({
          name: "Client Files",
          existingNames: ["Client Files"],
        });
        if (!renamed) throw new DOMException("Cancelled", "AbortError");
        return mountedWorkspace;
      },
    );
    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    await mountDirectoryFromUserSpaceManager("Manage user space folders", "Add folder");

    const dialog = await screen.findByRole("dialog", { name: "Set user space alias" });
    expect(dialog).toHaveTextContent(
      "“Client Files” is already in use. Enter a new name for this user space.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Set user space alias" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("dialog", { name: "Manage user space folders" })).toBeInTheDocument();
    expect(mockAttachUserSpaceMountsToSession).not.toHaveBeenCalled();
  });

  it("unmounts a selected directory from the current session", async () => {
    const opsWorkspace = {
      mountId: "uw-ops",
      name: "Ops Files",
      rootName: "Ops Files",
      status: "mounted" as const,
      access: "readwrite" as const,
      includeHidden: true as const,
    };
    mockSnapshot = {
      supported: true,
      mounts: [mountedWorkspace, opsWorkspace],
      indexing: {},
      recentOperations: [],
    };
    const onMountsConfigured = vi.fn();
    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace, opsWorkspace]}
        onMountsConfigured={onMountsConfigured}
      />,
    );

    const manager = await openUserSpaceManager();
    fireEvent.click(within(manager).getByRole("button", { name: "取消挂载Client Files" }));
    expect(mockDetachUserSpaceFromSession).not.toHaveBeenCalled();
    expect(onMountsConfigured).not.toHaveBeenCalled();
    expect(within(manager).queryByText("Client Files")).not.toBeInTheDocument();
    fireEvent.click(within(manager).getByRole("button", { name: "保存配置" }));

    await waitFor(() =>
      expect(mockDetachUserSpaceFromSession).toHaveBeenCalledWith("s1", "uw-mounted"),
    );
    expect(onMountsConfigured).toHaveBeenCalledWith([
      expect.objectContaining({ mountId: "uw-ops", rootName: "Ops Files" }),
    ]);
    expect(mockConfigureUserSpace).toHaveBeenCalledWith(
      "s1",
      [expect.objectContaining({ mountId: "uw-ops" })],
      "uw-ops",
    );
  });

  it("does not flash reauthorization while a persisted mount handle is restoring", () => {
    mockSnapshot = {
      supported: true,
      mounts: [],
      indexing: {},
      recentOperations: [],
    };

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} workspaceRestoring />);

    expect(screen.queryByText(/当前离线/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^恢复访问/ })).not.toBeInTheDocument();
    expect(mockExecuteUserSpaceOperation).not.toHaveBeenCalled();
  });

  it("shows an explicit restore action without requesting permission during page load", async () => {
    mockSnapshot = {
      supported: true,
      mounts: [],
      indexing: {},
      recentOperations: [],
    };

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace]} />);

    const restoreButton = await screen.findByRole("button", { name: "恢复访问 Client Files" });
    expect(
      within(screen.getByTestId("user-space-mount-switcher")).getByRole("button", {
        name: "恢复访问 Client Files",
      }),
    ).toBe(restoreButton);
    expect(screen.queryByText(/Client Files 需要授权/)).not.toBeInTheDocument();
    expect(mockRestorePersistedUserSpace).not.toHaveBeenCalled();
    expect(mockExecuteUserSpaceOperation).not.toHaveBeenCalled();
  });

  it("does not switch away from the remembered root while another mount awaits authorization", async () => {
    const opsWorkspace = {
      mountId: "uw-ops",
      name: "Ops Files",
      rootName: "Ops Files",
      status: "mounted" as const,
      access: "readwrite" as const,
      includeHidden: true as const,
    };
    window.sessionStorage.setItem("piwork:user-space-active-mount:s1", "uw-ops");
    mockSnapshot = {
      supported: true,
      mounts: [opsWorkspace],
      indexing: {},
      recentOperations: [],
    };
    mockExecuteUserSpaceOperation.mockImplementation((_operation, input: { mountId?: string }) => {
      if (input.mountId === "uw-ops") {
        return Promise.resolve({
          entries: [{ name: "ops-only.md", path: "ops-only.md", kind: "file" as const, size: 9 }],
        });
      }
      return Promise.resolve({
        entries: [
          { name: "client-only.md", path: "client-only.md", kind: "file" as const, size: 9 },
        ],
      });
    });

    render(<UserSpaceExplorer sessionId="s1" mounts={[mountedWorkspace, opsWorkspace]} />);

    expect(screen.getByTestId("user-space-current-mount")).toHaveTextContent("Ops Files");
    expect(await screen.findByText("ops-only.md")).toBeInTheDocument();
    expect(mockRestorePersistedUserSpace).not.toHaveBeenCalled();
    expect(screen.getByTestId("user-space-current-mount")).toHaveTextContent("Ops Files");
    expect(screen.queryByText("client-only.md")).not.toBeInTheDocument();
  });

  it("shows an offline state when persisted permissions are settled as unavailable", async () => {
    mockSnapshot = {
      supported: true,
      mounts: [],
      indexing: {},
      recentOperations: [],
    };
    render(
      <UserSpaceExplorer sessionId="s1" mounts={[{ ...mountedWorkspace, status: "offline" }]} />,
    );

    const restoreButton = await screen.findByRole("button", { name: "恢复访问 Client Files" });
    expect(
      within(screen.getByTestId("user-space-mount-switcher")).getByRole("button", {
        name: "恢复访问 Client Files",
      }),
    ).toBe(restoreButton);
    expect(screen.queryByText(/Client Files 需要授权/)).not.toBeInTheDocument();
    expect(mockRestorePersistedUserSpace).not.toHaveBeenCalled();
    expect(mockExecuteUserSpaceOperation).not.toHaveBeenCalled();
  });

  it("requests persisted authorization from the explicit restore action", async () => {
    mockSnapshot = {
      supported: true,
      mounts: [],
      indexing: {},
      recentOperations: [],
    };
    mockRestorePersistedUserSpace.mockResolvedValueOnce(mountedWorkspace);

    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        persistenceScope={persistenceScope}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "恢复访问 Client Files" }));

    await waitFor(() =>
      expect(mockRestorePersistedUserSpace).toHaveBeenCalledWith(
        persistenceScope,
        expect.objectContaining({ mountId: "uw-mounted" }),
        { requestPermission: true },
      ),
    );
  });

  it("falls back to picking a directory from the restore action while preserving the mount id", async () => {
    const onMountsConfigured = vi.fn();
    mockSnapshot = {
      supported: true,
      mounts: [],
      indexing: {},
      recentOperations: [],
    };
    mockRestorePersistedUserSpace.mockResolvedValue({ ...mountedWorkspace, status: "offline" });
    mockRemountUserSpace.mockResolvedValue({
      ...mountedWorkspace,
      name: "Client Files",
      rootName: "Client Files",
      status: "mounted",
    });

    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        persistenceScope={persistenceScope}
        onMountsConfigured={onMountsConfigured}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "恢复访问 Client Files" }));

    await waitFor(() =>
      expect(mockRemountUserSpace).toHaveBeenCalledWith(
        expect.objectContaining({ mountId: "uw-mounted" }),
        expect.objectContaining({ onProgress: expect.any(Function) }),
      ),
    );
    expect(mockAttachUserSpaceMountsToSession).toHaveBeenCalledWith("s1", ["uw-mounted"]);
    expect(onMountsConfigured).toHaveBeenCalledWith([
      expect.objectContaining({ mountId: "uw-mounted", status: "mounted" }),
    ]);
  });

  it("does not open the directory picker after browser authorization is denied", async () => {
    mockSnapshot = {
      supported: true,
      mounts: [],
      indexing: {},
      recentOperations: [],
    };
    mockRestorePersistedUserSpace.mockResolvedValue({
      ...mountedWorkspace,
      status: "offline",
      permissionState: "denied",
    });

    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[mountedWorkspace]}
        persistenceScope={persistenceScope}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "恢复访问 Client Files" }));

    await waitFor(() =>
      expect(mockRestorePersistedUserSpace).toHaveBeenCalledWith(
        persistenceScope,
        expect.objectContaining({ mountId: "uw-mounted" }),
        { requestPermission: true },
      ),
    );
    expect(mockRemountUserSpace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "恢复访问 Client Files" })).toBeInTheDocument();
  });

  it("hides reauthorization controls while persisted permissions are restoring", () => {
    mockSnapshot = {
      supported: true,
      mounts: [],
      indexing: {},
      recentOperations: [],
    };

    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[{ ...mountedWorkspace, status: "offline" }]}
        workspaceRestoring
      />,
    );

    expect(screen.queryByText(/当前离线/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^恢复访问/ })).not.toBeInTheDocument();
    expect(screen.queryByText("读取目录...")).not.toBeInTheDocument();
    expect(mockExecuteUserSpaceOperation).not.toHaveBeenCalled();
  });

  it("authorizes an offline persisted directory only after the restore action", async () => {
    const onMountsConfigured = vi.fn();
    mockSnapshot = {
      supported: true,
      mounts: [],
      indexing: {},
      recentOperations: [],
    };

    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[{ ...mountedWorkspace, status: "offline" }]}
        persistenceScope={persistenceScope}
        onMountsConfigured={onMountsConfigured}
      />,
    );

    expect(mockRestorePersistedUserSpace).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "恢复访问 Client Files" }));
    await waitFor(() =>
      expect(mockRestorePersistedUserSpace).toHaveBeenCalledWith(
        persistenceScope,
        expect.objectContaining({ mountId: "uw-mounted" }),
        { requestPermission: true },
      ),
    );
    expect(mockMountUserSpace).not.toHaveBeenCalled();
    expect(mockAttachUserSpaceMountsToSession).toHaveBeenCalledWith("s1", ["uw-mounted"]);
    expect(onMountsConfigured).toHaveBeenCalledWith([
      expect.objectContaining({ mountId: "uw-mounted", status: "mounted" }),
    ]);
  });

  it("localizes the persisted-access recovery action in English", async () => {
    setUiCopyLanguage("en-US");
    mockSnapshot = {
      supported: true,
      mounts: [],
      indexing: {},
      recentOperations: [],
    };

    render(
      <UserSpaceExplorer
        sessionId="s1"
        mounts={[{ ...mountedWorkspace, status: "offline" }]}
        uiLanguage="en-US"
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Restore access to Client Files" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Needs access/)).not.toBeInTheDocument();
  });
});
