/**
 * A credential or connection type as YAML (D158): the same definition the
 * store keeps as its file, editable as text beside the form. The form's draft
 * stays the truth -- each edit that reads as a mapping is put back into it,
 * one that doesn't is kept as typed and said wrong -- so Save is the form's
 * own, and switching back shows what the text said.
 */

import { useState } from "react";
import { parse, stringify } from "yaml";
import CodeEditor from "../CodeEditor";

export type TypeData = Record<string, unknown>;

/** The definition as the store writes it: empty values left out. */
export function typeText(data: TypeData): string {
  const kept = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null && v !== undefined && v !== "" &&
    !(Array.isArray(v) && v.length === 0)));
  return stringify(kept, { lineWidth: 100 });
}

export default function TypeYaml({ id, data, onData, readOnly }: {
  id: string;
  data: TypeData;
  onData: (data: TypeData) => void;
  readOnly: boolean;
}) {
  const [text, setText] = useState(() => typeText(data));
  const [problem, setProblem] = useState<string | null>(null);

  function change(next: string) {
    setText(next);
    let read: unknown;
    try {
      read = parse(next);
    } catch (e) {
      setProblem((e as Error).message.split("\n")[0]);
      return;
    }
    if (!read || typeof read !== "object" || Array.isArray(read)) {
      setProblem("A type is a mapping: id, label, description, fields…");
      return;
    }
    const fields = (read as TypeData).fields;
    if (fields !== undefined && !Array.isArray(fields)) {
      setProblem("fields is a list: one item per field.");
      return;
    }
    setProblem(null);
    onData(read as TypeData);
  }

  return (
    <div className="type-yaml">
      <CodeEditor id={id} value={text} onChange={readOnly ? undefined : change} readOnly={readOnly} minRows={14} />
      {problem ? (
        <p className="error-text type-yaml-problem">{problem}</p>
      ) : (
        <p className="muted type-yaml-note">The file the store keeps for it. Save checks it in full.</p>
      )}
    </div>
  );
}
