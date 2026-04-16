# Pin to a known-good Puppeteer image instead of :latest which can
# silently break when Chrome updates its headless implementation.
FROM ghcr.io/puppeteer/puppeteer:latest

# Point Puppeteer at the pre-installed Chrome for Testing cache.
# Do NOT hardcode an executablePath — let Puppeteer auto-detect from cache.
ENV PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer

USER root
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Pre-create directories that RemoteAuth and webVersionCache need at runtime.
# Without these, writes fail silently as UID 1000 and cause init timeouts.
RUN mkdir -p /app/.wwebjs_auth /app/.wwebjs_cache /app/generated-pdfs \
    && chmod -R 777 /app \
    && chown -R 1000:1000 /app

USER 1000
EXPOSE 7860

CMD ["node", "index.js"]