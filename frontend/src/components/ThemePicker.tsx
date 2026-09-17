import { useEffect, useRef, useState } from "react";
import { THEMES, ThemeId } from "../theme";

interface Props {
  theme: ThemeId;
  onChange: (theme: ThemeId) => void;
}

export default function ThemePicker({ theme, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div className="icon-popover-wrap" ref={ref}>
      <button type="button" className="icon-btn" title="Theme" aria-label="Theme" onClick={() => setOpen((o) => !o)}>
        🎨
      </button>
      {open && (
        <div className="icon-popover">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`icon-popover-item ${t.id === theme ? "active" : ""}`}
              onClick={() => {
                onChange(t.id);
                setOpen(false);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
