// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Circle } from "lucide-react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import {
  Alert,
  AppShell,
  Button,
  ButtonLink,
  Dialog,
  DropdownMotion,
  EmptyState,
  IconButton,
  Panel,
  ScrollArea,
  SegmentedControl,
  Sheet,
  Skeleton,
  StatusBadge,
  Switch,
  Tabs,
  TextArea,
  TextField,
  Toolbar,
} from "./index.js";

describe("Piwork UI primitives", () => {
  it("keeps dropdown content mounted for the shared exit animation", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <DropdownMotion open placement="top" data-testid="dropdown">
          Options
        </DropdownMotion>,
      );
      expect(screen.getByTestId("dropdown")).toHaveAttribute("data-entering", "true");

      rerender(
        <DropdownMotion open={false} placement="top" data-testid="dropdown">
          Options
        </DropdownMotion>,
      );
      expect(screen.getByTestId("dropdown")).toHaveAttribute("data-exiting", "true");
      expect(screen.getByTestId("dropdown")).toHaveAttribute("aria-hidden", "true");

      rerender(
        <DropdownMotion open placement="top" data-testid="dropdown">
          Options
        </DropdownMotion>,
      );
      expect(screen.getByTestId("dropdown")).not.toHaveAttribute("data-entering");
      expect(screen.getByTestId("dropdown")).not.toHaveAttribute("data-exiting");

      rerender(
        <DropdownMotion open={false} placement="top" data-testid="dropdown">
          Options
        </DropdownMotion>,
      );

      act(() => vi.advanceTimersByTime(100));
      expect(screen.queryByTestId("dropdown")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes accessible button loading and icon-only states", async () => {
    const onPress = vi.fn();
    const { container } = render(
      <div>
        <Button loading onPress={onPress}>
          Save changes
        </Button>
        <IconButton label="Open options" variant="ghost">
          <Circle aria-hidden="true" />
        </IconButton>
      </div>,
    );

    const loadingButton = screen.getByRole("button", { name: "Save changes" });
    expect(loadingButton).toBeDisabled();
    expect(loadingButton).toHaveAttribute("data-pending", "true");
    expect(screen.getByRole("button", { name: "Open options" })).toBeEnabled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shares semantic button styling with navigational actions", async () => {
    const { container } = render(
      <ButtonLink href="/docs" variant="secondary">
        Read docs
      </ButtonLink>,
    );

    expect(screen.getByRole("link", { name: "Read docs" })).toHaveAttribute("href", "/docs");
    expect(screen.getByRole("link", { name: "Read docs" })).toHaveClass(
      "bg-card",
      "text-foreground",
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("associates field labels, descriptions, and errors", async () => {
    const { container } = render(
      <div>
        <TextField
          description="Used for account recovery"
          error="Enter a valid address"
          inputProps={{ type: "email" }}
          label="Email address"
          value="invalid"
        />
        <TextArea
          description="Keep this concise"
          label="Summary"
          textAreaProps={{ rows: 3 }}
          value="Draft"
        />
      </div>,
    );

    const input = screen.getByRole("textbox", { name: "Email address" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Used for account recovery Enter a valid address");
    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveAccessibleDescription(
      "Keep this concise",
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("traps dialog focus, supports initial focus and Escape, then restores focus", async () => {
    const user = userEvent.setup();

    function DialogHarness() {
      const [isOpen, setIsOpen] = useState(false);
      const initialFocusRef = useRef<HTMLInputElement>(null);
      return (
        <>
          <button type="button" onClick={() => setIsOpen(true)}>
            Open dialog
          </button>
          <Dialog
            closeLabel="Close dialog"
            description="Dialog description"
            initialFocusRef={initialFocusRef}
            isOpen={isOpen}
            onOpenChange={setIsOpen}
            title="Dialog title"
          >
            <input ref={initialFocusRef} aria-label="Initial field" />
            <button type="button">Last action</button>
          </Dialog>
        </>
      );
    }

    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Dialog title" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveClass(
      "bg-transparent!",
      "hover:bg-transparent!",
    );
    expect(await axe(dialog)).toHaveNoViolations();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Initial field" })).toHaveFocus(),
    );

    await user.tab();
    expect(screen.getByRole("button", { name: "Last action" })).toHaveFocus();
    await user.tab();
    await waitFor(() => expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus());
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Initial field" })).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps dialog footers on the same surface as the dialog body", async () => {
    render(
      <Dialog
        closeLabel="Close dialog"
        footer={<button type="button">Footer action</button>}
        isOpen
        onOpenChange={vi.fn()}
        title="Dialog title"
      >
        Dialog body
      </Dialog>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Dialog title" });
    expect(dialog.querySelector('[data-slot="modal-footer"]')).toHaveClass(
      "border-t",
      "border-border",
      "bg-card",
    );
    expect(dialog.querySelector('[data-slot="modal-footer"]')).not.toHaveClass("bg-muted");
  });

  it("gives sheets modal semantics and Escape dismissal", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Sheet
        closeLabel="Close settings"
        description="Application preferences"
        isOpen
        onOpenChange={onOpenChange}
        title="Settings"
      >
        <Button>Save settings</Button>
      </Sheet>,
    );

    const sheet = await screen.findByRole("dialog", { name: "Settings" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(await axe(sheet)).toHaveNoViolations();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("provides selected semantics and keyboard navigation for segmented controls and tabs", async () => {
    const user = userEvent.setup();

    function SelectionHarness() {
      const [segment, setSegment] = useState("workspace");
      const [tab, setTab] = useState("overview");
      return (
        <div>
          <SegmentedControl
            ariaLabel="Workbench view"
            items={[
              { id: "workspace", label: "Workspace" },
              { id: "conversation", label: "Conversation" },
            ]}
            onChange={setSegment}
            value={segment}
          />
          <Tabs
            ariaLabel="Settings sections"
            items={[
              { id: "overview", label: "Overview", content: <p>Overview content</p> },
              { id: "details", label: "Details", content: <p>Details content</p> },
            ]}
            onSelectionChange={setTab}
            selectedKey={tab}
          />
        </div>
      );
    }

    const { container } = render(<SelectionHarness />);
    const workspace = screen.getByRole("radio", { name: "Workspace" });
    const conversation = screen.getByRole("radio", { name: "Conversation" });
    expect(workspace).toBeChecked();
    expect(conversation).not.toBeChecked();
    expect(workspace).toHaveAttribute("tabindex", "0");
    expect(conversation).toHaveAttribute("tabindex", "-1");

    workspace.focus();
    await user.keyboard("{ArrowRight}");
    expect(conversation).toHaveFocus();
    await user.keyboard(" ");
    await waitFor(() => expect(conversation).toBeChecked());
    expect(conversation).toHaveAttribute("tabindex", "0");

    const overview = screen.getByRole("tab", { name: "Overview" });
    overview.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Details content")).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("keeps equal-width segment geometry stable between hover and selection", () => {
    render(
      <SegmentedControl
        ariaLabel="Appearance"
        isEqualWidth
        size="sm"
        items={[
          { id: "system", label: "System" },
          { id: "light", label: "Light" },
          { id: "dark", label: "Dark" },
        ]}
        onChange={vi.fn()}
        value="system"
      />,
    );

    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toHaveClass(
      "gap-[3px]",
      "bg-surface-weak",
      "p-0.5",
    );
    for (const option of screen.getAllByRole("radio")) {
      const segment = option.closest('[data-slot="radio"]');
      expect(segment).toHaveClass(
        "h-7",
        "min-w-7",
        "px-2",
        "text-xs",
        "flex-1",
        "basis-0",
        "hover:bg-card",
        "data-[selected]:bg-card",
      );
      expect(segment).not.toHaveClass("border");
      expect(segment).not.toHaveClass("data-[selected]:border");
    }
    const selectedSegment = screen
      .getByRole("radio", { name: "System" })
      .closest('[data-slot="radio"]');
    expect(selectedSegment).not.toHaveClass("border");
    expect(selectedSegment?.className).not.toContain("data-[selected]:outline");
  });

  it("uses the roomier medium segmented-control geometry", () => {
    render(
      <SegmentedControl
        ariaLabel="Language"
        isEqualWidth
        size="md"
        items={[
          { id: "zh-CN", label: "简体中文" },
          { id: "en-US", label: "English" },
        ]}
        onChange={vi.fn()}
        value="zh-CN"
      />,
    );

    expect(screen.getByRole("radiogroup", { name: "Language" })).toHaveClass(
      "gap-[5px]",
      "p-1",
      "rounded-[var(--piwork-panel-radius)]",
    );
    for (const option of screen.getAllByRole("radio")) {
      expect(option.closest('[data-slot="radio"]')).toHaveClass(
        "h-8",
        "min-w-8",
        "px-3",
        "text-sm",
        "flex-1",
        "basis-0",
      );
    }
  });

  it("renders named layout, feedback, loading, switch, and sheet primitives without axe violations", async () => {
    const { container } = render(
      <AppShell>
        <Panel label="Workbench panel">
          <Toolbar label="File actions">
            <Button size="sm">Create file</Button>
          </Toolbar>
          <ScrollArea label="Recent files">
            <Alert status="success" title="Directory ready" />
            <StatusBadge status="info">Indexing</StatusBadge>
            <Switch description="Apply changes immediately" label="Live updates" />
            <EmptyState description="Create a file to begin" title="No files" />
            <Skeleton className="h-8 w-full" label="Loading files" />
          </ScrollArea>
        </Panel>
        <Sheet closeLabel="Close settings" isOpen={false} onOpenChange={vi.fn()} title="Settings">
          <p>Settings content</p>
        </Sheet>
      </AppShell>,
    );

    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("region", { name: "Recent files" })).toHaveAttribute("tabindex", "0");
    expect(container.querySelector('[data-slot="alert-root"]')).toHaveClass("bg-success-muted");
    expect(container.querySelector('[data-slot="alert-description"]')).toBeNull();
    expect(screen.getByRole("switch", { name: "Live updates" })).toHaveAccessibleDescription(
      "Apply changes immediately",
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
