// Vercel serverless entry point: the whole Express app runs as one function.
// Static assets in /public are served by Vercel's CDN before reaching here.
const { createApp } = require('../src/server');

let appPromise;

module.exports = async (req, res) => {
  appPromise = appPromise || createApp();
  const app = await appPromise;
  return app(req, res);
};
