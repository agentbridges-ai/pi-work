import { PageHeader, PageLayout } from "@piwork/ui-patterns";

export default function DocsPage() {
  return (
    <PageLayout
      className="py-[var(--piwork-space-8)] md:py-[var(--piwork-space-12)]"
      width="content"
    >
      <PageHeader
        description="A short guide to the product surface and the boundaries that keep each session focused."
        title="Understand the workspace"
      />
      <section aria-labelledby="docs-flow-heading" className="grid gap-[var(--piwork-space-6)]">
        <h2
          className="text-[length:var(--piwork-text-title-size)] font-semibold leading-[var(--piwork-text-title-line-height)] text-foreground"
          id="docs-flow-heading"
        >
          A simple path through the work
        </h2>
        <ol className="grid gap-[var(--piwork-space-6)] sm:grid-cols-3">
          <li>
            <h3 className="text-base font-semibold leading-6 text-foreground">Sign in</h3>
            <p className="mt-[var(--piwork-space-2)] text-sm leading-5 text-muted-foreground">
              Create an account or sign in with email and password before starting a session.
            </p>
          </li>
          <li>
            <h3 className="text-base font-semibold leading-6 text-foreground">Start a session</h3>
            <p className="mt-[var(--piwork-space-2)] text-sm leading-5 text-muted-foreground">
              Give the Agent a paperwork task and keep its conversation, plan, and result together.
            </p>
          </li>
          <li>
            <h3 className="text-base font-semibold leading-6 text-foreground">Work with files</h3>
            <p className="mt-[var(--piwork-space-2)] text-sm leading-5 text-muted-foreground">
              Use User Space to read, write, edit, and inspect files through the browser-authorized
              workspace.
            </p>
          </li>
        </ol>
      </section>
    </PageLayout>
  );
}
