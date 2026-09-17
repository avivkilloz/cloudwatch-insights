import { ReactNode } from "react";

interface Props {
  icon: string;
  title: string;
  description: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export default function ToolCard({ icon, title, description, expanded, onToggle, children }: Props) {
  return (
    <div className={expanded ? "tool-card expanded" : "tool-card"}>
      <div className="tool-card-header" onClick={onToggle}>
        <span className="tool-card-icon" aria-hidden="true">
          {icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tool-card-title">{title}</div>
          <div className="tool-card-desc">{description}</div>
        </div>
        <span className={`chevron ${expanded ? "open" : ""}`}>▶</span>
      </div>
      {expanded && <div className="tool-card-body">{children}</div>}
    </div>
  );
}
