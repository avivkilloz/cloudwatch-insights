"""Claude Code beside the user (D157): what their tabs have on screen tells an
outside client what "here" is, and a draft's every change is versioned and
announced, so the open editor follows it and never saves over it."""

from app import live_events
from tests.conftest import client
from tests.test_access_tokens import _call, _error, _make
from tests.test_platform_tools import mcp  # noqa: F401 -- a fixture

TAB = {"X-Sync-Origin": "tab-1"}


def _screen(**body) -> None:
    resp = client.put("/api/screen", json=body, headers=TAB)
    assert resp.status_code == 204, resp.text


def _events(monkeypatch) -> list[dict]:
    """What would be announced, as the stream would say it."""
    said: list[dict] = []
    real = live_events.notify

    def keep(db, user_id, kind, client_id, version, origin, order=None, pane=None, extra=None):
        said.append({"kind": kind, "version": version, "origin": origin, **(extra or {})})
        real(db, user_id, kind, client_id, version, origin, order, pane, extra)

    monkeypatch.setattr(live_events, "notify", keep)
    return said


def test_a_tab_must_say_which_it_is():
    assert client.put("/api/screen", json={"view": "home"}).status_code == 400


def test_the_session_on_screen_is_here_for_claude_code(mcp):
    assert client.put("/api/live-sessions/s-here", json={"type": "aggregator", "title": "OTA debugging",
                                                         "state": {}}).status_code == 200
    token = _make()["token"]
    before = _call(mcp, token, "get_context")
    assert before["on_screen"] == [] and before["viewing_session"] is None and before["timezone"] == "UTC"

    _screen(view="session", session_id="s-here", timezone="Asia/Jerusalem")
    context = _call(mcp, token, "get_context")
    assert context["on_screen"][0] == {"view": "session", "in_front": True, "session_id": "s-here",
                                       "title": "OTA debugging"}
    assert context["viewing_session"]["session_id"] == "s-here"
    assert context["timezone"] == "Asia/Jerusalem"
    # A tab in the background comes after the one in front.
    client.put("/api/screen", json={"view": "builder", "build_kind": "pane", "visible": False},
               headers={"X-Sync-Origin": "tab-2"})
    assert [v["view"] for v in _call(mcp, token, "get_context")["on_screen"]] == ["session", "builder"]


def test_open_draft_on_screen_is_taken_by_the_open_editor(mcp, monkeypatch):
    token = _make()["token"]
    assert "no Builder editor on screen" in _error(mcp, token, "open_draft", on_screen=True)
    _screen(view="builder", build_kind="pane")
    shown = _call(mcp, token, "get_context")["on_screen"][0]
    assert shown["draft_id"] is None and "open_draft(on_screen=True)" in shown["note"]

    said = _events(monkeypatch)
    opened = _call(mcp, token, "open_draft", on_screen=True, start_from="recipe:rows-that-open")
    assert "shows it now" in opened["note"] and opened["kind"] == "pane"
    made = [e for e in said if e["kind"] == "draft"]
    assert made and made[-1]["draft_id"] == opened["draft_id"] and made[-1]["for_tab"] == "tab-1"
    assert made[-1]["by"] == "“laptop”" and made[-1]["origin"] == "agent"

    # The tab reports the draft it took; asked again, that's the one.
    _screen(view="builder", build_kind="pane", draft_id=opened["draft_id"])
    again = _call(mcp, token, "open_draft", on_screen=True)
    assert again["draft_id"] == opened["draft_id"] and "they see every change" in again["note"]
    assert _call(mcp, token, "get_context")["on_screen"][0]["label"] == "Lambda functions"


def test_every_change_is_versioned_announced_and_never_saved_over(mcp, monkeypatch):
    token = _make()["token"]
    draft = client.post("/api/build-drafts", json={"kind": "pane", "source": "label: Mine\n"}, headers=TAB).json()
    assert draft["version"] == 1
    said = _events(monkeypatch)
    _call(mcp, token, "change_definition", draft_id=draft["id"],
          changes=[{"op": "set", "path": "label", "value": "Claude's"}])
    now = client.get(f"/api/build-drafts/{draft['id']}").json()
    assert now["version"] > 1 and "label: Claude's" in now["source"]
    assert any(e["kind"] == "draft" and e["draft_id"] == draft["id"] and e["version"] == now["version"]
               and e["by"] == "“laptop”" for e in said)

    # The editor's save made on the version it had is refused, not written over Claude's.
    stale = client.put(f"/api/build-drafts/{draft['id']}", json={"source": "label: Mine, typed\n", "base_version": 1},
                       headers=TAB)
    assert stale.status_code == 409 and "changed elsewhere" in stale.json()["detail"]
    assert "label: Claude's" in client.get(f"/api/build-drafts/{draft['id']}").json()["source"]
    # On the latest, it saves -- announced with the tab's own origin, so that tab skips the echo.
    saved = client.put(f"/api/build-drafts/{draft['id']}", json={"source": "label: Both\n",
                                                                  "base_version": now["version"]}, headers=TAB)
    assert saved.status_code == 200 and saved.json()["version"] == now["version"] + 1
    assert said[-1]["origin"] == "tab-1"
    # A chat-only save isn't held to a version: a turn's answer lands whatever changed meanwhile.
    chat = client.put(f"/api/build-drafts/{draft['id']}", json={"chat": [], "base_version": 1}, headers=TAB)
    assert chat.status_code == 200
