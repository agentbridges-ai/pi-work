import { relative, resolve } from "node:path";

export interface PwaAssetPolicy {
  filePath: string;
  contentType: string;
  cacheControl: string;
  serviceWorkerAllowed?: string;
}

const ROOT_ASSETS = new Map<string, Omit<PwaAssetPolicy, "filePath">>([
  [
    "/manifest.webmanifest",
    {
      contentType: "application/manifest+json; charset=utf-8",
      cacheControl: "no-cache, max-age=0, must-revalidate",
    },
  ],
  [
    "/piwork-sw.js",
    {
      contentType: "text/javascript; charset=utf-8",
      cacheControl: "no-cache, max-age=0, must-revalidate",
      serviceWorkerAllowed: "/",
    },
  ],
  [
    "/offline.html",
    {
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-cache, max-age=0, must-revalidate",
    },
  ],
  [
    "/favicon.svg",
    {
      contentType: "image/svg+xml",
      cacheControl: "public, max-age=86400",
    },
  ],
]);

function imageContentType(pathname: string): string | null {
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  return null;
}

export function resolvePwaAssetPolicy(root: string, pathname: string): PwaAssetPolicy | null {
  const rootPolicy = ROOT_ASSETS.get(pathname);
  const isImageCollection = pathname.startsWith("/icons/") || pathname.startsWith("/screenshots/");
  const imageType = isImageCollection ? imageContentType(pathname) : null;
  const policy =
    rootPolicy ||
    (imageType
      ? {
          contentType: imageType,
          cacheControl: "public, max-age=86400",
        }
      : null);
  if (!policy) return null;

  const resolvedRoot = resolve(root);
  const filePath = resolve(resolvedRoot, `.${pathname}`);
  const rel = relative(resolvedRoot, filePath);
  if (rel.startsWith("..") || rel === "" || rel.startsWith("/")) return null;
  return { filePath, ...policy };
}
