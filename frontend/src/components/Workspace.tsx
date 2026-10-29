import { ReactNode, useEffect, useState } from "react";
import { BuildFiles, WorkflowProblem } from "../api";
import CodeEditor from "./CodeEditor";
import Icon from "./Icon";

// Its dependencies (D141): requirements.txt is the builder's, requirements.lock
// the platform's -- written by Check and Save, never by hand.
const REQUIREMENTS = "requirements.txt";
const LOCK = "requirements.lock";
const REQUIREMENTS_HINT = "# A package a line, as pip reads it (requests>=2.31). Check and Save lock it.\n";
// Python first, then what it needs and its lock.
const rank = (name: string) => (name === REQUIREMENTS ? 1 : name === LOCK ? 2 : 0);

/**
 * A pane's or a step's files (D136): its YAML and the Python beside it, a tab
 * each over the one editor. Python written as a string inside the YAML was
 * no way to write code (a model's change by path made it one quoted line);
 * here a file is a file, its own lines numbered, and Check's problems are
 * marked in the file they're in -- clicking one opens it.
 *
 * The YAML's textarea keeps its id (`#builder-source`, `#step-source`) for
 * the suites; a file's is `<id>-file`.
 */
export default function Workspace({
  id,
  main,
  source,
  onSource,
  files,
  onFiles,
  problems,
  minRows,
  mainView,
  readOnly,
}: {
  id: string;
  /** The definition's own file name, as the store keeps it: pane.yaml, step.yaml. */
  main: string;
  source: string;
  onSource: (text: string) => void;
  files: BuildFiles;
  onFiles: (files: BuildFiles) => void;
  problems: WorkflowProblem[] | null;
  minRows: number;
  /** In place of the YAML's editor (the form, D115). */
  mainView?: ReactNode;
  /** Shown, not changed: someone else's step. */
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState<string>(main);
  const [naming, setNaming] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const names = Object.keys(files).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  // A file that went (removed, or the agent's draft without it): back to the YAML.
  useEffect(() => {
    if (open !== main && !(open in files)) setOpen(main);
  }, [open, main, files]);
  const inFile = (p: WorkflowProblem) => (p.file ?? null) === (open === main ? null : open);
  const marked = (problems ?? []).filter(inFile).map((p) => p.line ?? 0).filter((n) => n > 0);
  const bad = new Set((problems ?? []).map((p) => p.file ?? main));

  function add() {
    let name = (naming ?? "").trim();
    if (name === "requirements") name = REQUIREMENTS;
    if (name && !name.endsWith(".py") && name !== REQUIREMENTS) name += ".py";
    if (name !== REQUIREMENTS && !/^[a-z_][a-z0-9_]*\.py$/.test(name)) {
      setNameError("A module's name: lowercase letters, digits and _, then .py (helpers.py) -- or requirements.txt.");
      return;
    }
    if (name in files) {
      setNameError(`There is a ${name} already.`);
      return;
    }
    const firstPy = name !== REQUIREMENTS && !names.some((n) => n.endsWith(".py"));
    const text = name === REQUIREMENTS ? REQUIREMENTS_HINT : firstPy ? "def run(inputs, ctx):\n    return {}\n" : "";
    // The first module brings requirements.txt with it (backend deps.HINT):
    // where packages go is then plain, before anyone imports one.
    onFiles({ ...files, [name]: text, ...(firstPy && !(REQUIREMENTS in files) ? { [REQUIREMENTS]: REQUIREMENTS_HINT } : {}) });
    setNaming(null);
    setNameError(null);
    setOpen(name);
  }

  function remove(name: string) {
    if (!confirm(`Remove ${name}? Anything that names it stops checking.`)) return;
    const next = { ...files };
    delete next[name];
    // Its lock goes with it.
    if (name === REQUIREMENTS) delete next[LOCK];
    onFiles(next);
  }

  return (
    <div className="workspace">
      <div className="workspace-tabs" role="tablist">
        {[main, ...names].map((name) => (
          <div key={name} className={`workspace-tab${open === name ? " active" : ""}`} data-file={name}>
            <button role="tab" aria-selected={open === name} className="workspace-tab-name" onClick={() => setOpen(name)}>
              {name}
              {bad.has(name) && <span className="workspace-tab-bad" title="Check found problems here" />}
            </button>
            {name !== main && name !== LOCK && !readOnly && (
              <button className="icon-btn secondary workspace-tab-close" title={`Remove ${name}`} onClick={() => remove(name)}>
                <Icon name="close" />
              </button>
            )}
          </div>
        ))}
        {/* A file is added as a tab is: "+" at the end of the tabs, named in
            place. A "+ File" button beside them read as a stray control. */}
        {readOnly ? null : naming === null ? (
          <div className="workspace-tab workspace-tab-add">
            <button
              className="workspace-tab-name workspace-add"
              title="Add a file: Python, or requirements.txt"
              aria-label="Add a file"
              onClick={() => setNaming("")}
            >
              +
            </button>
          </div>
        ) : (
          <div className="workspace-tab active workspace-naming">
            <input
              id={`${id}-new-file`}
              type="text"
              autoFocus
              placeholder="helpers.py"
              aria-label="The new file's name (Enter adds it, Esc cancels)"
              value={naming}
              onChange={(e) => {
                setNaming(e.target.value);
                setNameError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
                if (e.key === "Escape") {
                  setNaming(null);
                  setNameError(null);
                }
              }}
              onBlur={() => {
                if (!(naming ?? "").trim()) setNaming(null);
              }}
            />
          </div>
        )}
      </div>
      {nameError && <p className="error-text workspace-name-error">{nameError}</p>}
      {open === main ? (
        mainView ?? <CodeEditor id={id} minRows={minRows} value={source} marked={marked} onChange={onSource} readOnly={readOnly} />
      ) : (
        <>
          {open === LOCK && (
            <p className="muted workspace-lock-note">
              Written by Check and Save from requirements.txt: every package pinned with its hashes, which the code runs with.
            </p>
          )}
          <CodeEditor
            key={open}
            id={`${id}-file`}
            minRows={minRows}
            value={files[open] ?? ""}
            marked={marked}
            readOnly={readOnly || open === LOCK}
            onChange={(text) => onFiles({ ...files, [open]: text })}
          />
        </>
      )}
      {problems && problems.length > 0 && (
        <ul className="error-text workflow-problems builder-problems">
          {problems.map((p, i) => (
            <li key={i}>
              {p.file ? (
                <button className="link-button workspace-problem-file" onClick={() => setOpen(p.file!)}>
                  {p.file}
                  {p.line ? `, line ${p.line}` : ""}:
                </button>
              ) : p.line ? (
                <strong>Line {p.line}: </strong>
              ) : null}{" "}
              {p.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
