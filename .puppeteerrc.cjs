const {join} = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Use PUPPETEER_CACHE_DIR if set (Docker/HF), otherwise keep cache inside
  // the project folder (Render deploys wipe external dirs between phases).
  cacheDirectory: process.env.PUPPETEER_CACHE_DIR || join(__dirname, '.cache', 'puppeteer'),
};
