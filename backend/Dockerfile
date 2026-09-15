FROM python:3.12-slim AS base

WORKDIR /app

RUN groupadd -r -g 1000 app && useradd -r -u 1000 -g app app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Numeric UID/GID -- Kubernetes' runAsNonRoot check can't verify a named
# user from image metadata alone, and fails closed ("cannot verify user
# is non-root") if the image's USER isn't numeric.
USER 1000:1000

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
