"""One job opened: its description, its document and every execution.

The row action's inputs are its args, read from the row: `connection` is
the row's Environment (a name, which ctx.aws takes) and `job_id` its Job ID.
What run returns is the detail the sections read as `d`."""

import json


def run(inputs, ctx):
    connection, job_id = inputs["connection"], inputs["job_id"]
    job = ctx.aws(connection, "iot", "DescribeJob", {"jobId": job_id})["job"]
    document = ctx.aws(connection, "iot", "GetJobDocument", {"jobId": job_id}).get("document") or ""
    try:
        document = json.loads(document)
    except ValueError:
        pass  # not JSON: shown as the text it is
    listed = ctx.aws(connection, "iot", "ListJobExecutionsForJob", {"jobId": job_id}, paginate=True)
    executions = [
        {"thing": e["thingArn"].rsplit("/", 1)[-1], "status": e["jobExecutionSummary"].get("status"),
         "updated": e["jobExecutionSummary"].get("lastUpdatedAt")}
        for e in listed.get("executionSummaries", [])
    ]
    targets = ", ".join(t.rsplit("/", 1)[-1] for t in job.get("targets", []))
    return {"job": job, "document": document, "targets": targets, "executions": executions}
