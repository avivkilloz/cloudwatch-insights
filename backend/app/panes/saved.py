"""Moving the per-pane saved stores into saved inputs (PLATFORM_PLAN.md D46).

Each pane's old store moves once, when the pane is ported, keyed by a
`Settings` marker (as Phase 2's migration was): keyed on "not done yet" rather
than "the old store is empty", so it never runs twice, and an old row created
afterwards by a tab that hasn't reloaded is simply left where it is.

3b-1 moves DynamoDB's saved tables and S3's saved buckets, both kept as
`saved_sessions` rows (`page` "tables" / "buckets") holding
`{environment_id, table_name | bucket}`. Their environment id is already the
connection id (D34), so it becomes the `connection` input as it is.
"""

from typing import Any, Callable

from sqlalchemy.orm import Session

from .. import models

MARKER_3B1 = "saved_inputs_migrated_3b1"

_MOVES: dict[str, tuple[str, Callable[[dict[str, Any]], dict[str, Any]]]] = {
    "tables": ("tables", lambda s: {"connection": s.get("environment_id"), "tableName": s.get("table_name") or ""}),
    "buckets": ("buckets", lambda s: {"connection": s.get("environment_id"), "bucket": s.get("bucket") or ""}),
}


def migrate_saved_shortcuts(db: Session) -> list[str]:
    """Once per database: saved tables and buckets become saved inputs.
    Returns a line per moved item, for the startup log."""
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
