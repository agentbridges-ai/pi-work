"use client";

import { useEffect } from "react";

export function Favicon() {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[data-site-favicon="true"]');

    if (!link) {
      return;
    }

    const updateFavicon = () => {
      const isDark = document.documentElement.classList.contains("dark");

      link.href = isDark ? "/favicon-dark.png" : "/favicon.png";
    };

    updateFavicon();
    const observer = new MutationObserver(updateFavicon);

    observer.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });

    return () => observer.disconnect();
  }, []);

  return <link data-site-favicon="true" href="/favicon.png" rel="icon" />;
}
