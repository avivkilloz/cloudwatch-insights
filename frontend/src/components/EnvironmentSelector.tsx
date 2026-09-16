import { Environment } from "../api";

interface Props {
  environments: Environment[];
  selectedIds: Set<number>;
  onToggle: (id: number) => void;
}

export default function EnvironmentSelector({ environments, selectedIds, onToggle }: Props) {
  return (
    <div>
      {environments.length === 0 && (
        <p className="muted">No environments configured yet — add some under "Environments &amp; Settings".</p>
      )}
      <div className="checkbox-list" style={{ maxHeight: 200 }}>
        {environments.map((e) => (
          <label key={e.id} className="checkbox-item">
            <input type="checkbox" checked={selectedIds.has(e.id)} onChange={() => onToggle(e.id)} />
            {e.name} ({e.account_id} · {e.region})
          </label>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 8 }}>
        {environments.filter((e) => selectedIds.has(e.id)).length} environment(s) selected.
      </p>
    </div>
  );
}
