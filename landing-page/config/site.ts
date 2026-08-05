export type SiteConfig = typeof siteConfig;

export const siteConfig = {
  name: "piwork",
  description:
    "A local workspace for documents, spreadsheets, presentations, research, and everyday office work.",
  navItems: [
    {
      label: "Home",
      href: "/",
    },
    {
      label: "Docs",
      href: "/docs",
    },
    {
      label: "Pricing",
      href: "/pricing",
    },
    {
      label: "Blog",
      href: "/blog",
    },
    {
      label: "About",
      href: "/about",
    },
  ],
  links: {
    github: "https://github.com/agentbridges-ai/pi-work",
    twitter: "https://x.com/getpiwork",
    discord: "https://discord.gg/9Z7Ut4SG",
  },
};
