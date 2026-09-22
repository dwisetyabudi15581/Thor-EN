// pm2 ecosystem — run the Thor bot as a 24/7 service.
//
// Usage (from this repo root, after ./setup.sh and .env is filled):
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup     // auto-start when the VPS reboots
//
// Daily commands:
//   pm2 status                  // thor-bot must be online
//   pm2 logs thor-bot
//   pm2 restart thor-bot
//
// v4.1.0: this repository is the BOT ONLY. The web dashboard runs as its
// own pm2 app (thor-dash) from the SEPARATE Thor-EN-Dashboard repository —
// see that repo's ecosystem.config.cjs.
module.exports = {
  apps: [
    {
      name: "thor-bot",
      script: "index.js",
      cwd: __dirname,
      time: true,
      max_memory_restart: "400M",
    },
  ],
};
