# =================================================================
# LLM Assessor & Annotation Playground
# Production Dockerfile
# =================================================================

FROM python:3.11-slim

LABEL maintainer="AI Evaluation Community"
LABEL vendor="Open Source"
LABEL description="Интерактивный тренажер асессора и песочница разметки данных (SFT / DPO / RLHF / CV / NLP)"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app

# Создание непривилегированного пользователя appuser и передача прав на /app
RUN groupadd -g 1001 appgroup && \
    useradd -u 1001 -g appgroup -s /bin/sh -m appuser && \
    chown -R appuser:appgroup /app

# Копирование исходного кода приложения
COPY --chown=appuser:appgroup data/ /app/data/
COPY --chown=appuser:appgroup index.html /app/index.html
COPY --chown=appuser:appgroup server.py /app/server.py
COPY --chown=appuser:appgroup init_db.py /app/init_db.py

# Инициализация базы данных
RUN python3 init_db.py && \
    chown -R appuser:appgroup /app

# Переключение на непривилегированного пользователя
USER appuser

EXPOSE 8000

# Healthcheck встроенными средствами Python
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request, sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/').getcode() == 200 else 1)"

CMD ["python3", "server.py"]
