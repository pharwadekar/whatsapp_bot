const {join} = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Changes the cache location for Puppeteer to be strictly inside the project folder
  // so that Render doesn't wipe it out between the build phase and the deploy phase.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
