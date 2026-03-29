# Node + Puppeteer Image (contains all the required Linux dependencies for Chrome out-of-the-box!)
FROM ghcr.io/puppeteer/puppeteer:19.7.2

# Tell Puppeteer to skip downloading another Chrome, and use the one built into the container
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Switch to root to copy files 
USER root 
WORKDIR /app

# Copy package info and install
COPY package*.json ./
RUN npm ci

# Copy the rest of the application
COPY . .

# IMPORTANT: Ensure the non-root user (pptruser) owns the files so it can write the zip/cache
RUN chown -R pptruser:pptruser /app

# Switch back to the specialized puppeteer user for safety
USER pptruser

# Enforce strict memory limit on Node.js so it doesn't crash the 512MB Render container
# Node doesn't know it's in a 512MB container and will use RAM infinitely unless capped!
ENV NODE_OPTIONS="--max-old-space-size=200"

# Expose Render's default port
EXPOSE 10000

# Start the bot
CMD ["node", "index.js"]