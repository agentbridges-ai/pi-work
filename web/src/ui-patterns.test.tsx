// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import {
  FilterBar,
  FormSection,
  PageHeader,
  PageLayout,
} from "../../packages/ui-patterns/src/index.js";

describe("Piwork UI patterns", () => {
  it("composes a consistently labelled management page", async () => {
    const { container } = render(
      <PageLayout width="content">
        <PageHeader
          actions={<button type="button">Create</button>}
          description="Manage workspace members"
          eyebrow="Administration"
          title="Members"
        />
        <FilterBar actions={<button type="button">Reset</button>} label="Member filters">
          <label>
            Search
            <input type="search" />
          </label>
        </FilterBar>
        <FormSection
          actions={<button type="submit">Save</button>}
          description="Default access for new members"
          title="Permissions"
        >
          <label>
            Role
            <select defaultValue="editor">
              <option value="editor">Editor</option>
            </select>
          </label>
        </FormSection>
      </PageLayout>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
    expect(screen.getByRole("search", { name: "Member filters" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Permissions" })).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });
});
