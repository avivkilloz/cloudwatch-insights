import { KeyboardEvent, ReactNode } from "react";
import { CardSection } from "../SessionCard";

/*
 * The Settings layout the Credentials, Environments and User groups tabs
 * share: a plain table whose rows open an item, and the opened item as the
 * session card's bordered sections under one header. One layout for all
 * three, so they read as one product rather than three forms.
 */

/** A section of an opened item: the session card's bordered card, with a title. */
export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <CardSection>
      <div className="credential-section-head">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </CardSection>
  );
}

/** An opened item's header: back to the list, its name, and what can be done to it. */
export function ViewHead({ back, title, children }: { back: () => void; title: string; children?: ReactNode }) {
  return (
    <div className="credential-view-head">
      <button className="secondary" onClick={back}>
        ← Back
      </button>
      <h2>{title}</h2>
      <div className="credential-view-actions">{children}</div>
    </div>
  );
}

/** A table row that opens its item, by click or by Enter. */
export function rowProps(open: () => void) {
  return {
    className: "credential-row",
    tabIndex: 0,
    onClick: open,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter") open();
    },
  };
}

/**
 * Chosen items as tags with ✕, and one picker to add another. The picker
 * stays, disabled and saying so, once everything is chosen: when it
 * vanished, two groups granted read as a limit of two.
 */
export function TagPicker<T extends { id: number; name: string }>({
  items,
  chosen,
  onChange,
  label,
  addLabel,
  allChosenLabel,
  emptyLabel,
}: {
  items: T[];
  chosen: number[];
  onChange: (ids: number[]) => void;
  label: string;
  addLabel: string;
  allChosenLabel: string;
  emptyLabel?: string;
}) {
  const left = items.filter((i) => !chosen.includes(i.id));
  return (
    <div className="credential-grants">
      {chosen.length === 0 && emptyLabel && <span className="muted">{emptyLabel}</span>}
      {items
        .filter((i) => chosen.includes(i.id))
        .map((i) => (
          <span key={i.id} className="tag credential-grant" data-name={i.name}>
            {i.name}
            <button
              type="button"
              className="credential-grant-remove"
              aria-label={`Remove ${i.name}`}
              onClick={() => onChange(chosen.filter((id) => id !== i.id))}
            >
              ✕
            </button>
          </span>
        ))}
      <select
        aria-label={label}
        className="credential-grant-add"
        value=""
        disabled={left.length === 0}
        onChange={(e) => e.target.value && onChange([...chosen, Number(e.target.value)])}
      >
        <option value="">{left.length === 0 ? allChosenLabel : addLabel}</option>
        {left.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
    </div>
  );
}
