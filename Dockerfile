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

# IMPORTANT: HF Spaces strictly runs Docker containers as User ID 1000.
# We must give full permissions to the workspace so it can extract the zip files!
RUN chmod -R 777 /app
RUN chown -R 1000:1000 /app

# Switch to standard Hugging Face UID 
USER 1000

# Expose Hugging Face Default Port
EXPOSE 7860

# Start the bot
CMD ["node", "index.js"]