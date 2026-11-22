FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_THREAD_LIMIT=1

WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
        passwd \
        tesseract-ocr \
        tesseract-ocr-eng \
        tesseract-ocr-hin \
        tesseract-ocr-guj \
        libjpeg62-turbo \
        libtiff6 \
        libopenjp2-7 \
        libwebp7 \
        libfreetype6 \
        liblcms2-2 \
        libharfbuzz0b \
        libfribidi0 \
        libxcb1 \
        zlib1g \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
COPY frontend/ ./frontend/

RUN groupadd --gid 10001 jansathi \
    && useradd --uid 10001 --gid jansathi --create-home --shell /usr/sbin/nologin jansathi \
    && mkdir -p /app/data/uploads \
    && chown -R jansathi:jansathi /app/backend /app/frontend /app/data

USER jansathi

CMD ["sh", "-c", "exec uvicorn backend.main:app --host 0.0.0.0 --port \"${PORT:-8000}\""]
