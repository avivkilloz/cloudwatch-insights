"""Replays agent scenarios against a running platform and checks what they left
behind (PLATFORM_PLAN.md D55).

A scenario is a session to start from, the messages a user sends in its chat,
and what the session should hold afterwards -- a pane's inputs, whether its
run is going, the answer check's verdict. Seeded from conversations where the
agent got it wrong, so a change of model or prompt can be tried against them
before anyone has to meet the same failure again.

The tests in tests/ pin the agent's mechanics against a scripted model; this
is for the real one. A model doesn't answer the same way twice, so each
scenario runs several times and is reported as a pass rate.

    python -m evals.run --base http://localhost:8000 --user admin --password … \\
        [--repeat 3] [--tag fake] [--out report.json] [scenario-name …]

It needs the backend served as `uvicorn dev.fake_aws:app` (scenarios use an
environment whose account starts 0000, created if missing), the agent, and
the model. The given user must be an admin: it sets up an `evals` group
(every page, the agent, a role on that environment) and a user in it for the
run, and the scenarios run as that user -- with an ordinary user's access,
not an admin's. Run it against a development stack, never production.
"""

import argparse
import json
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx
import yaml

SCENARIOS = Path(__file__).parent / "scenarios"
FAKE_ENV = {"name": "e2e-fake-aws", "account_id": "000000000001", "region": "eu-west-1"}
TURN_SECONDS = 180


@dataclass
class Turn:
    answer: str = ""
    steps: list[dict] = field(default_factory=list)
    notices: list[str] = field(default_factory=list)
    error: Optional[str] = None
    # What a build turn put in the editor (D116), its source and files.
    proposed: Optional[str] = None
    files: Optional[dict] = None


def _fill(value: Any, names: dict[str, Any]) -> Any:
    """`{env}`, `{env_id}` in a scenario, filled in -- whole-string ones keep
    their type (an id stays a number)."""
    if isinstance(value, str):
        for key, sub in names.items():
            if value == f"{{{key}}}":
                return sub
            value = value.replace(f"{{{key}}}", str(sub))
        return value
    if isinstance(value, list):
        return [_fill(v, names) for v in value]
    if isinstance(value, dict):
        return {_fill(k, names): _fill(v, names) for k, v in value.items()}
    return value


# The group the scenarios run in: every page, the agent, and an AWS role on
# the fake environment -- an ordinary user's access, not an admin's.
EVAL_GROUP = "evals"
FLAGS = ("logs", "opensearch", "iot", "tables", "buckets", "cognito", "aggregator", "tools", "agent")


def _client(base: str, user: str, password: str) -> httpx.Client:
    http = httpx.Client(base_url=base.rstrip("/") + "/api", timeout=30)
    resp = http.post("/auth/login", json={"username": user, "password": password})
    resp.raise_for_status()
    return http


