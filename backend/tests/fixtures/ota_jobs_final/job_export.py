def run(inputs, ctx):
    # Read selected rows from the jobs output state
    jobs_state = ctx.state.get("out", {}).get("jobs", {})
    rows = jobs_state.get("selected", [])
    
    if not rows:
        return {"error": "No jobs selected"}
    
    all_details = []
    errors = []
    
    for row in rows:
        connection = row.get("Environment")
        job_id = row.get("Job ID")
        
        if not connection or not job_id:
            errors.append(f"Missing connection or jobId in row")
            continue
        
        try:
            result = ctx.aws(connection, "iot", "DescribeJob", {"jobId": job_id})
            job = result.get("job", {})
            
            # Get job document content
            job_document = None
            document_source = result.get("documentSource")
            if document_source:
                if document_source.startswith("http://") or document_source.startswith("https://"):
                    try:
                        resp = ctx.http(None, document_source, method="GET")
                        if resp.status == 200:
                            job_document = resp.json()
                        else:
                            job_document = {"error": f"Could not fetch document: {resp.status}"}
                    except Exception as e:
                        job_document = {"error": str(e)}
            
            all_details.append({
                "job_id": job.get("jobId"),
                "status": job.get("status"),
                "job_document": job_document,
                "environment": connection
            })
        except Exception as e:
            errors.append(f"{connection}/{job_id}: {str(e)}")
    
    result = {"jobDetails": all_details}
    if errors:
        result["error"] = "; ".join(errors)
    
    return result
