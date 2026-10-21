"""The jobs of each environment, a row each, with their execution counts.

A job's counts are only in DescribeJob's reply, so each job is described
after it's listed. A job makes at most 200 calls, so each environment's
listing stops at MAX_JOBS."""

MAX_JOBS = 50

# Columns from DescribeJob's jobProcessDetails.
COUNTS = {
    "Queued": "numberOfQueuedThings",
    "In progress": "numberOfInProgressThings",
    "Succeeded": "numberOfSucceededThings",
    "Failed": "numberOfFailedThings",
    "Timed out": "numberOfTimedOutThings",
}


def run(inputs, ctx):
    chosen = inputs.get("connections") or []
    if not isinstance(chosen, list):
        chosen = [chosen]
    rows, failed = [], []
    for connection in chosen:
        name = ctx.name(connection)
        try:
            listed = ctx.aws(connection, "iot", "ListJobs", {"status": inputs.get("status") or "IN_PROGRESS"},
                             paginate=True)
        except Exception as e:  # one environment failing is said, the others still listed
            failed.append(f"{name}: {e}")
            continue
        jobs = listed.get("jobs", [])
        if len(jobs) > MAX_JOBS:
            ctx.log(f"{name}: {len(jobs)} jobs, the first {MAX_JOBS} described")
        for job in jobs[:MAX_JOBS]:
            details = ctx.aws(connection, "iot", "DescribeJob", {"jobId": job["jobId"]})["job"]
            process = details.get("jobProcessDetails") or {}
            row = {"Environment": name, "Job ID": job["jobId"], "Status": job.get("status"),
                   "Created": job.get("createdAt")}
            row.update({column: process.get(field, 0) for column, field in COUNTS.items()})
            rows.append(row)
    return {"rows": rows, "error": "\n".join(failed) or None}