class Platform:
    """The platform as a scenario sees it: signed in as a user made for this
    run, in the `evals` group, which the admin sets up once."""

    def __init__(self, base: str, admin: str, password: str) -> None:
        self.admin = _client(base, admin, password)
        self.env = self._environment()
        group = self._group(self.env["id"])
        self.username, secret = f"eval-{uuid.uuid4().hex[:8]}", uuid.uuid4().hex
        resp = self.admin.post("/users", json={"username": self.username, "password": secret, "group_id": group["id"]})
        resp.raise_for_status()
        self.user_id = resp.json()["id"]
        self.http = _client(base, self.username, secret)

    def _environment(self) -> dict:
        found = next((e for e in self.admin.get("/environments").json() if e["name"] == FAKE_ENV["name"]), None)
        if found is None:
            resp = self.admin.post("/environments", json=FAKE_ENV)
            resp.raise_for_status()
            found = resp.json()
        return found

    def _group(self, env_id: int) -> dict:
        found = next((g for g in self.admin.get("/user-groups").json() if g["name"] == EVAL_GROUP), None)
        if found is None:
            body = {"name": EVAL_GROUP, "role_name": "EvalRole", "environment_ids": [env_id], "builder_enabled": True,
                    **{f"{f}_enabled": True for f in FLAGS}}
            resp = self.admin.post("/user-groups", json=body)
            resp.raise_for_status()
            found = resp.json()
        elif not found.get("builder_enabled"):
            # A group made before the build scenarios: the Builder turned on.
            resp = self.admin.put(f"/user-groups/{found['id']}", json={"builder_enabled": True})
            resp.raise_for_status()
            found = resp.json()
        return found

    def close(self) -> None:
        self.admin.delete(f"/users/{self.user_id}")

    def start(self, scenario: dict, names: dict[str, Any]) -> str:
        client_id = f"eval{uuid.uuid4().hex[:10]}"
        panes = scenario["session"]["panes"]
        state = {"services": panes, "layout": "tabs", "activePane": panes[0], **_fill(scenario["session"].get("state", {}), names)}
        title = scenario["session"].get("title", f"Eval: {scenario['name']}")
        resp = self.http.put(f"/live-sessions/{client_id}", json={"title": title, "type": "aggregator", "state": state})
        resp.raise_for_status()
        return client_id

    def draft(self, scenario: dict) -> dict:
        """A build scenario's editor (D116): an example's source, or its own."""
        build = scenario["build"]
        source = build.get("source")
        if source is None:
            resp = self.http.get(f"/builder/examples/{build['start']}")
            resp.raise_for_status()
            source = resp.json()["source"]
        return {"kind": build.get("kind", "pane"), "id": None, "title": build.get("title", ""), "source": source,
                "files": dict(build.get("files") or {})}

    def fake_aws(self, replies: list[dict]) -> None:
        """What the fake environment's AWS answers (dev.fake_aws), for a build
        scenario whose draft is tried there (D153)."""
        for r in replies:
            resp = self.admin.put("/dev/fake-aws", params={"service": r["service"], "operation": r["operation"],
                                                           "account": FAKE_ENV["account_id"]}, json=r["reply"])
            resp.raise_for_status()

    def check(self, source: str, files: Optional[dict] = None) -> dict:
        resp = self.http.post("/builder/check", json={"source": source, "files": files or {}})
        resp.raise_for_status()
        return resp.json()

    def ask(self, client_id: Optional[str], history: list[dict], build: Optional[dict] = None) -> Turn:
        turn = Turn()
        if build is not None:
            body: dict = {"messages": history, "timezone": "UTC", "scope": "build", "build": build}
        else:
            body = {"messages": history, "viewing_session_id": client_id, "timezone": "UTC", "scope": "session"}
        with self.http.stream("POST", "/agent/chat", json=body, timeout=httpx.Timeout(30, read=TURN_SECONDS)) as resp:
            if resp.status_code != 200:
                turn.error = f"HTTP {resp.status_code}: {resp.read().decode()[:300]}"
                return turn
            for line in resp.iter_lines():
                if not line.startswith("data: "):
                    continue
                event = json.loads(line[len("data: ") :])
                kind = event.get("type")
                if kind == "text":
                    turn.answer += event["delta"]
                elif kind == "retract":
                    turn.answer = turn.answer[: len(turn.answer) - event["chars"]]
                elif kind == "tool_call":
                    turn.steps.append({**event, "ok": None})
                elif kind == "tool_result":
                    for step in turn.steps:
                        if step["id"] == event["id"]:
                            step.update(ok=event["ok"], summary=event.get("summary", ""))
                    if isinstance(event.get("propose"), dict):
                        turn.proposed = event["propose"].get("source")
                        turn.files = event["propose"].get("files")
                elif kind == "notice":
                    turn.notices.append(event["message"])
                elif kind == "error":
                    turn.error = event["message"]
        return turn

    def state(self, client_id: str) -> dict:
        resp = self.http.get(f"/live-sessions/{client_id}")
        resp.raise_for_status()
        return resp.json().get("state") or {}

    def finish(self, client_id: str, state: dict) -> None:
        """Stop what the scenario left running (a connection would otherwise
        hold on until nobody's been looking for two minutes) and delete it."""
        types = state.get("paneTypes") or {}
        for pane in state.get("services") or []:
            run = state.get(f"{pane}.out.run")
            if isinstance(run, dict) and run.get("status") == "running":
                self.http.post(f"/panes/{types.get(pane, pane)}/stop", json={"session": client_id, "pane": pane})
        self.http.delete(f"/live-sessions/{client_id}")


