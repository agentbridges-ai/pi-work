import { ButtonLink } from "@piwork/ui";
import { PageHeader, PageLayout } from "@piwork/ui-patterns";

import { GithubIcon } from "@/components/icons";
import { siteConfig } from "@/config/site";

export default function Home() {
  return (
    <PageLayout className="justify-center py-16 md:py-24" width="content">
      <PageHeader
        actions={
          <>
            <ButtonLink href={siteConfig.links.twitter} rel="noopener noreferrer" target="_blank">
              Follow us on X
            </ButtonLink>
            <ButtonLink
              href={siteConfig.links.github}
              rel="noopener noreferrer"
              target="_blank"
              variant="secondary"
            >
              <GithubIcon aria-hidden="true" size={20} />
              GitHub
            </ButtonLink>
          </>
        }
        description="一站式 Paperwork Agent 工作台"
        eyebrow="Piwork"
        title="All-in-One Paperwork Agent Workspace"
      />

      <section className="rounded-[var(--piwork-panel-radius)] border border-border bg-card p-4">
        <pre className="overflow-x-auto text-sm font-medium">
          Get started by editing{" "}
          <code className="inline h-fit whitespace-nowrap rounded-[var(--piwork-control-radius)] bg-muted px-2 py-1 font-mono text-sm font-normal text-foreground">
            app/page.tsx
          </code>
        </pre>
      </section>
    </PageLayout>
  );
}
