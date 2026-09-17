import { useEffect, useState } from "react";

type JwtMode = "decode" | "encode";
type HmacAlg = "HS256" | "HS384" | "HS512";

const HASH_FOR_ALG: Record<HmacAlg, string> = { HS256: "SHA-256", HS384: "SHA-384", HS512: "SHA-512" };

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeJsonSegment(value: unknown): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlDecodeBytes(segment)));
}

function isHmacAlg(alg: string): alg is HmacAlg {
  return alg in HASH_FOR_ALG;
}

async function hmacSign(alg: HmacAlg, secret: string, signingInput: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: HASH_FOR_ALG[alg] },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

const DEFAULT_HEADER = { alg: "HS256", typ: "JWT" };
const DEFAULT_PAYLOAD = { sub: "1234567890", name: "Jane Doe", iat: Math.floor(Date.now() / 1000) };

type VerifyResult = "unknown" | "valid" | "invalid" | "unsupported";

export default function JwtTool() {
  const [mode, setMode] = useState<JwtMode>("decode");

  const [token, setToken] = useState("");
  const [decodedHeader, setDecodedHeader] = useState<{ alg?: string } | null>(null);
  const [decodedPayload, setDecodedPayload] = useState<unknown>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [verifySecret, setVerifySecret] = useState("");
  const [verifyResult, setVerifyResult] = useState<VerifyResult>("unknown");

  const [encAlg, setEncAlg] = useState<HmacAlg>("HS256");
  const [encHeader, setEncHeader] = useState(JSON.stringify(DEFAULT_HEADER, null, 2));
  const [encPayload, setEncPayload] = useState(JSON.stringify(DEFAULT_PAYLOAD, null, 2));
  const [encSecret, setEncSecret] = useState("");
  const [encResult, setEncResult] = useState("");
  const [encError, setEncError] = useState<string | null>(null);
  const [encoding, setEncoding] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!token.trim()) {
      setDecodedHeader(null);
      setDecodedPayload(null);
      setDecodeError(null);
      return;
    }
    const parts = token.trim().split(".");
    if (parts.length < 2) {
      setDecodeError("Not a JWT -- expected at least a header and payload segment separated by '.'.");
      setDecodedHeader(null);
      setDecodedPayload(null);
      return;
    }
    try {
      setDecodedHeader(decodeJsonSegment(parts[0]) as { alg?: string });
      setDecodedPayload(decodeJsonSegment(parts[1]));
      setDecodeError(null);
    } catch (e: any) {
      setDecodeError(`Could not decode header/payload: ${e.message}`);
      setDecodedHeader(null);
      setDecodedPayload(null);
    }
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    async function verify() {
      const parts = token.trim().split(".");
      if (!decodedHeader?.alg || parts.length !== 3 || !verifySecret) {
        setVerifyResult("unknown");
        return;
      }
      if (!isHmacAlg(decodedHeader.alg)) {
        setVerifyResult("unsupported");
        return;
      }
      try {
        const expected = await hmacSign(decodedHeader.alg, verifySecret, `${parts[0]}.${parts[1]}`);
        if (!cancelled) setVerifyResult(expected === parts[2] ? "valid" : "invalid");
      } catch {
        if (!cancelled) setVerifyResult("invalid");
      }
    }
    verify();
    return () => {
      cancelled = true;
    };
  }, [token, decodedHeader, verifySecret]);

  async function generateToken() {
    setEncError(null);
    setEncoding(true);
    try {
      const headerObj = JSON.parse(encHeader);
      const payloadObj = JSON.parse(encPayload);
      const signingInput = `${encodeJsonSegment(headerObj)}.${encodeJsonSegment(payloadObj)}`;
      const signature = await hmacSign(encAlg, encSecret, signingInput);
      setEncResult(`${signingInput}.${signature}`);
    } catch (e: any) {
      setEncError(e.message || "Failed to build token.");
      setEncResult("");
    } finally {
      setEncoding(false);
    }
  }

  async function copyResult() {
    if (!encResult) return;
    try {
      await navigator.clipboard.writeText(encResult);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard access denied or unavailable -- nothing more we can do
    }
  }

  return (
    <div>
      <div className="toolbar">
        <button className={mode === "decode" ? "" : "secondary"} onClick={() => setMode("decode")}>
          Decode
        </button>
        <button className={mode === "encode" ? "" : "secondary"} onClick={() => setMode("encode")}>
          Encode
        </button>
      </div>

      {mode === "decode" ? (
        <div>
          <span className="field-label">JWT</span>
          <textarea rows={4} value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste a JWT to decode…" />
          {decodeError && <p className="error-text">{decodeError}</p>}
          {decodedHeader != null && (
            <>
              <span className="field-label">Header</span>
              <pre className="tool-json-output">{JSON.stringify(decodedHeader, null, 2)}</pre>
            </>
          )}
          {decodedPayload != null && (
            <>
              <span className="field-label">Payload</span>
              <pre className="tool-json-output">{JSON.stringify(decodedPayload, null, 2)}</pre>
            </>
          )}
          {decodedHeader != null && (
            <div style={{ marginTop: 4 }}>
              <span className="field-label">Verify signature (optional, HS256/384/512 only)</span>
              <div className="row">
                <input
                  type="text"
                  placeholder="Secret"
                  value={verifySecret}
                  onChange={(e) => setVerifySecret(e.target.value)}
                  style={{ width: 240 }}
                />
                {verifySecret && (
                  <span className={`tag ${verifyResult === "valid" ? "ok" : verifyResult === "invalid" ? "error" : ""}`}>
                    {verifyResult === "valid" && "✓ Valid signature"}
                    {verifyResult === "invalid" && "✗ Invalid signature"}
                    {verifyResult === "unsupported" && "Unsupported algorithm for verification"}
                    {verifyResult === "unknown" && "…"}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div>
          <div className="row" style={{ marginBottom: 10, alignItems: "flex-start" }}>
            <div>
              <span className="field-label">Algorithm</span>
              <select value={encAlg} onChange={(e) => setEncAlg(e.target.value as HmacAlg)}>
                <option value="HS256">HS256</option>
                <option value="HS384">HS384</option>
                <option value="HS512">HS512</option>
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <span className="field-label">Secret</span>
              <input type="text" value={encSecret} onChange={(e) => setEncSecret(e.target.value)} style={{ width: "100%" }} />
            </div>
          </div>
          <span className="field-label">Header</span>
          <textarea rows={3} value={encHeader} onChange={(e) => setEncHeader(e.target.value)} />
          <span className="field-label">Payload</span>
          <textarea rows={6} value={encPayload} onChange={(e) => setEncPayload(e.target.value)} />
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button onClick={generateToken} disabled={encoding}>
              {encoding ? "Signing…" : "Generate token"}
            </button>
            {encError && <span className="error-text">{encError}</span>}
          </div>
          {encResult && (
            <div style={{ marginTop: 10 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="field-label" style={{ margin: 0 }}>
                  Token
                </span>
                <button className="secondary" onClick={copyResult}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="tool-json-output" style={{ wordBreak: "break-all" }}>
                {encResult}
              </pre>
            </div>
          )}
        </div>
      )}
      <p className="muted" style={{ marginTop: 4 }}>
        Everything here runs in your browser -- the token, secret, and payload never leave this page. Only symmetric
        (HS256/384/512) signing and verification are supported; RS/ES-signed tokens can still be decoded, but their
        signature can't be verified here.
      </p>
    </div>
  );
}
