FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run lint \
    && npm run build \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r workers/historical_indexer/requirements.txt \
    && /opt/venv/bin/python -c "import asyncpg, pyrogram; print('Historical indexer dependencies verified')" \
    && npm prune --omit=dev

ENV PATH="/opt/venv/bin:${PATH}"

EXPOSE 10000

CMD ["npm", "start"]
