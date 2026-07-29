import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { WebSocket as NodeWebSocket } from "ws";

interface BrowserFetchResult {
  status: number;
  body: unknown;
  text: string;
}

interface TestUser {
  name: string;
  email: string;
  password: string;
}

function uniqueUser(label: string): TestUser {
  return {
    name: `E2E ${label}`,
    email: `e2e-${label}-${randomUUID()}@example.test`,
    password: `Piwork-${randomUUID()}`,
  };
}

function serializeCookies(cookies: Awaited<ReturnType<BrowserContext["cookies"]>>): string {
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

async function browserFetch(
  page: Page,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<BrowserFetchResult> {
  return page.evaluate(
    async ({ requestPath, method, body }) => {
      const response = await fetch(requestPath, {
        method,
        credentials: "include",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return { status: response.status, body: parsed, text };
    },
    { requestPath: path, method: options.method || "GET", body: options.body },
  );
}

async function openApiPage(
  browser: Browser,
  baseURL: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const response = await page.goto("/api/auth/mode");
  expect(response?.status()).toBe(200);
  return { context, page };
}

async function register(page: Page, user: TestUser): Promise<void> {
  const response = await browserFetch(page, "/api/auth/sign-up/email", {
    method: "POST",
    body: user,
  });
  expect(response.status, response.text).toBe(200);
  const me = await browserFetch(page, "/api/me");
  expect(me.status, me.text).toBe(200);
  expect(me.body).toMatchObject({ user: { email: user.email } });
}

async function authorityLocalStorage(page: Page): Promise<Array<[string, string]>> {
  return page.evaluate(() =>
    Object.entries(localStorage).filter(([key, value]) => {
      const normalized = key.toLowerCase();
      return (
        /bearer|auth[_:-]?token|current[_:-]?session|session[_:-]?authority/.test(normalized) ||
        normalized.includes("digital-agent-session") ||
        normalized.includes("session-history") ||
        normalized.startsWith("piwork:user:") ||
        /^bearer\s/i.test(value)
      );
    }),
  );
}

async function websocketHandshakeStatus(
  url: string,
  options: { origin?: string; cookie?: string } = {},
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (value: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const socket = new NodeWebSocket(url, {
      headers: {
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
      },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new Error(`Timed out waiting for WebSocket handshake: ${url}`));
    }, 10_000);
    socket.once("open", () => {
      socket.close();
      finish(101);
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      finish(response.statusCode || 0);
    });
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function isApiResponse(response: { url(): string; request(): { method(): string } }, path: string) {
  return new URL(response.url()).pathname === path;
}

async function logoutThroughUserMenu(page: Page): Promise<void> {
  await page.getByTestId("user-avatar-button").click();
  const signOutResponse = page.waitForResponse(
    (response) =>
      isApiResponse(response, "/api/auth/sign-out") && response.request().method() === "POST",
  );
  await page.getByTestId("user-menu-logout-button").click();
  expect((await signOutResponse).status()).toBe(200);
  await expect(page.locator("#auth-email")).toBeVisible();
}

test("registration creates an HttpOnly cookie session that survives refresh and logout returns 401", async ({
  browser,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  const { context, page } = await openApiPage(browser, baseURL!);
  try {
    const user = uniqueUser("refresh");
    await register(page, user);

    const cookies = await context.cookies(baseURL!);
    const sessionCookie = cookies.find((cookie) => /session/i.test(cookie.name));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain(sessionCookie?.name || "");
    expect(await authorityLocalStorage(page)).toEqual([]);

    await page.reload({ waitUntil: "domcontentloaded" });
    const refreshedMe = await browserFetch(page, "/api/me");
    expect(refreshedMe.status, refreshedMe.text).toBe(200);
    expect(refreshedMe.body).toMatchObject({ user: { email: user.email } });

    const signOut = await browserFetch(page, "/api/auth/sign-out", {
      method: "POST",
      body: {},
    });
    expect(signOut.status, signOut.text).toBe(200);
    const loggedOutMe = await browserFetch(page, "/api/me");
    expect(loggedOutMe.status).toBe(401);
  } finally {
    await context.close();
  }
});

test("browser serves the OnlyOffice plugin asset without authentication", async ({
  request,
  baseURL,
}) => {
  const response = await request.get(`${baseURL}/onlyoffice-plugin/config.json`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ name: "Piwork Office Bridge" });
});

test("LoginPage registration and login perform real bootstrap and user-menu logout flows", async ({
  browser,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const user = uniqueUser("login-page");
  let fakeSessionSequence = 0;
  await page.routeWebSocket("**/ws/browser/**", (webSocket) => {
    webSocket.onMessage(() => {});
  });
  await page.route("**/api/sessions/create-stream", async (route) => {
    fakeSessionSequence += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({
        sessionId: `00000000-0000-4000-8000-${String(fakeSessionSequence).padStart(12, "0")}`,
        state: "running",
        cwd: "/tmp/piwork-e2e",
        backendType: "pi",
        transport: "pi-rpc",
        model: {
          key: "openai/e2e-model",
          provider: "openai",
          modelId: "e2e-model",
        },
        thinkingLevel: "medium",
        mode: "agent",
      })}\n\n`,
    });
  });

  try {
    await page.goto("/");
    await expect(page.locator("#auth-email")).toBeVisible();
    await page.getByRole("button", { name: /切换到注册|Switch to sign up/ }).click();
    await page.locator("#auth-name").fill(user.name);
    await page.locator("#auth-email").fill(user.email);
    await page.locator("#auth-password").fill(user.password);
    await page.locator("#auth-confirm-password").fill(user.password);

    const registrationBootstrap = page.waitForResponse(
      (response) =>
        isApiResponse(response, "/api/workspace/bootstrap") &&
        response.request().method() === "GET",
    );
    await page.locator('form button[type="submit"]').click();
    expect((await registrationBootstrap).status()).toBe(200);
    await expect(page.getByTestId("user-avatar-button")).toBeVisible({ timeout: 30_000 });
    await logoutThroughUserMenu(page);

    await page.locator("#auth-email").fill(user.email);
    await page.locator("#auth-password").fill(user.password);
    const loginBootstrap = page.waitForResponse(
      (response) =>
        isApiResponse(response, "/api/workspace/bootstrap") &&
        response.request().method() === "GET",
    );
    await page.locator('form button[type="submit"]').click();
    expect((await loginBootstrap).status()).toBe(200);
    await expect(page.getByTestId("user-avatar-button")).toBeVisible({ timeout: 30_000 });
    await logoutThroughUserMenu(page);

    const loggedOutMe = await browserFetch(page, "/api/me");
    expect(loggedOutMe.status).toBe(401);
    expect(fakeSessionSequence).toBe(2);
  } finally {
    await context.close();
  }
});

test("two BrowserContexts keep Cookie preferences isolated without localStorage authority", async ({
  browser,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  const first = await openApiPage(browser, baseURL!);
  const second = await openApiPage(browser, baseURL!);
  try {
    const firstUser = uniqueUser("first");
    const secondUser = uniqueUser("second");
    await register(first.page, firstUser);
    await register(second.page, secondUser);

    const firstPreferencesRequest = {
      userSpace: { showHiddenEntries: true, searchHiddenEntries: false },
    };
    const secondPreferences = {
      userSpace: { showHiddenEntries: false, searchHiddenEntries: true },
    };
    const firstWrite = await browserFetch(first.page, "/api/preferences", {
      method: "PUT",
      body: { preferences: firstPreferencesRequest },
    });
    const secondWrite = await browserFetch(second.page, "/api/preferences", {
      method: "PUT",
      body: { preferences: secondPreferences },
    });
    expect(firstWrite.status, firstWrite.text).toBe(200);
    expect(secondWrite.status, secondWrite.text).toBe(200);

    const firstRead = await browserFetch(first.page, "/api/preferences");
    const secondRead = await browserFetch(second.page, "/api/preferences");
    expect(firstRead.body).toMatchObject({
      preferences: {
        userSpace: { showHiddenEntries: true, searchHiddenEntries: true },
      },
    });
    expect(secondRead.body).toMatchObject({ preferences: secondPreferences });

    const firstCookies = await first.context.cookies(baseURL!);
    const secondCookies = await second.context.cookies(baseURL!);
    const firstSession = firstCookies.find((cookie) => /session/i.test(cookie.name));
    const secondSession = secondCookies.find((cookie) => /session/i.test(cookie.name));
    expect(firstSession?.value).toBeTruthy();
    expect(secondSession?.value).toBeTruthy();
    expect(firstSession?.value).not.toBe(secondSession?.value);
    expect(await authorityLocalStorage(first.page)).toEqual([]);
    expect(await authorityLocalStorage(second.page)).toEqual([]);
  } finally {
    await Promise.all([first.context.close(), second.context.close()]);
  }
});

test("unauthenticated workspace bootstrap and browser control are rejected", async ({
  browser,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  const { context, page } = await openApiPage(browser, baseURL!);
  try {
    const response = await browserFetch(page, "/api/workspace/bootstrap");
    expect(response.status).toBe(401);
    const browserControl = await browserFetch(
      page,
      `/api/sessions/${randomUUID()}/browser-control`,
    );
    expect(browserControl.status).toBe(401);
  } finally {
    await context.close();
  }
});

test("authenticated Cookie API and WebSocket entrypoints enforce Origin, media type, and size", async ({
  browser,
  request,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  const apiOrigin = process.env.BETTER_AUTH_URL || "http://127.0.0.1:3457";
  const trustedOrigin = new URL(baseURL!).origin;
  const foreignOrigin = "https://attacker.example";
  const endpoint = `${apiOrigin}/api/preferences`;
  const { context, page } = await openApiPage(browser, baseURL!);
  try {
    await register(page, uniqueUser("csrf"));
    const cookie = serializeCookies(await context.cookies(apiOrigin));
    expect(cookie).toMatch(/session/i);

    const authenticatedMe = await request.get(`${apiOrigin}/api/me`, {
      headers: { Cookie: cookie },
    });
    expect(authenticatedMe.status()).toBe(200);

    const sameOrigin = await browserFetch(page, "/api/preferences", {
      method: "PUT",
      body: {
        preferences: {
          userSpace: { showHiddenEntries: true, searchHiddenEntries: true },
        },
      },
    });
    expect(sameOrigin.status, sameOrigin.text).toBe(200);

    const missingOrigin = await request.put(endpoint, {
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      data: { preferences: {} },
    });
    expect(missingOrigin.status()).toBe(403);

    const foreignOriginResponse = await request.put(endpoint, {
      headers: { Cookie: cookie, Origin: foreignOrigin, "Content-Type": "application/json" },
      data: { preferences: {} },
    });
    expect(foreignOriginResponse.status()).toBe(403);

    const unsupportedType = await request.put(endpoint, {
      headers: { Cookie: cookie, Origin: trustedOrigin, "Content-Type": "text/plain" },
      data: "{}",
    });
    expect(unsupportedType.status()).toBe(415);

    const oversized = await request.put(endpoint, {
      headers: { Cookie: cookie, Origin: trustedOrigin, "Content-Type": "application/json" },
      data: `"${"x".repeat(1024 * 1024)}"`,
    });
    expect(oversized.status()).toBe(413);

    const missingOriginBrowserWs = await websocketHandshakeStatus(
      `${apiOrigin.replace(/^http/, "ws")}/ws/browser/${randomUUID()}`,
      { cookie },
    );
    const foreignOriginBrowserWs = await websocketHandshakeStatus(
      `${apiOrigin.replace(/^http/, "ws")}/ws/browser/${randomUUID()}`,
      { origin: foreignOrigin, cookie },
    );
    expect(missingOriginBrowserWs).toBe(403);
    expect(foreignOriginBrowserWs).toBe(403);
  } finally {
    await context.close();
  }
});
