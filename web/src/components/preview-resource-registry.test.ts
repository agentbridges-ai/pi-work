import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewResourceRegistry } from "./preview-resource-registry.js";

describe("previewResourceRegistry", () => {
  beforeEach(() => {
    let nextId = 0;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => `blob:http://localhost/${++nextId}`),
      revokeObjectURL: vi.fn(),
    });
    previewResourceRegistry.revokeAll();
    vi.clearAllMocks();
  });

  afterEach(() => {
    previewResourceRegistry.revokeAll();
    vi.unstubAllGlobals();
  });

  it("tracks created preview URLs and revokes them exactly once", () => {
    const first = previewResourceRegistry.create(new Blob(["alpha"]));
    const second = previewResourceRegistry.create(new Blob(["beta"]));

    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(previewResourceRegistry.size).toBe(2);

    previewResourceRegistry.revoke(first);
    previewResourceRegistry.revoke(first);
    previewResourceRegistry.revoke(second);

    expect(URL.revokeObjectURL).toHaveBeenNthCalledWith(1, first);
    expect(URL.revokeObjectURL).toHaveBeenNthCalledWith(2, second);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(previewResourceRegistry.size).toBe(0);
  });

  it("revokeAll releases every tracked URL after repeated preview churn", () => {
    const urls = Array.from({ length: 100 }, (_, index) =>
      previewResourceRegistry.create(new Blob([`preview-${index}`])),
    );

    expect(previewResourceRegistry.size).toBe(100);

    previewResourceRegistry.revokeAll();

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(100);
    for (const url of urls) expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
    expect(previewResourceRegistry.size).toBe(0);
  });
});
