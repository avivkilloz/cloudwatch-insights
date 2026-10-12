"""Moving the per-pane saved stores into saved inputs (PLATFORM_PLAN.md D46).

Each pane's old store moves once, when the pane is ported, keyed by a
`Settings` marker (as Phase 2's migration was): keyed on "not done yet" rather
than "the old store is empty", so it never runs twice, and an old row created
afterwards by a tab that hasn't reloaded is simply left where it is.

3b-1 moves DynamoDB's saved tables and S3's saved buckets, both kept as
`saved_sessions` rows (`page` "tables" / "buckets") holding
`{environment_id, table_name | bucket}`. Their environment id is already the
connection id (D34), so it becomes the `connection` input as it is.

3b-2 moves IoT's saved searches (their own table, `iot_saved_searches`: a
mode and a query, never an environment) and the HTTP client's saved requests
(`saved_sessions` page "tools-http": method, URL, headers as `[{key, value}]`,
body, and the credential and target by id). The headers become the editor's
rows, with the empty row it always ends in. A row with no owner was never
shown to anyone, so it is left behind.

3b-3 moves the logs panes' saved queries (`saved_queries`, a query and the
backend it was written for) into saved inputs of the matching pane, as
`{queryString}`: a saved query never held environments or log groups.
"""

from typing import Any, Callable

from sqlalchemy.orm import Session

from .. import models

MARKER_3B1 = "saved_inputs_migrated_3b1"
MARKER_3B2 = "saved_inputs_migrated_3b2"
MARKER_3B3 = "saved_inputs_migrated_3b3"

_MOVES: dict[str, tuple[str, Callable[[dict[str, Any]], dict[str, Any]]]] = {
    "tables": ("tables", lambda s: {"connection": s.get("environment_id"), "tableName": s.get("table_name") or ""}),
    "buckets": ("buckets", lambda s: {"connection": s.get("environment_id"), "bucket": s.get("bucket") or ""}),
}


def _header_rows(headers: Any) -> list[dict[str, Any]]:
    rows = [
        {"id": i + 1, "key": str(h.get("key") or ""), "value": str(h.get("value") or "")}
        for i, h in enumerate(headers if isinstance(headers, list) else [])
        if isinstance(h, dict)
    ]
    return rows + [{"id": len(rows) + 1, "key": "", "value": ""}]


def _http_request(s: dict[str, Any]) -> dict[str, Any]:
    return {
        "method": s.get("method") or "GET",
        "url": s.get("url") or "",
        "headerRows": _header_rows(s.get("headers")),
        "body": s.get("body") or "",
        "credentialId": s.get("credentialId"),
        "targetId": s.get("targetId"),
    }


def migrate_saved_shortcuts(db: Session) -> list[str]:
    """Once per database each: saved tables and buckets (3b-1), IoT's saved
    searches and the HTTP client's saved requests (3b-2), and the logs panes'
    saved queries (3b-3) become saved inputs. Returns a line per moved item,
    for the startup log."""
    return _move_3b1(db) + _move_3b2(db) + _move_3b3(db)


def _move_3b3(db: Session) -> list[str]:
    if db.get(models.Setting, MARKER_3B3) is not None:
        return []
    moved: list[str] = []
    for row in db.query(models.SavedQuery).all():
        if row.user_id is None:
            continue
        pane_type = "logs-opensearch" if row.backend == "opensearch" else "logs-cloudwatch"
        db.add(models.SavedInput(user_id=row.user_id, pane_type=pane_type, name=row.name, inputs={"queryString": row.query_string}))
        db.delete(row)
        moved.append(f"{pane_type} query '{row.name}' (user {row.user_id}) -> saved inputs")
    db.add(models.Setting(key=MARKER_3B3, value="done"))
    db.commit()
    return moved


def _move_3b2(db: Session) -> list[str]:
    if db.get(models.Setting, MARKER_3B2) is not None:
        return []
    moved: list[str] = []
    for row in db.query(models.IotSavedSearch).all():
        if row.user_id is None:
            continue
        mode = "certificates" if row.search_mode == "certificates" else "things"
        db.add(
            models.SavedInput(
                user_id=row.user_id, pane_type="iot", name=row.name, inputs={"searchMode": mode, "queryString": row.query_string}
            )
        )
        db.delete(row)
        moved.append(f"IoT search '{row.name}' (user {row.user_id}) -> saved inputs")
    for row in db.query(models.SavedSession).filter(models.SavedSession.page == "tools-http").all():
        if row.user_id is None or not isinstance(row.state, dict):
            continue
        db.add(models.SavedInput(user_id=row.user_id, pane_type="tool-http", name=row.name, inputs=_http_request(row.state)))
        db.delete(row)
        moved.append(f"HTTP request '{row.name}' (user {row.user_id}) -> saved inputs")
    db.add(models.Setting(key=MARKER_3B2, value="done"))
    db.commit()
    return moved


def _move_3b1(db: Session) -> list[str]:
    if db.get(models.Setting, MARKER_3B1) is not None:
        return []
    moved: list[str] = []
    for page, (pane_type, shape) in _MOVES.items():
        for row in db.query(models.SavedSession).filter(models.SavedSession.page == page).all():
            if row.user_id is None or not isinstance(row.state, dict):
                continue
            db.add(models.SavedInput(user_id=row.user_id, pane_type=pane_type, name=row.name, inputs=shape(row.state)))
            db.delete(row)
            moved.append(f"saved {page} '{row.name}' (user {row.user_id}) -> saved inputs")
    db.add(models.Setting(key=MARKER_3B1, value="done"))
    db.commit()
    return moved
