import { ButtonLink } from "@piwork/ui";
import { PageHeader, PageLayout } from "@piwork/ui-patterns";

import { GithubIcon } from "@/components/icons";
import { siteConfig } from "@/config/site";

export default function Home() {
  return (
    <PageLayout
      className="gap-[var(--piwork-space-12)] py-[var(--piwork-space-8)] md:py-[var(--piwork-space-12)]"
      width="wide"
    >
      <PageHeader
        actions={
          <>
            <ButtonLink href={siteConfig.links.github} rel="noopener noreferrer" target="_blank">
              <GithubIcon aria-hidden="true" size={20} />
              View the project
            </ButtonLink>
            <ButtonLink
              href={siteConfig.links.twitter}
              rel="noopener noreferrer"
              target="_blank"
              variant="secondary"
            >
              Follow updates
            </ButtonLink>
          </>
        }
        description="文档、表格、演示文稿与资料处理，集中在一个隔离的 Agent 工作台中。"
        eyebrow="Piwork workspace"
        title="Keep paperwork work in one place"
      />

      <section
        aria-labelledby="workspace-principles-heading"
        className="grid min-w-0 gap-[var(--piwork-space-8)] lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]"
      >
        <div className="min-w-0 max-w-xl">
          <h2
            className="text-[length:var(--piwork-text-title-size)] font-semibold leading-[var(--piwork-text-title-line-height)] text-foreground"
            id="workspace-principles-heading"
          >
            The work and the result stay together.
          </h2>
          <p className="mt-[var(--piwork-space-3)] max-w-prose text-base leading-6 text-muted-foreground">
            Start with a task, keep its context in the session, and finish with files you can find
            and use.
          </p>
        </div>

        <ul className="grid min-w-0 gap-[var(--piwork-space-6)] sm:grid-cols-3">
          <li className="min-w-0">
            <h3 className="text-base font-semibold leading-6 text-foreground">
              Start with the work
            </h3>
            <p className="mt-[var(--piwork-space-2)] text-sm leading-5 text-muted-foreground">
              Describe a paperwork task and keep the conversation, files, and result in one session.
            </p>
          </li>
          <li className="min-w-0">
            <h3 className="text-base font-semibold leading-6 text-foreground">
              Work with documents
            </h3>
            <p className="mt-[var(--piwork-space-2)] text-sm leading-5 text-muted-foreground">
              Read, write, edit, and inspect browser-authorized User Space files without exposing a
              host path.
            </p>
          </li>
          <li className="min-w-0">
            <h3 className="text-base font-semibold leading-6 text-foreground">
              Keep sessions separate
            </h3>
            <p className="mt-[var(--piwork-space-2)] text-sm leading-5 text-muted-foreground">
              Each session keeps its workspace, history, and recordings within its own boundary.
            </p>
          </li>
        </ul>
      </section>
    </PageLayout>
  );
}
