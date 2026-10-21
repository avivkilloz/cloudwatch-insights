# Agent scenarios

Replayable conversations, each with what the session should hold afterwards,
run against a real model (PLATFORM_PLAN.md D55). The tests in `../tests` pin
the agent's mechanics against a scripted model; these say how well a given
model and prompt actually do the job, as a pass rate over several runs.

```bash
# The stack: backend as dev.fake_aws:app (an environment whose account starts
# 0000 is answered in-process), the agent, and the model behind LiteLLM.
cd platform-agent
python -m evals.run --password '<admin password>' --repeat 3 --out report.json
python -m evals.run --password '…' mqtt-connect-and-subscribe   # one scenario
python -m evals.run --password '…' --tag fake                   # the runner itself, on dev/fake_llm.py
```

It signs in as an admin to set up an `evals` group (every page, the agent, a
role on the fake environment) and a user in it, and runs every scenario as
that user. Development stacks only.

A scenario (`scenarios/*.yaml`) is a session to start from (`panes`, any
`state` keys), optional `earlier` turns, the `messages`, and `expect`:

- `pane: <id>` with `inputs`, `outputs`, `view` (each key's expected value, or
  `{contains: …}`, `{row: {…}}`, `{has: {…}}`, `{startswith: …}`, `{not: …}`)
  and `run` (`running`, `done`, `stopped`, `not running`);
- `answer_check: ok` -- the platform's own check of the last answer passed;
- `answer: …` -- the answer's text, matched the same way.

A build scenario (`build:` an editor's `kind`, `source` or `start` -- an
example's -- and `files`) is judged on what reaches the editor: `proposed`
(`checks: true`, `contains: [...]`). With `build.try_on: "{env}"` the Builder
tries its draft there (D153), AWS answering with the scenario's `aws:`
replies (`service`, `operation`, `reply`); `tried: true` expects the last try
to have come back with nothing empty. A draft with code needs the runner
(`RUNNER_URL` on the backend).

`{env}` and `{env_id}` are the fake environment's name and id. Add one for
every conversation where the agent got it wrong: that is what the set is for.
