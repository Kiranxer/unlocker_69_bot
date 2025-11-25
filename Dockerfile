# Dockerfile
FROM python:3.10-slim

# avoid debconf interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# set working dir
WORKDIR /app

# copy only what we need first (for layer caching)
COPY requirements.txt .

# install system deps required by some Python packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential gcc libpq-dev curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# install python deps
RUN pip install --upgrade pip
RUN pip install --no-cache-dir -r requirements.txt

# copy application code
COPY . .

# ensure env vars are read by process (set these in Koyeb UI, do NOT hardcode)
ENV PYTHONUNBUFFERED=1

# default command
CMD ["python", "main.py"]
