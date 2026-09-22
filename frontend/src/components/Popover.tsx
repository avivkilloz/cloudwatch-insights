import { ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A button and the little menu it opens.
 *
 * Three places want this now -- the panel's ⋮, the strip's ⋮ and the strip's ＋
 * -- and the fiddly parts are the same every time, so they live here once.
 *
 * The menu is portalled to the body and fixed to the viewport. As an ordinary
 * child it would be clipped by whichever scrolling box it sat in (the panel
 * scrolls, the tab strip scrolls), which is what used to trap it inside the
 * panel. Being fixed means it has to be *moved* when anything scrolls rather
 * than left behind -- and clicking the button focuses it, which scrolls its
 * container, so that happens on every open.
 */
export default function Popover({
  glyph,
  label,
  title,
  buttonClass,
  menuClass,
  width = 160,
  children,
}: {
  glyph: ReactNode;
  /** For screen readers, and the tooltip unless `title` overrides it. */
  label: string;
  title?: string;
  buttonClass: string;
  menuClass: string;
  /** Used to keep the menu on screen before it has been measured. */
  width?: number;
  /** Given a function that closes the menu, so items can act and dismiss. */
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  /** Just under the button, and inside the window. Measured from the menu once
   * it is up, so one wider than its container overhangs rather than running off
   * the edge of the screen. */
  const place = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const r = button.getBoundingClientRect();
    const w = menuRef.current?.offsetWidth || width;
    setPos({ left: Math.max(4, Math.min(r.left, window.innerWidth - w - 8)), top: r.bottom + 4 });
  }, [width]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (buttonRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={buttonRef}
        className={buttonClass}
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        title={title ?? label}
      >
        {glyph}
      </button>
      {open &&
        pos &&
        createPortal(
          <div className={menuClass} ref={menuRef} style={{ left: pos.left, top: pos.top }}>
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  );
}
