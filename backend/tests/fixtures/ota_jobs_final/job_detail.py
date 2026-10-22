def run(inputs, ctx):
    connection = inputs.get("connection")
    job_id = inputs.get("jobId")
    
    if not connection or not job_id:
        return {"error": "Missing connection or jobId"}
    
    result = ctx.aws(connection, "iot", "DescribeJob", {"jobId": job_id})
    job = result.get("job", {})
    
    # Build targets list
    targets = []
    for target in job.get("targets", []):
        target_type = "unknown"
        name = target
        
        if target and ("/thing/" in target or target.endswith("/*")):
            target_type = "thing"
            name = target.split("/")[-1] if "/" in target else target
        elif target and "/thinggroup/" in target:
            target_type = "thing_group"
            name = target.split("/")[-1] if "/" in target else target
        
        targets.append({
            "name": name,
            "type": target_type,
            "arn": target
        })
    
    # Get job document from documentSource or document field
    job_document = None
    
    # First check documentSource in the DescribeJob response
    document_source = result.get("documentSource")
    if document_source:
        if document_source.startswith("http://") or document_source.startswith("https://"):
            try:
                resp = ctx.http(None, document_source, method="GET")
                if resp.status == 200:
                    job_document = resp.json()
                else:
                    job_document = {"error": f"Could not fetch document: HTTP {resp.status}"}
            except Exception as e:
                job_document = {"error": f"Failed to fetch document: {str(e)}"}
        else:
            # Try to parse as JSON, otherwise use as string
            try:
                import json
                job_document = json.loads(document_source)
            except:
                job_document = document_source
    
    # Fallback to document field in the job
    if job_document is None:
        job_document = job.get("document")
    
    # Final fallback if still None
    if job_document is None:
        job_document = {"info": "No job document available"}
    
    # Get job process details
    jpd = job.get("jobProcessDetails", {})
    
    # Return snake_case keys matching the YAML template expectations
    return {
        "job_id": job.get("jobId"),
        "status": job.get("status"),
        "target_selection": job.get("targetSelection"),
        "description": job.get("description", ""),
        "is_concurrent": job.get("isConcurrent", False),
        "job_document": job_document,
        "job_process_details": str(jpd),
        "targets": targets,
        "created_at": job.get("createdAt"),
        "last_updated_at": job.get("lastUpdatedAt"),
        "completed_at": job.get("completedAt")
    }
