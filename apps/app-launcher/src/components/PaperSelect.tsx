import { Check } from "@tessera/ui";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

export interface PaperSelectOption {
  readonly value: string;
  readonly label: string;
}

interface PaperSelectProps {
  readonly value: string;
  readonly options: readonly PaperSelectOption[];
  readonly ariaLabelledBy: string;
  readonly disabled?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onValueChange: (value: string) => void;
}

type Placement = "above" | "below";

const LIST_GAP = 6;
const LIST_MAX_HEIGHT = 168;
const LIST_BORDER_HEIGHT = 2;
const LIST_COLLISION_CLEARANCE = 14;

export function PaperSelect({
  value,
  options,
  ariaLabelledBy,
  disabled = false,
  onOpenChange,
  onValueChange,
}: PaperSelectProps) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>("below");
  const [listMaxHeight, setListMaxHeight] = useState(LIST_MAX_HEIGHT);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selectedOption = options[selectedIndex];

  function updateOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }

  function close({ restoreFocus = false } = {}) {
    updateOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    onValueChange(option.value);
    close({ restoreFocus: true });
  }

  function openList() {
    if (disabled || options.length === 0) return;
    setActiveIndex(selectedIndex);
    updateOpen(true);
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openList();
    }
  }

  function handleEscapeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close({ restoreFocus: true });
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => clampIndex(current + delta, options.length));
    }
  }

  useEffect(() => {
    return () => onOpenChange?.(false);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      getOptionElements(listRef.current)[activeIndex]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePlacement = () => {
      const trigger = triggerRef.current;
      const list = listRef.current;
      if (!trigger || !list) return;
      const boundary = trigger.closest<HTMLElement>(".ui-dialog__body")?.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const boundaryTop = boundary?.top ?? 0;
      const boundaryBottom = boundary?.bottom ?? window.innerHeight;
      const desiredHeight = Math.min(LIST_MAX_HEIGHT, list.scrollHeight + LIST_BORDER_HEIGHT);
      const roomBelow = Math.max(0, boundaryBottom - triggerRect.bottom - LIST_GAP - LIST_COLLISION_CLEARANCE);
      const roomAbove = Math.max(0, triggerRect.top - boundaryTop - LIST_GAP - LIST_COLLISION_CLEARANCE);
      const nextPlacement = roomBelow >= desiredHeight
        ? "below"
        : roomAbove >= desiredHeight
          ? "above"
          : roomBelow >= roomAbove ? "below" : "above";
      const availableRoom = nextPlacement === "below" ? roomBelow : roomAbove;
      setPlacement(nextPlacement);
      setListMaxHeight(Math.max(1, Math.min(desiredHeight, availableRoom)));
    };
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [open, options]);

  return (
    <div ref={rootRef} className="paper-select" onKeyDownCapture={handleEscapeKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="paper-select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-labelledby={ariaLabelledBy}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="paper-select__value">{selectedOption?.label ?? value}</span>
        <span className="paper-select__chevron" aria-hidden="true" />
      </button>

      {open ? (
        <div
          ref={listRef}
          id={listboxId}
          className={`paper-select__list paper-select__list--${placement}`}
          role="listbox"
          aria-labelledby={ariaLabelledBy}
          style={{ maxHeight: listMaxHeight }}
          onKeyDown={handleListKeyDown}
        >
          {options.map((option, index) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                className="paper-select__option"
                role="option"
                aria-selected={selected}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => choose(index)}
                onFocus={() => setActiveIndex(index)}
                onPointerMove={() => setActiveIndex(index)}
              >
                <span className="paper-select__check" aria-hidden="true">
                  {selected ? <Check size={14} /> : null}
                </span>
                <span className="paper-select__label">{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function clampIndex(index: number, length: number) {
  if (length <= 0) return 0;
  if (index < 0) return length - 1;
  if (index >= length) return 0;
  return index;
}

function getOptionElements(list: HTMLDivElement | null) {
  if (!list) return [];
  return Array.from(list.querySelectorAll<HTMLButtonElement>("[role='option']"));
}
