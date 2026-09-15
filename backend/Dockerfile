FROM python:3.12-slim AS base

WORKDIR /app

RUN groupadd -r app && useradd -r -g app app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV DATA_DIR=/data
RUN mkdir -p /data && chown app:app /data

USER app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