def _matches(actual: Any, expected: Any) -> bool:
    """A value against an expectation: a plain value is equality; `contains`
    a list member or substring; `row` a list holding a dict with those keys;
    `has` a dict with those keys; `startswith` a string's start; `not` the
    opposite."""
    if isinstance(expected, dict) and len(expected) == 1:
        (op, want), = expected.items()
        if op == "contains":
            return actual is not None and want in actual
        if op == "row":
            return isinstance(actual, list) and any(
                isinstance(r, dict) and all(r.get(k) == v for k, v in want.items()) for r in actual
            )
        if op == "has":
            return isinstance(actual, dict) and all(actual.get(k) == v for k, v in want.items())
        if op == "startswith":
            return isinstance(actual, str) and actual.startswith(want)
        if op == "not":
            return not _matches(actual, want)
    return actual == expected


def _judge_proposal(want: dict, turns: list[Turn], checked: Optional[dict]) -> list[str]:
    """A build scenario's `proposed`: something reached the editor; with
    `checks: true`, it checks clean as the editor's Check says; `contains`,
    text it must hold."""
    proposed = next((t.proposed for t in reversed(turns) if t.proposed), None)
    if proposed is None:
        return ["Nothing was put in the editor."]
    failures = []
    if want.get("checks") and checked is not None and not checked.get("ok"):
        problems = "; ".join(str(e.get("message")) for e in checked.get("errors") or [])
        failures.append(f"What's in the editor doesn't check clean: {problems[:300]}")
    for text in want.get("contains") or []:
        if text not in proposed:
            failures.append(f"What's in the editor has no {text!r}.")
    return failures


def judge(scenario: dict, turns: list[Turn], state: dict, names: dict[str, Any],
          checked: Optional[dict] = None) -> list[str]:
    """What the scenario expected and didn't get, in a sentence each.
    `checked` is the editor's Check of a build scenario's proposal."""
    failures: list[str] = []
    last = turns[-1]
    if last.error:
        failures.append(f"The turn failed: {last.error}")
    for expect in _fill(scenario.get("expect", []), names):
        if "pane" in expect:
            pane = expect["pane"]
            if pane not in (state.get("services") or []):
                failures.append(f"The session has no pane {pane}.")
                continue
            for key, want in (expect.get("inputs") or {}).items():
                got = state.get(f"{pane}.in.{key}")
                if not _matches(got, want):
                    failures.append(f"{pane}'s input {key} is {json.dumps(got)}, expected {json.dumps(want)}.")
            if "run" in expect:
                run = state.get(f"{pane}.out.run")
                got = run.get("status") if isinstance(run, dict) else "not running"
                if not _matches(got, expect["run"]):
                    failures.append(f"{pane}'s run is {got}, expected {expect['run']}.")
            for key, want in (expect.get("outputs") or {}).items():
                got = state.get(f"{pane}.out.{key}")
                if not _matches(got, want):
                    failures.append(f"{pane}'s output {key} is {json.dumps(got)[:120]}, expected {json.dumps(want)}.")
            for key, want in (expect.get("view") or {}).items():
                got = state.get(f"{pane}.view.{key}")
                if not _matches(got, want):
                    failures.append(f"{pane}'s view {key} is {json.dumps(got)[:120]}, expected {json.dumps(want)}.")
        if "answer_check" in expect:
            checks = [s for s in last.steps if s.get("name") == "check_answer"]
            got = "ok" if checks and checks[-1].get("ok") else ("failed" if checks else "not run")
            if got != expect["answer_check"]:
                found = checks[-1].get("summary", "") if checks else ""
                failures.append(f"The answer check {got}, expected {expect['answer_check']}. {found}".strip())
        if "proposed" in expect:
            failures += _judge_proposal(expect["proposed"], turns, checked)
        if expect.get("tried"):
            # D153: the draft was run where the user chose, and nothing it
            # shows came back empty.
            tries = [s for t in turns for s in t.steps if s.get("name") == "try_definition"]
            if not tries:
                failures.append("The draft was never tried.")
            elif not tries[-1].get("ok") or '"ok": true' not in (tries[-1].get("summary") or ""):
                failures.append(f"Tried, it didn't work: {(tries[-1].get('summary') or '')[:300]}")
        if "answer" in expect and not _matches(last.answer, expect["answer"]):
            failures.append(f"The answer doesn't match {json.dumps(expect['answer'])}: {last.answer[:200]!r}")
    return failures


