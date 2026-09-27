FROM python:3.12-slim AS base

WORKDIR /app

RUN groupadd -r -g 1000 app && useradd -r -u 1000 -g app app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
# The scripted stand-in model (dev/fake_llm.py), so a local compose stack can
# run the whole agent path without a real model. Not used unless started.
COPY dev ./dev

# Numeric, like the backend's: Kubernetes' runAsNonRoot can only verify a
# numeric USER from image metadata.
USER 1000:1000

EXPOSE 8100

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
