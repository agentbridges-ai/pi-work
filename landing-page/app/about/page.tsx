import { ButtonLink } from "@piwork/ui";
import { PageHeader, PageLayout } from "@piwork/ui-patterns";

import { siteConfig } from "@/config/site";

export default function AboutPage() {
  return (
    <PageLayout
      className="py-[var(--piwork-space-8)] md:py-[var(--piwork-space-12)]"
      width="content"
    >
      <PageHeader
        description="Piwork is a local multi-user Agent workbench for documents, spreadsheets, presentations, research, and everyday office work."
        title="A local workspace for paperwork"
      />
      <section
        aria-labelledby="about-boundary-heading"
        className="grid gap-[var(--piwork-space-3)]"
      >
        <h2
          className="text-[length:var(--piwork-text-title-size)] font-semibold leading-[var(--piwork-text-title-line-height)] text-foreground"
          id="about-boundary-heading"
        >
          Built around the work, not a developer dashboard
        </h2>
        <p className="text-base leading-6 text-muted-foreground">
          The Agent works inside an isolated session workspace. User Space remains a
          browser-authorized place for files and documents, while the product keeps authentication,
          session history, and runtime boundaries explicit.
        </p>
        <div className="flex flex-wrap gap-2 pt-[var(--piwork-space-2)]">
          <ButtonLink href={siteConfig.links.github} rel="noopener noreferrer" target="_blank">
            Read the project
          </ButtonLink>
          <ButtonLink
            href={siteConfig.links.discord}
            rel="noopener noreferrer"
            target="_blank"
            variant="secondary"
          >
            Join the community
          </ButtonLink>
        </div>
      </section>
    </PageLayout>
  );
}
