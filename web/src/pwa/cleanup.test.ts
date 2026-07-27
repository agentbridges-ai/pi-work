import { describe, expect, it, vi } from "vitest";
import { cleanupPiworkPwa } from "./cleanup.js";

function registration(pathname: string) {
  return {
    active: { scriptURL: `https://piwork.example${pathname}` },
    waiting: null,
    installing: null,
    unregister: vi.fn(async () => true),
  } as unknown as ServiceWorkerRegistration;
}

describe("cleanupPiworkPwa", () => {
  it("removes only legacy Piwork workers and named legacy caches by default", async () => {
    const legacy = registration("/sw.js");
    const current = registration("/piwork-sw.js");
    const unrelated = registration("/another-product-sw.js");
    const deleteCache = vi.fn(async () => true);
    const windowObject = {
      location: { hostname: "piwork.example" },
      caches: {
        keys: vi.fn(async () => [
          "piwork-app-shell-v0",
          "piwork-pwa-offline-v1",
          "another-product-cache",
        ]),
        delete: deleteCache,
      },
    } as unknown as Window;
    const navigatorObject = {
      serviceWorker: {
        getRegistrations: vi.fn(async () => [legacy, current, unrelated]),
      },
    } as unknown as Navigator;

    await cleanupPiworkPwa({}, windowObject, navigatorObject);

    expect(legacy.unregister).toHaveBeenCalledOnce();
    expect(current.unregister).not.toHaveBeenCalled();
    expect(unrelated.unregister).not.toHaveBeenCalled();
    expect(deleteCache).toHaveBeenCalledTimes(1);
    expect(deleteCache).toHaveBeenCalledWith("piwork-app-shell-v0");
  });

  it("removes current Piwork state without touching other products", async () => {
    const current = registration("/piwork-sw.js");
    const unrelated = registration("/another-product-sw.js");
    const deleteCache = vi.fn(async () => true);
    const windowObject = {
      location: { hostname: "piwork.example" },
      caches: {
        keys: vi.fn(async () => ["piwork-pwa-offline-v1", "another-product-cache"]),
        delete: deleteCache,
      },
    } as unknown as Window;
    const navigatorObject = {
      serviceWorker: { getRegistrations: vi.fn(async () => [current, unrelated]) },
    } as unknown as Navigator;

    await cleanupPiworkPwa({ includeCurrent: true }, windowObject, navigatorObject);

    expect(current.unregister).toHaveBeenCalledOnce();
    expect(unrelated.unregister).not.toHaveBeenCalled();
    expect(deleteCache).toHaveBeenCalledWith("piwork-pwa-offline-v1");
    expect(deleteCache).not.toHaveBeenCalledWith("another-product-cache");
  });

  it("never treats the OnlyOffice host /sw.js as a legacy app worker", async () => {
    const officeWorker = registration("/sw.js");
    const windowObject = {
      location: { hostname: "session.office-host.piwork.example" },
    } as unknown as Window;
    const navigatorObject = {
      serviceWorker: { getRegistrations: vi.fn(async () => [officeWorker]) },
    } as unknown as Navigator;

    await cleanupPiworkPwa({}, windowObject, navigatorObject);

    expect(officeWorker.unregister).not.toHaveBeenCalled();
  });
});
