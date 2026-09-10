import { useCallback, useState } from "react";

export type InterfaceMode = "standard" | "minimal";

const storageKey = "hatch.interface-mode";

export function readInterfaceMode(): InterfaceMode {
  try {
    return globalThis.localStorage.getItem(storageKey) === "standard" ? "standard" : "minimal";
  } catch {
    return "minimal";
  }
}

export function persistInterfaceMode(mode: InterfaceMode): boolean {
  try {
    globalThis.localStorage.setItem(storageKey, mode);
    return true;
  } catch {
    return false;
  }
}

export function useInterfaceMode() {
  const [mode, setCurrentMode] = useState<InterfaceMode>(readInterfaceMode);
  const [persistenceError, setPersistenceError] = useState(false);
  const setMode = useCallback((next: InterfaceMode) => {
    setCurrentMode(next);
    setPersistenceError(!persistInterfaceMode(next));
  }, []);

  return { mode, setMode, persistenceError } as const;
}
