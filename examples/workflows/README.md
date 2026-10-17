# Example workflows

Ready to paste into **Workflows → New workflow** (an admin's, for now): give it
an id, paste the file, **Check**, **Create**, then **Run ▸**. Each is checked
by the backend's tests (`test_the_example_workflows_are_valid`), so they stay
valid as the platform changes.

| File | Shows | Needs |
|---|---|---|
| `01-try-me.yaml` | notes, `for_each`, a bare approval, a JSON artifact | nothing |
| `02-cloudwatch-errors.yaml` | a background run (Logs Insights) waited for, `timeout`, `retry`, `if`, a CSV built from rows | an AWS environment, a log group |
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
