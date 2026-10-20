"""Rows that open to show more, in a built pane (D124): a column that picks a
list item by a field (`Tags[Key=Name].Value`, AWS's tags), a request run for
one row (its detail), and a table whose rows open -- what the Builder's
agent couldn't make of an EC2 pane: it wrote JMESPath the check refused four
times over, and a table config (`on_select`) nothing reads."""

import pytest
from botocore.stub import Stubber

from app import aws_client, builder, row_paths
from app.platform_tools.panes import InputError, extract_rows
from tests.conftest import client

# What the agent wrote, as the user pasted it.
WRITTEN = """label: EC2 instances
description: List and inspect EC2 instances across environments.
category: Services
inputs:
  - key: connections
    type: connections
    connection_type: aws
    label: Environments
  - key: instance_id
    type: text
    label: Instance ID
    optional: true
actions:
  - id: list
    main: true
    run_label: List instances
    request:
      connection: connections
      service: ec2
      operation: DescribeInstances
      paginate: true
      rows:
        at: Reservations
        explode: Instances
        columns:
          Instance ID: InstanceId
          Name:
            from: Tags[?Key == 'Name'].Value | [0]
            as: text
          State: State.Name
  - id: detail
    run_label: View details
    request:
      connection: connections
      service: ec2
      operation: DescribeInstances
      params:
        InstanceIds:
          - input: instance_id
      rows:
        at: Reservations
        explode: Instances
      output: detail
    on_change:
      - instance_id
outputs:
  - key: rows
    render: table
    actions: [select, copy, export, attach]
    config:
      select_key: Instance ID
      on_select:
        set:
          instance_id: '{Instance ID}'
        run: detail
  - key: detail
    render: json
  - key: error
    render: error
layout:
  - title: Instances
    items:
      - input: connections
      - toolbar:
          - action: list
      - output: error
      - output: rows
"""

# What it can be: the table's rows open, each fetching its instance.
EC2 = """label: EC2 instances
description: List EC2 instances; open one for its detail.
category: Services
inputs:
  - {key: connections, type: connections, connection_type: aws, label: Environments}
actions:
  - id: list
    main: true
    run_label: List instances
    resets: [view.expanded]
    request:
      connection: connections
      service: ec2
      operation: DescribeInstances
      paginate: true
      rows:
        at: Reservations
        explode: Instances
        columns:
          Instance ID: InstanceId
          Name: Tags[Key=Name].Value
          State: State.Name
  - id: instance
    args: {connections: row.Environment, instance_id: row.Instance ID}
    request:
      connection: connections
      service: ec2
      operation: DescribeInstances
      params: {InstanceIds: {input: instance_id}}
      rows: {at: Reservations, explode: Instances}
outputs:
  - key: rows
    render: table
    actions: [select, copy, export, attach]
    config:
      expand: expanded
      detail:
        action: instance
        sections:
          - fields:
              - {label: Type, value: "{{ d.InstanceType }}"}
              - {label: Private IP, value: "{{ d.PrivateIpAddress }}"}
          - {title: Tags, table: Tags, columns: [{label: Key, value: "{{ row.Key }}"}, {label: Value, value: "{{ row.Value }}"}]}
  - key: error
    render: error
views:
  - {key: expanded, default: []}
layout:
  - title: Instances
    items:
      - input: connections
      - toolbar:
          - action: list
      - output: error
      - output: rows
"""


def _check(source: str) -> list[str]:
    try:
        builder.parse(source, "ec2")
    except builder.BuilderError as e:
        return [x["message"] for x in e.errors]
    return []


# ---------------------------------------------------------------- paths


@pytest.mark.parametrize("path", ["Tags[Key=Name].Value", "Tags[?Key=='Name'].Value", "Tags[?Key == 'Name'].Value | [0]",
                                  'Tags[Key="Name"].Value'])
def test_a_tag_is_picked_by_its_key(path):
    reply = {"Items": [{"Tags": [{"Key": "env", "Value": "prod"}, {"Key": "Name", "Value": "web-1"}]}, {"Tags": []}]}
    rows = extract_rows(reply, {"at": "Items", "columns": {"Name": path}})
    assert rows == [{"Name": "web-1"}, {"Name": None}]


