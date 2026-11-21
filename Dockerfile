FROM python:3.13-slim
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .
# Mount a persistent volume here: it holds your Garmin tokens, cached data
# and check-in history.
ENV GARMIN_HEALTH_DATA_DIR=/data
VOLUME /data
EXPOSE 8000
CMD ["garmin-health-mcp", "--http", "--host", "0.0.0.0", "--port", "8000"]
