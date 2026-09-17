import { THEMES, ThemeId } from "../theme";

interface Props {
  theme: ThemeId;
  onChange: (theme: ThemeId) => void;
}

export default function ThemeGrid({ theme, onChange }: Props) {
  return (
    <div className="theme-cards-grid">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`theme-card ${t.id === theme ? "active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          <div className="theme-card-label">
            {t.label}
            {t.id === theme && <span className="theme-card-check">✓ Active</span>}
          </div>
          <div className="theme-swatch" data-theme={t.id}>
            <div className="theme-swatch-bar">
              <span className="theme-swatch-dot" />
              <span className="theme-swatch-dot" />
              <span className="theme-swatch-dot" />
            </div>
            <div className="theme-swatch-body">
              <div className="theme-swatch-panel">
                <div className="theme-swatch-heading" />
                <div className="theme-swatch-line" />
                <div className="theme-swatch-line short" />
                <div className="theme-swatch-row">
                  <span className="theme-swatch-btn" />
                  <span className="theme-swatch-tag" />
                </div>
              </div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
