import { ButtonLink } from "@piwork/ui";
import { PageHeader, PageLayout } from "@piwork/ui-patterns";

import { siteConfig } from "@/config/site";

export default function PricingPage() {
  return (
    <PageLayout
      className="py-[var(--piwork-space-8)] md:py-[var(--piwork-space-12)]"
      width="content"
    >
      <PageHeader
        description="We have not published plans or pricing yet. Follow the project for the next update."
        title="Pricing is not published yet"
      />
      <div className="flex flex-wrap gap-2">
        <ButtonLink href={siteConfig.links.github} rel="noopener noreferrer" target="_blank">
          Follow the project on GitHub
        </ButtonLink>
      </div>
    </PageLayout>
  );
}
