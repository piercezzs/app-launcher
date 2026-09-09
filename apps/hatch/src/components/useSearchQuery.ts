import { useEffect, useRef, useState } from "react";

const SEARCH_DELAY_MS = 200;

/** Keep typing local to the toolbar; only committed queries update the catalog. */
export function useSearchQuery(query: string, onCommit: (value: string) => void, context: string) {
  const [draft, setDraft] = useState(query);
  const draftRef = useRef(query);
  const lastCommit = useRef(query);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  function cancel() {
    clearTimeout(timer.current);
    timer.current = undefined;
  }

  function commit(value: string) {
    cancel();
    lastCommit.current = value;
    commitRef.current(value);
  }

  function change(value: string) {
    draftRef.current = value;
    setDraft(value);
    cancel();
    if (composing.current) return;
    if (!value.trim()) commit(value);
    else timer.current = setTimeout(() => commit(value), SEARCH_DELAY_MS);
  }

  function compositionStart() {
    composing.current = true;
    cancel();
  }

  function compositionEnd(value: string) {
    composing.current = false;
    change(value);
  }

  function flush() {
    if (!composing.current) commit(draftRef.current);
  }

  function clear() {
    composing.current = false;
    draftRef.current = "";
    setDraft("");
    commit("");
  }

  // An external reset must cancel old work; our own commit must not erase newer typing.
  useEffect(() => {
    if (query === lastCommit.current) return;
    cancel();
    composing.current = false;
    draftRef.current = query;
    lastCommit.current = query;
    setDraft(query);
  }, [query]);

  // Category and sort changes immediately use the current completed draft.
  useEffect(() => { flush(); }, [context]);
  useEffect(() => () => clearTimeout(timer.current), []);

  return { draft, change, compositionStart, compositionEnd, flush, clear };
}
