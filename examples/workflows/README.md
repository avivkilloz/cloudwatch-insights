# Example workflows

Ready to paste into **Workflows → New workflow** (an admin's, for now): give it
an id, paste the file, **Check**, **Create**, then **Run ▸**. Each is checked
by the backend's tests (`test_the_example_workflows_are_valid`), so they stay
valid as the platform changes.

| File | Shows | Needs |
|---|---|---|
| `01-try-me.yaml` | notes, `for_each`, a bare approval, a JSON artifact | nothing |
| `02-cloudwatch-errors.yaml` | log groups listed from the chosen environment (`options_from`, `multiple`), a background run (Logs Insights) waited for, `timeout`, `retry`, `if`, a CSV built from rows | an AWS environment with log groups |
| `03-dynamodb-tables.yaml` | `for_each` over a list, `continue_on_error`, a CSV report | an AWS environment with DynamoDB |
| `04-iot-offline-devices.yaml` | several environments at once, one artifact per environment, `join` | AWS environments with IoT Fleet Indexing |
| `05-mqtt-listen.yaml` | a stream listened to for `listen` seconds | an AWS environment with IoT Core |
| `06-restart-with-signoff.yaml` | an external action (HTTP Send) behind an approval by someone else, a JSON body from a CEL map | an HTTP API connection to your ops API |
| `07-prometheus-down.yaml` | a request action, a summary with `join` | a Prometheus connection |

A run acts as whoever starts it: every step reaches only the panes and
environments their group has. Who else may run a workflow is its **Access**.

**Writing your own.** A step is a pane's action, by the names in its manifest
(`backend/app/panes/manifests/<pane>.yaml`: `id:` is the pane, `actions:` its
actions, `inputs:` what `with:` may set). Templates are CEL inside `{{ … }}`
over `params`, `steps.<id>.outputs` / `.status`, `item`, `index` and `run`,
with the strings (`join`, `split`, `replace`, `lowerAscii`…) and math
extensions. A template that is the whole value keeps its type (a list stays a
list); a map given to a text input (an HTTP body) is sent as its JSON.

**Parameters whose choices load.** A text parameter can list its choices the
way a pane's picker does: `options_from` names a pane input that has a loader
(`logs-cloudwatch`'s `logGroupSelection`, `tables`' `tableName`, `buckets`'
`bucket`…) and `with` gives the loader's inputs from the other parameters. The
form lists them as the person filling it in, again whenever those parameters
change, and still takes typed text. `multiple: true` makes it a list of values.

```yaml
  - key: groups
    multiple: true
    options_from:
      pane: logs-cloudwatch
      input: logGroupSelection
      with: { connections: "{{ [params.env] }}" }
```
