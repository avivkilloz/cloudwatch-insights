/**
 * Under a pane's, step's or workflow's editor (D159): the connection types its
 * draft reaches, each said there or not. A missing one has "Make it", which
 * opens the Builder's Connections with a new type of that id -- building a pane
 * on an API the platform has no type for used to stop at Check, or worse, at
 * its first use.
 */

import { useEffect, useState } from "react";
import { api, BuildNeed } from "../api";
import { openInBuilder } from "../workflowFocus";

const AFTER_MS = 600;

export default function BuilderNeeds({ kind, source }: { kind: "pane" | "step" | "workflow"; source: string }) {
  const [needs, setNeeds] = useState<BuildNeed[]>([]);
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      api.builderNeeds(kind, source).then((n) => live && setNeeds(n), () => undefined);
    }, AFTER_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [kind, source]);
  if (needs.length === 0) return null;
  return (
    <p className="builder-needs">
      <span className="muted">Needs</span>
      {needs.map((n) =>
        n.exists ? (
          <span key={n.id} className="tag builder-need" data-need={n.id} title={`Connection type ${n.id}`}>
            {n.label ?? n.id}
          </span>
        ) : (
          <span key={n.id} className="builder-need builder-need-missing" data-need={n.id}>
            <span className="tag pending">{n.id}: no such connection type yet</span>
            <button className="secondary" onClick={() => openInBuilder({ what: "type", kind: "connection", id: n.id })}>
              Make it
            </button>
          </span>
        ),
      )}
    </p>
  );
}
