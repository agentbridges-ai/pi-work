import { createAuthClient } from "better-auth/react";

function getAuthBaseURL(): string {
  if (typeof window === "undefined") return "http://localhost";
  if (window.location.origin) return window.location.origin;
  if (window.location.protocol && window.location.host) {
    return `${window.location.protocol}//${window.location.host}`;
  }
  return "http://localhost";
}

export const authClient = createAuthClient({
  baseURL: getAuthBaseURL(),
});
