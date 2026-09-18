import { useState } from "react";
import ToolCard from "../components/ToolCard";
import Base64Tool from "../components/tools/Base64Tool";
import DiffTool from "../components/tools/DiffTool";
import HttpClientTool from "../components/tools/HttpClientTool";
import JwtTool from "../components/tools/JwtTool";
import MqttTool from "../components/tools/MqttTool";

type ToolId = "jwt" | "base64" | "diff" | "http" | "mqtt";

const TOOLS: { id: ToolId; icon: string; title: string; description: string; render: () => JSX.Element }[] = [
  {
    id: "jwt",
    icon: "🔑",
    title: "JWT Decoder / Encoder",
    description: "Decode any JWT, or build and sign a new one.",
    render: () => <JwtTool />,
  },
  {
    id: "base64",
    icon: "🔤",
    title: "Base64 Encode / Decode",
    description: "Convert text to and from Base64.",
    render: () => <Base64Tool />,
  },
  {
    id: "diff",
    icon: "📝",
    title: "Diff Checker",
    description: "Compare two blocks of text line by line.",
    render: () => <DiffTool />,
  },
  {
    id: "http",
    icon: "🌐",
    title: "HTTP Client",
    description: "Send an HTTP request and inspect the response, Postman-style.",
    render: () => <HttpClientTool />,
  },
  {
    id: "mqtt",
    icon: "📡",
    title: "MQTT Tester",
    description: "Subscribe and publish to MQTT topics on an AWS IoT Core endpoint.",
    render: () => <MqttTool />,
  },
];

export default function ToolsPage() {
  const [expanded, setExpanded] = useState<Set<ToolId>>(new Set());

  function toggle(id: ToolId) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Collapsed tools stay in their fixed order up top; an expanded one drops
  // to the bottom (after every other tool, expanded or not) instead of
  // pushing open in place, so opening one doesn't reshuffle the tools above
  // it. Array.prototype.sort is stable, so each group keeps its own
  // original relative order.
  const orderedTools = [...TOOLS].sort((a, b) => Number(expanded.has(a.id)) - Number(expanded.has(b.id)));

  return (
    <div className="tools-grid">
      {orderedTools.map((t) => (
        <ToolCard
          key={t.id}
          icon={t.icon}
          title={t.title}
          description={t.description}
          expanded={expanded.has(t.id)}
          onToggle={() => toggle(t.id)}
        >
          {t.render()}
        </ToolCard>
      ))}
    </div>
  );
}
