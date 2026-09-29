"""The model's words for one step, sorted into its thinking and its answer as
they stream, and a watch for a step that has started going round in circles.

Reasoning models served through an OpenAI-compatible proxy put their
reasoning in the message content, wrapped in <think>...</think>. Often the
opening tag is part of the chat template rather than the output, so all that
arrives is the reasoning, then "</think>", then the answer -- and until that
closing tag arrives there is no telling the two apart. So words are streamed
as answer text as they come, and when a "</think>" turns up the step's words
so far are taken back (a `retract` event) and sent again as thinking. Passed
through raw, the tags ended up in the chat as literal "</think>", with the
same sentence on both sides of each one.
"""

from typing import Optional

OPEN = "<think>"
CLOSE = "</think>"

# How the browser is told to move words it already has.
Event = dict


def _partial_tail(text: str) -> int:
    """How many characters at the end of `text` could be the start of a tag
    cut off between two chunks -- held back until the next chunk says."""
    for tag in (CLOSE, OPEN):
        for n in range(min(len(tag) - 1, len(text)), 0, -1):
            if text.endswith(tag[:n]):
                return n
    return 0


class StepText:
    """One model step's content. `feed` each chunk's text, then `end`; both
    return the events to send. `separate` is whether the turn already has
    answer text (from an earlier step), in which case this step's answer
    starts a new paragraph rather than running on from the last word."""

    def __init__(self, separate: bool = False, thoughts_before: bool = False) -> None:
        self._separate = separate
        self._thoughts_before = thoughts_before
        self._mode = "start"  # start | think | text
        self._held = ""
        # This step's answer text as the browser has it since the last
        # "</think>" -- what a retract takes back.
        self._shown = ""
        self.raw = ""  # everything, for the loop watch
        self.answer = ""  # this step's answer, as it finally stands
        self.thinking = ""

    def feed(self, delta: str) -> list[Event]:
        self.raw += delta
        # Taken out before consuming: whatever still has to wait is put back.
        held, self._held = self._held, ""
        return self._consume(held + delta, final=False)

    def end(self) -> list[Event]:
        held, self._held = self._held, ""
        return self._consume(held, final=True) if held else []

    def abandon(self) -> list[Event]:
        """Takes back whatever answer text this step showed -- for a step
        that was stopped for looping, whose words are no use to anyone."""
        events = [{"type": "retract", "chars": len(self._shown)}] if self._shown else []
        self.answer = self.answer[: len(self.answer) - len(self._shown)] if self._shown else self.answer
        self._shown = ""
        return events

    # ------------------------------------------------------------------

    def _consume(self, buf: str, final: bool) -> list[Event]:
        events: list[Event] = []
        while buf:
            if self._mode == "start":
                stripped = buf.lstrip()
                if not stripped:
                    if not final:
                        self._held = buf
                    return events
                if stripped.startswith(OPEN):
                    self._mode = "think"
                    buf = stripped[len(OPEN) :]
                    continue
                if OPEN.startswith(stripped) and not final:
                    self._held = buf
                    return events
                self._mode = "text"
                buf = stripped
                continue
            if self._mode == "think":
                end = buf.find(CLOSE)
                if end >= 0:
                    events += self._think(buf[:end])
                    buf = buf[end + len(CLOSE) :].lstrip()
                    self._mode = "text"
                    continue
                keep = 0 if final else _partial_tail(buf)
                events += self._think(buf[: len(buf) - keep])
                self._held = buf[len(buf) - keep :]
                return events
            # text
            close = buf.find(CLOSE)
            opening = buf.find(OPEN)
            if close >= 0 and (opening < 0 or close < opening):
                # Everything this step said since the last close was thinking
                # after all: take it back and send it as that.
                earlier = self._shown
                events += self.abandon()
                events += self._think(earlier + buf[:close])
                buf = buf[close + len(CLOSE) :].lstrip()
                continue
            if opening >= 0:
                events += self._say(buf[:opening])
                buf = buf[opening + len(OPEN) :]
                self._mode = "think"
                continue
            keep = 0 if final else _partial_tail(buf)
            events += self._say(buf[: len(buf) - keep])
            self._held = buf[len(buf) - keep :]
            return events
        return events

    def _say(self, text: str) -> list[Event]:
        if not text:
            return []
        if not self.answer.strip() and not self._shown:
            text = text.lstrip()
            if not text:
                return []
            if self._separate:
                text = "\n\n" + text
        self._shown += text
        self.answer += text
        return [{"type": "text", "delta": text}]

    def _think(self, text: str) -> list[Event]:
        if not self.thinking:
            text = text.lstrip()
            if not text:
                return []
            if self._thoughts_before:
                text = "\n\n" + text
        elif not text:
            return []
        self.thinking += text
        return [{"type": "thinking", "delta": text}]


# A step whose last LOOP_WINDOW characters have already appeared this many
# times in it is repeating itself word for word: at that point a model
# doesn't recover on its own, it runs until it hits its token limit (the
# "I need to search... Let me set up the IoT pane..." wall of text).
LOOP_WINDOW = 160
LOOP_REPEATS = 4
LOOP_MIN_CHARS = LOOP_WINDOW * LOOP_REPEATS


def looping(text: str) -> Optional[str]:
    """The sentence a step keeps repeating, if it's stuck in a loop."""
    flat = " ".join(text.split())
    if len(flat) < LOOP_MIN_CHARS:
        return None
    tail = flat[-LOOP_WINDOW:]
    if flat.count(tail) < LOOP_REPEATS:
        return None
    # The first whole sentence of the repeated stretch, to say what it was.
    sentence = next((s.strip() for s in tail.split(". ")[1:] if len(s.strip()) > 20), tail.strip())
    return sentence[:140]
