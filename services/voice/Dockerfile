# Build context is the repo root so the shared audit helper library can be
# copied in (see docker-compose: build.context: .., dockerfile: ...).
FROM python:3.12-slim
WORKDIR /app

# Install the shared audit helper library (Pattern 3: Audit Trail).
COPY contracts/lib/python/audit /tmp/audit-lib
RUN pip install --no-cache-dir /tmp/audit-lib

COPY services/voice/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/voice .
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${VOICE_PORT:-8084}"]
