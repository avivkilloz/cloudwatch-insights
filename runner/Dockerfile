FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY sdk ./sdk
# Every job reads the SDK and its bootstrap as its own slot's uid (D132):
# readable by all, writable by none of them.
RUN chmod -R a+rX,go-w /app

# Root inside the container, on purpose: it's what lets each job drop to a
# uid of its own slot, so jobs can't read each other or the runner. The jobs
# never run as root; the pod's securityContext drops every capability but
# the three that dropping needs (Helm: runner.securityContext).
EXPOSE 8200

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8200"]
