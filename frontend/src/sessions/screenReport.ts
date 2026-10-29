/**
 * What this tab has on screen, told to the server (D157): the session in
 * front, or the Builder editor and its draft. It's how Claude Code -- calling
 * the platform's tools with a personal access token, with no turn to say so
 * -- knows what "here" is: get_context's on_screen. Said when it changes,
 * when the tab comes to the front, and every half minute while it's open, so
 * a tab that went away stops counting by itself.
 */

import { useEffect, useMemo } from "react";
import { api, ScreenReport, SYNC_ORIGIN } from "../api";
import { useEditorOnScreen } from "../pages/buildDraft";

const EVERY_MS = 30_000;
const VIEWS = new Set(["home", "session", "builder", "workflows", "settings", "chat", "code"]);

export function useReportScreen(enabled: boolean, view: string, sessionId: string | null) {
  const editor = useEditorOnScreen();
  const report = useMemo<Omit<ScreenReport, "visible">>(() => {
    const shown = (VIEWS.has(view) ? view : "other") as ScreenReport["view"];
    if (shown === "session") return { view: shown, session_id: sessionId };
    if (shown === "builder" && editor)
      return { view: shown, build_kind: editor.kind, target_id: editor.targetId, draft_id: editor.draftId };
    return { view: shown };
  }, [view, sessionId, editor]);
  const key = JSON.stringify(report);

  useEffect(() => {
    if (!enabled) return;
    let timezone: string | undefined;
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timezone = undefined;
    }
    // Nothing to show anyone if it fails: the next one tries again.
    const send = () =>
      api.reportScreen({ ...report, timezone, visible: document.visibilityState === "visible" }).catch(() => undefined);
    // Leaving (a reload, a closed tab): said on the way out, or the tab would
    // count as in front for a minute after it's gone. `keepalive` outlives the page.
    const gone = () => {
      fetch("/api/screen", {
        method: "PUT",
        keepalive: true,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Sync-Origin": SYNC_ORIGIN },
        body: JSON.stringify({ ...report, timezone, visible: false }),
      }).catch(() => undefined);
    };
    send();
    const timer = window.setInterval(send, EVERY_MS);
    document.addEventListener("visibilitychange", send);
    window.addEventListener("focus", send);
    window.addEventListener("pagehide", gone);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", send);
      window.removeEventListener("focus", send);
      window.removeEventListener("pagehide", gone);
    };
    // `key` is the report by value: a new object each render isn't a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
}
