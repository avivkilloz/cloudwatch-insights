import { useState } from "react";

type Mode = "encode" | "decode";

function toBase64(text: string, urlSafe: boolean): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  return urlSafe ? b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : b64;
}

function fromBase64(input: string): string {
  const normalized = input.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export default function Base64Tool() {
  const [mode, setMode] = useState<Mode>("encode");
  const [input, setInput] = useState("");
  const [urlSafe, setUrlSafe] = useState(false);
  const [copied, setCopied] = useState(false);

  let output = "";
  let error: string | null = null;
  if (input) {
    try {
      output = mode === "encode" ? toBase64(input, urlSafe) : fromBase64(input);
    } catch {
      error = mode === "encode" ? "Could not encode this input." : "That doesn't look like valid Base64.";
    }
  }

  async function copyOutput() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard access denied or unavailable -- nothing more we can do
    }
  }

  return (
    <div>
      <div className="toolbar">
        <button className={mode === "encode" ? "" : "secondary"} onClick={() => setMode("encode")}>
          Encode
        </button>
        <button className={mode === "decode" ? "" : "secondary"} onClick={() => setMode("decode")}>
          Decode
        </button>
        {mode === "encode" && (
          <label className="checkbox-item">
            <input type="checkbox" checked={urlSafe} onChange={(e) => setUrlSafe(e.target.checked)} />
            URL-safe
          </label>
        )}
      </div>
      <span className="field-label">{mode === "encode" ? "Text" : "Base64"}</span>
      <textarea
        rows={5}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={mode === "encode" ? "Type or paste text to encode…" : "Paste Base64 to decode…"}
      />
      <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
        <span className="field-label" style={{ margin: 0 }}>
          {mode === "encode" ? "Base64" : "Text"}
        </span>
        <button className="secondary" onClick={copyOutput} disabled={!output}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {error ? <p className="error-text">{error}</p> : <textarea rows={5} value={output} readOnly />}
    </div>
  );
}
