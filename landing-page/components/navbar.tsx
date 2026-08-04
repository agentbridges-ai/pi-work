"use client";

import { useState } from "react";
import NextLink from "next/link";
import Image from "next/image";
import clsx from "clsx";
import { Button, IconButton, TextField } from "@piwork/ui";

import { siteConfig } from "@/config/site";
import { ThemeSwitch } from "@/components/theme-switch";
import {
  TwitterIcon,
  GithubIcon,
  DiscordIcon,
  HeartFilledIcon,
  SearchIcon,
} from "@/components/icons";

export const Navbar = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const searchInput = (
    <div className="relative min-w-56">
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 z-[var(--piwork-z-base)] -translate-y-1/2 text-base text-muted-foreground" />
      <TextField
        inputClassName="pl-9 pr-12"
        inputProps={{ placeholder: "Search...", type: "search" }}
        label="Search"
        labelClassName="sr-only"
      />
      <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-[var(--piwork-control-radius)] border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground lg:inline-flex">
        ⌘K
      </kbd>
    </div>
  );

  return (
    <nav className="sticky top-0 z-[var(--piwork-z-sticky)] w-full border-b border-border bg-background">
      <header className="mx-auto flex h-16 max-w-[1280px] items-center justify-between gap-4 px-6">
        <div className="flex items-center gap-4">
          <NextLink className="flex items-center gap-1" href="/">
            <Image
              alt="piwork"
              className="h-7 w-auto dark:hidden"
              height={28}
              src="/piwork-light.svg"
              width={97}
            />
            <Image
              alt="piwork"
              className="hidden h-7 w-auto dark:block"
              height={28}
              src="/piwork-dark.svg"
              width={97}
            />
          </NextLink>
          <ul className="hidden lg:flex gap-4 ml-2">
            {siteConfig.navItems.map((item) => (
              <li key={item.href}>
                <NextLink
                  className={clsx(
                    "text-foreground hover:text-accent transition-colors",
                    "data-[active=true]:text-accent data-[active=true]:font-medium",
                  )}
                  href={item.href}
                >
                  {item.label}
                </NextLink>
              </li>
            ))}
          </ul>
        </div>

        <div className="hidden sm:flex items-center gap-2">
          <a
            aria-label="Twitter"
            className="rounded-[var(--piwork-control-radius)] p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            href={siteConfig.links.twitter}
            rel="noopener noreferrer"
            target="_blank"
          >
            <TwitterIcon className="text-muted" />
          </a>
          <a
            aria-label="Discord"
            className="rounded-[var(--piwork-control-radius)] p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            href={siteConfig.links.discord}
            rel="noopener noreferrer"
            target="_blank"
          >
            <DiscordIcon className="text-muted" />
          </a>
          <a
            aria-label="Github"
            className="rounded-[var(--piwork-control-radius)] p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            href={siteConfig.links.github}
            rel="noopener noreferrer"
            target="_blank"
          >
            <GithubIcon className="text-muted" />
          </a>
          <ThemeSwitch />
          <div className="hidden lg:flex">{searchInput}</div>
          <div className="hidden md:flex">
            <Button
              className="text-sm font-normal"
              variant="tertiary"
              onPress={() => window.open(siteConfig.links.twitter, "_blank")}
            >
              <HeartFilledIcon className="text-danger" />
              Follow us
            </Button>
          </div>
        </div>

        <div className="flex sm:hidden items-center gap-2">
          <a
            aria-label="Github"
            className="rounded-[var(--piwork-control-radius)] p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            href={siteConfig.links.github}
            rel="noopener noreferrer"
            target="_blank"
          >
            <GithubIcon className="text-muted" />
          </a>
          <ThemeSwitch />
          <IconButton
            aria-expanded={isMenuOpen}
            label="Toggle menu"
            size="sm"
            variant="ghost"
            onPress={() => setIsMenuOpen(!isMenuOpen)}
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isMenuOpen ? (
                <path
                  d="M6 18L18 6M6 6l12 12"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                />
              ) : (
                <path
                  d="M4 6h16M4 12h16M4 18h16"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                />
              )}
            </svg>
          </IconButton>
        </div>
      </header>

      {isMenuOpen && (
        <div className="border-t border-separator sm:hidden">
          <div className="p-4">{searchInput}</div>
          <ul className="flex flex-col gap-2 px-4 pb-4">
            {siteConfig.navItems.map((item) => (
              <li key={item.href}>
                <NextLink
                  className="block py-2 text-lg text-foreground no-underline transition-colors hover:text-accent"
                  href={item.href}
                  onClick={() => setIsMenuOpen(false)}
                >
                  {item.label}
                </NextLink>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
};
