import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCtlCommand } from "../bin/ctl.js";

const previousPort = process.env.PORT;

afterEach(() => {
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
  vi.restoreAllMocks();
});

describe("management CLI", () => {
  it("uses PORT when no --port override is provided", async () => {
    process.env.PORT = "4567";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await handleCtlCommand("status", []);

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4567/api/sessions");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4567/api/backends");
  });
});
