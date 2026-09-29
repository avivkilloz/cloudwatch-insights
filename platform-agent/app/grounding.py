"""Whether an answer's specifics came from anything the turn actually saw.

A model asked for rows it hasn't fetched will sometimes write them anyway --
a tidy table of plausible thing names, "the results are in the iot pane" --
when no search ran, or the one that ran failed. The prompt says not to; this
is the check that doesn't depend on the model listening. It takes the values
an answer presents as data (table cells and `code` spans) and looks for each
in what the turn's tools returned, what they were called with, and what the
user sent. If most of them appear nowhere, the browser shows a warning under
the answer rather than letting it pass as a search result.
"""

import re
from typing import Iterable, Optional

_SEPARATOR = re.compile(r"^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$")
_CODE = re.compile(r"`([^`\n]+)`")

# Too few to judge by: one made-up name in a sentence isn't a table of them.
MIN_CLAIMS = 3


def _cells(line: str) -> list[str]:
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|"):
        body = body[:-1]
    return [c.strip() for c in body.split("|")]


def _meaningful(value: str) -> bool:
    """A value worth checking: not a number, a yes/no, or punctuation -- those
    turn up anywhere and prove nothing either way."""
    v = value.strip().strip("`*_ ")
    if len(v) < 4:
        return False
    # Numbers, and dates and times, which an answer reformats freely.
    if re.fullmatch(r"[-+/\d.,:%\sTZ]+", v):
        return False
    return v.lower() not in {"true", "false", "none", "null", "yes", "no", "n/a"}


def claims(answer: str) -> list[str]:
    """The values an answer presents as data: its table cells (headers left
    out) and its `code` spans."""
    out: list[str] = []
    lines = answer.splitlines()
    i = 0
    while i < len(lines):
        if "|" in lines[i] and i + 1 < len(lines) and "|" in lines[i + 1] and _SEPARATOR.match(lines[i + 1].strip()):
            i += 2
            while i < len(lines) and "|" in lines[i]:
                out += _cells(lines[i])
                i += 1
            continue
        i += 1
    out += _CODE.findall(answer)
    seen: dict[str, None] = {}
    for value in out:
        v = value.strip().strip("`*_ ").strip()
        if _meaningful(v):
            seen.setdefault(v, None)
    return list(seen)


def ungrounded(answer: str, seen: Iterable[str]) -> Optional[list[str]]:
    """The answer's data values found nowhere in `seen`, when that's most of
    them -- None when the answer holds up (or has too little to judge)."""
    values = claims(answer)
    if len(values) < MIN_CLAIMS:
        return None
    corpus = "\n".join(seen).lower()
    # JSON escapes a tool's output; the answer doesn't.
    corpus += "\n" + corpus.replace('\\"', '"').replace("\\n", "\n")
    missing = [v for v in values if not _found(v.lower(), corpus)]
    return missing if len(missing) * 2 > len(values) else None


def _found(value: str, corpus: str) -> bool:
    """Whether a value appears in what the turn saw -- as it stands, or, for
    a phrase, as mostly the same words: an answer shortens a long log line
    or rewords a status, and that isn't making it up. An identifier (a thing
    name, an id) is one word, so it has to appear as it is."""
    if value in corpus:
        return True
    words = re.findall(r"[\w.-]{4,}", value)
    return len(words) >= 2 and sum(w in corpus for w in words) * 2 >= len(words)


def notice(missing: list[str]) -> str:
    examples = ", ".join(f"“{m}”" for m in missing[:3])
    return (
        f"Some of the details above ({examples}) don't appear in anything the agent's tools returned this turn, "
        "so they may not be real. Check the pane itself, or ask the agent to run the search again."
    )
