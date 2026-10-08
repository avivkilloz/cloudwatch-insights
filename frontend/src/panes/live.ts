/**
 * Live functions (PLATFORM_PLAN.md D43): a pane's outputs worked out in the
 * browser from its inputs, as you type. Named in a manifest's `live` action.
 *
 * Each has a Python twin in `backend/app/panes/live.py`, which is what the
 * agent runs; both are held to the outputs in
 * `backend/tests/fixtures/live_functions.json` -- computed by the Base64,
 * Diff and JWT tools' own code before they became manifests -- so a pane and
 * the agent can't disagree about what it shows. Change one, change both.
 *
 * Each takes the pane's inputs and returns its outputs by the manifest's
 * output keys; an output left out has nothing to show.
 */

import { diffLines } from "diff";

export type Outputs = Record<string, unknown>;
export type LiveFunction = (inputs: Record<string, unknown>) => Outputs | Promise<Outputs>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ---------------------------------------------------------------- Base64

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

function base64Convert(inputs: Record<string, unknown>): Outputs {
  const input = str(inputs.input);
  if (!input) return {};
  const mode = inputs.mode === "decode" ? "decode" : "encode";
  try {
    return { output: mode === "encode" ? toBase64(input, !!inputs.urlSafe) : fromBase64(input) };
  } catch {
    return { error: mode === "encode" ? "Could not encode this input." : "That doesn't look like valid Base64." };
  }
}

// ---------------------------------------------------------------- Diff

export type DiffRowType = "equal" | "modify" | "remove" | "add";

export interface DiffRow {
  type: DiffRowType;
  left?: string;
  right?: string;
}

function splitChunkLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// diffLines groups whole runs of consecutive changed lines into a single
// removed chunk and a single added chunk. Splitting those into individual
// lines and pairing them index-wise (like a real side-by-side diff view)
// gives line-for-line "modify" rows instead of one big remove-then-add blob.
function buildDiffRows(left: string, right: string): DiffRow[] {
  const changes = diffLines(left, right);
  const rows: DiffRow[] = [];
  for (let i = 0; i < changes.length; i++) {
    const part = changes[i];
    if (!part.added && !part.removed) {
      for (const line of splitChunkLines(part.value)) rows.push({ type: "equal", left: line, right: line });
      continue;
    }
    if (part.removed) {
      const removedLines = splitChunkLines(part.value);
      const next = changes[i + 1];
      if (next && next.added) {
        const addedLines = splitChunkLines(next.value);
        const pairCount = Math.min(removedLines.length, addedLines.length);
        for (let j = 0; j < pairCount; j++) rows.push({ type: "modify", left: removedLines[j], right: addedLines[j] });
        for (let j = pairCount; j < removedLines.length; j++) rows.push({ type: "remove", left: removedLines[j] });
        for (let j = pairCount; j < addedLines.length; j++) rows.push({ type: "add", right: addedLines[j] });
        i++;
      } else {
        for (const line of removedLines) rows.push({ type: "remove", left: line });
      }
      continue;
    }
    for (const line of splitChunkLines(part.value)) rows.push({ type: "add", right: line });
  }
  return rows;
}

function diffCompute(inputs: Record<string, unknown>): Outputs {
  const left = str(inputs.left);
  const right = str(inputs.right);
  if (!left && !right) return {};
  const rows = buildDiffRows(left, right);
  const removals = rows.filter((r) => r.type === "remove" || r.type === "modify").length;
  const additions = rows.filter((r) => r.type === "add" || r.type === "modify").length;
  const out: Outputs = { diff: rows };
  if (removals || additions) {
    out.counts = `${removals} removal${removals === 1 ? "" : "s"}, ${additions} addition${additions === 1 ? "" : "s"}`;
  }
  return out;
}

// ---------------------------------------------------------------- JWT

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

function isHmacAlg(alg: unknown): alg is HmacAlg {
  return typeof alg === "string" && alg in HASH_FOR_ALG;
}

async function hmacSign(alg: HmacAlg, secret: string, signingInput: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: HASH_FOR_ALG[alg] },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function jwtDecode(inputs: Record<string, unknown>): Outputs {
  const token = str(inputs.token).trim();
  if (!token) return {};
  const parts = token.split(".");
  if (parts.length < 2) {
    return { decodeError: "Not a JWT -- expected at least a header and payload segment separated by '.'." };
  }
  try {
    return { decodedHeader: decodeJsonSegment(parts[0]), decodedPayload: decodeJsonSegment(parts[1]) };
  } catch (e) {
    return { decodeError: `Could not decode header/payload: ${message(e)}` };
  }
}

async function jwtVerify(inputs: Record<string, unknown>): Promise<Outputs> {
  const secret = str(inputs.verifySecret);
  if (!secret) return {};
  const header = jwtDecode(inputs).decodedHeader as { alg?: unknown } | undefined;
  const parts = str(inputs.token).trim().split(".");
  if (!header || typeof header !== "object" || !header.alg || parts.length !== 3) return { verified: "unknown" };
  if (!isHmacAlg(header.alg)) return { verified: "unsupported" };
  try {
    const expected = await hmacSign(header.alg, secret, `${parts[0]}.${parts[1]}`);
    return { verified: expected === parts[2] ? "valid" : "invalid" };
  } catch {
    return { verified: "invalid" };
  }
}

async function jwtSign(inputs: Record<string, unknown>): Promise<Outputs> {
  const alg = isHmacAlg(inputs.alg) ? inputs.alg : "HS256";
  try {
    const header = JSON.parse(str(inputs.header) || "{}");
    const payload = JSON.parse(str(inputs.payload) || "{}");
    const signingInput = `${encodeJsonSegment(header)}.${encodeJsonSegment(payload)}`;
    return { signed: `${signingInput}.${await hmacSign(alg, str(inputs.secret), signingInput)}` };
  } catch (e) {
    return { signError: message(e) || "Failed to build token." };
  }
}

export const LIVE_FUNCTIONS: Record<string, LiveFunction> = {
  "base64.convert": base64Convert,
  "diff.compute": diffCompute,
  "jwt.decode": jwtDecode,
  "jwt.verify": jwtVerify,
  "jwt.sign": jwtSign,
};