def run_build(platform: Platform, scenario: dict, names: dict[str, Any]) -> tuple[list[str], dict]:
    """A build scenario: its messages beside an editor holding `build`'s
    draft, each turn starting from what the last put there (as the editor
    would), judged on what ends up in it."""
    build = platform.draft(scenario)
    if scenario["build"].get("try_on"):
        build["try_on"] = _fill(scenario["build"]["try_on"], names)
    platform.fake_aws(scenario.get("aws") or [])
    history: list[dict] = []
    turns: list[Turn] = []
    for message in scenario["messages"]:
        history.append({"role": "user", "content": _fill(message, names)})
        turn = platform.ask(None, history, build=build)
        turns.append(turn)
        if turn.proposed:
            build = {**build, "source": turn.proposed, "files": turn.files or build.get("files") or {}}
        history.append({"role": "assistant", "content": turn.answer})
    proposed = next((t.proposed for t in reversed(turns) if t.proposed), None)
    checked = platform.check(proposed, build.get("files")) if proposed else None
    failures = judge(scenario, turns, {}, names, checked)
    record = {
        "turns": [{"answer": t.answer, "steps": [s["name"] if s.get("ok") else f"{s['name']} failed: "
                                                 f"{(s.get('summary') or '')[:300]}" for s in t.steps],
                   "notices": t.notices, "error": t.error} for t in turns],
        "proposed": proposed,
        "failures": failures,
    }
    return failures, record


def run_once(platform: Platform, scenario: dict, names: dict[str, Any]) -> tuple[list[str], dict]:
    if "build" in scenario:
        return run_build(platform, scenario, names)
    client_id = platform.start(scenario, names)
    history: list[dict] = _fill(scenario.get("earlier", []), names)
    turns: list[Turn] = []
    state: dict = {}
    try:
        for message in scenario["messages"]:
            history.append({"role": "user", "content": _fill(message, names)})
            turn = platform.ask(client_id, history)
            turns.append(turn)
            steps = [
                {"id": s["id"], "name": s["name"], "args": s.get("args") or {}, "ok": bool(s.get("ok")), "summary": (s.get("summary") or "")[:300]}
                for s in turn.steps
                if not s.get("preamble")
            ]
            history.append({"role": "assistant", "content": turn.answer, "steps": steps})
        # A background run writes its first results a moment after the turn.
        time.sleep(scenario.get("settle", 2))
        state = platform.state(client_id)
        failures = judge(scenario, turns, state, names)
    finally:
        platform.finish(client_id, state or platform.state(client_id))
    record = {
        "turns": [
            {
                "answer": t.answer,
                # What failed, with what it said; the rest by name.
                "steps": [s["name"] if s.get("ok") else f"{s['name']} failed: {(s.get('summary') or '')[:300]}" for s in t.steps],
                "notices": t.notices,
                "error": t.error,
            }
            for t in turns
        ],
        "failures": failures,
    }
    return failures, record


def load(names: list[str], tags: list[str]) -> list[dict]:
    scenarios = [yaml.safe_load(p.read_text()) | {"file": p.name} for p in sorted(SCENARIOS.glob("*.yaml"))]
    if names:
        return [s for s in scenarios if s["name"] in names]
    # Untagged scenarios are for the real model; a tagged one only when asked
    # for (`fake`: the scripted model's, to check the runner itself).
    if tags:
        return [s for s in scenarios if set(s.get("tags", [])) & set(tags)]
    return [s for s in scenarios if not s.get("tags")]


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("names", nargs="*", help="scenarios to run (default: all untagged)")
    parser.add_argument("--base", default="http://localhost:8000")
    parser.add_argument("--user", default="admin")
    parser.add_argument("--password", required=True)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--tag", action="append", default=[], help="run the scenarios with these tags")
    parser.add_argument("--out", help="write every run's transcript and failures here, as JSON")
    args = parser.parse_args(argv)

    platform = Platform(args.base, args.user, args.password)
    names = {"env": platform.env["name"], "env_id": platform.env["id"]}
    report: dict[str, Any] = {}
    failed = False
    for scenario in load(args.names, args.tag):
        runs = []
        for _ in range(args.repeat):
            failures, record = run_once(platform, scenario, names)
            runs.append(record)
        passed = sum(1 for r in runs if not r["failures"])
        failed = failed or passed < len(runs)
        report[scenario["name"]] = runs
        print(f"{'PASS' if passed == len(runs) else 'FAIL'} {scenario['name']}: {passed}/{len(runs)}")
        for i, r in enumerate(runs):
            for f in r["failures"]:
                print(f"    run {i + 1}: {f}")
    platform.close()
    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
