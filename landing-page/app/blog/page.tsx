import { ButtonLink } from "@piwork/ui";
import { PageHeader, PageLayout } from "@piwork/ui-patterns";

import { siteConfig } from "@/config/site";

export default function BlogPage() {
  return (
    <PageLayout
      className="py-[var(--piwork-space-8)] md:py-[var(--piwork-space-12)]"
      width="content"
    >
      <PageHeader
        description="No posts are published yet. Follow the project repository for current changes and release context."
        title="Project updates"
      />
      <div className="flex flex-wrap gap-2">
        <ButtonLink href={siteConfig.links.github} rel="noopener noreferrer" target="_blank">
          View updates on GitHub
        </ButtonLink>
      </div>
    </PageLayout>
  );
}
