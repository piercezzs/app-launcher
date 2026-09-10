import { afterEach, describe, expect, it, vi } from "vitest";
import { persistInterfaceMode, readInterfaceMode } from "./interface-mode";

afterEach(() => vi.unstubAllGlobals());

describe("device-local interface mode", () => {
  it("restores a saved minimal choice and can return to standard", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    });
    expect(readInterfaceMode()).toBe("minimal");
    expect(persistInterfaceMode("minimal")).toBe(true);
    expect(values.get("hatch.interface-mode")).toBe("minimal");
    expect(readInterfaceMode()).toBe("minimal");
    expect(persistInterfaceMode("standard")).toBe(true);
    expect(readInterfaceMode()).toBe("standard");
  });

  it("falls back to minimal for invalid or inaccessible storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => "unexpected-mode" });
    expect(readInterfaceMode()).toBe("minimal");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); } });
    expect(readInterfaceMode()).toBe("minimal");
    vi.stubGlobal("localStorage", undefined);
    expect(readInterfaceMode()).toBe("minimal");
  });

  it("reports failed persistence without throwing so the current session can still switch", () => {
    vi.stubGlobal("localStorage", { setItem: () => { throw new Error("quota exceeded"); } });
    expect(persistInterfaceMode("minimal")).toBe(false);
    vi.stubGlobal("localStorage", undefined);
    expect(persistInterfaceMode("standard")).toBe(false);
  });
});