def test_what_a_path_cant_say_is_said():
    with pytest.raises(row_paths.PathError, match="not JMESPath"):
        row_paths.parts("Tags[*].Value")
    with pytest.raises(row_paths.PathError, match="not JMESPath"):
        row_paths.parts("Tags | length(@)")
    with pytest.raises(InputError, match="stopped at '\\[Key=Name\\]'"):
        extract_rows({"Items": {"Tags": []}}, {"at": "Items.Tags[Key=Name]"})


def test_a_path_is_checked_against_the_operations_reply():
    errors = _check(EC2.replace("Tags[Key=Name].Value", "Tags.Name"))
    assert errors == ["DescribeInstances's Instances (in each of Reservations) have no Tags.Name: Tags is a list, so "
                      "there is no Name in it; pick one item by a field, as Tags[Key=…].Name."], errors
    errors = _check(EC2.replace("Tags[Key=Name].Value", "Tags[Nope=Name].Value"))
    assert any("Tags's items have no Nope to pick one by (they have: Key, Value)" in e for e in errors), errors


# ---------------------------------------------------------------- the check


def test_what_the_agent_wrote_is_told_what_a_table_reads():
    errors = _check(WRITTEN)
    # The JMESPath filter is read; the config nothing reads is said, with what it may say.
    assert not any("Tags" in e for e in errors), errors
    assert any("A table output's config has no select_key; it may say: detail, expand, domain, chart. Rows that open" in e
               for e in errors), errors
    assert any("config has no on_select" in e for e in errors), errors


def test_rows_open_only_with_a_view_key_and_sections_are_held_to_what_they_draw():
    assert _check(EC2) == []
    assert _check(builder.DETAIL_EXAMPLE) == []
    no_view = EC2.replace("views:\n  - {key: expanded, default: []}\n", "")
    assert any("Rows open only with `expand:`" in e for e in _check(no_view))
    assert any("A detail section has no rows" in e for e in _check(EC2.replace("- fields:", "- rows:")))


# ---------------------------------------------------------------- running it


INSTANCE = {"InstanceId": "i-1", "InstanceType": "t3.micro", "PrivateIpAddress": "10.0.0.5",
            "State": {"Name": "running"}, "Tags": [{"Key": "Name", "Value": "web-1"}]}


def _stubbed(monkeypatch, calls: list[tuple[dict, dict]]):
    """DescribeInstances answering `calls` in order: (expected params, reply)."""

    def fake(service, account_id, region, identity):
        real = aws_client.boto3.client(service, region_name=region, aws_access_key_id="x", aws_secret_access_key="y")
        stub = Stubber(real)
        for params, reply in calls:
            stub.add_response("describe_instances", reply, params)
        stub.activate()
        return real

    monkeypatch.setattr(aws_client, "get_client", fake)


def test_a_row_opens_with_its_own_request_as_the_caller(monkeypatch):
    assert client.post("/api/builder/panes", json={"id": "ec2", "source": EC2}).status_code == 201
    prod = client.post("/api/environments", json={"name": "Prod", "account_id": "111122223333",
                                                  "region": "eu-west-1"}).json()["id"]
    _stubbed(monkeypatch, [({}, {"Reservations": [{"Instances": [INSTANCE]}]})])
    listed = client.post("/api/panes/ec2/actions/list", json={"inputs": {"connections": [prod]}})
    assert listed.status_code == 200, listed.text
    [row] = listed.json()["rows"]
    assert row == {"Environment": "Prod", "Instance ID": "i-1", "Name": "web-1", "State": "running"}

    # Opened: the row action's args from the row -- its environment by the
    # name the table shows, the one id given where AWS takes a list.
    _stubbed(monkeypatch, [({"InstanceIds": ["i-1"]}, {"Reservations": [{"Instances": [INSTANCE]}]})])
    opened = client.post("/api/panes/ec2/actions/instance", json={"inputs": {"connections": "Prod", "instance_id": "i-1"}})
    assert opened.status_code == 200, opened.text
    assert opened.json()["InstanceType"] == "t3.micro" and opened.json()["Tags"][0]["Value"] == "web-1"

    nowhere = client.post("/api/panes/ec2/actions/instance", json={"inputs": {"connections": "Elsewhere", "instance_id": "i-1"}})
    assert nowhere.status_code == 400 and "no AWS environment called 'Elsewhere'" in nowhere.text
