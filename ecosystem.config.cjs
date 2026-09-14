// pm2 ecosystem — run the bot + web dashboard as 24/7 services.
//
// Usage (from the repo root, after ./setup.sh and both .env files are filled):
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup     // auto-start when the VPS reboots
//
// Daily commands:
//   pm2 status                  // thor-bot + thor-dash must be online
//   pm2 logs thor-bot           /  pm2 logs thor-dash
//   pm2 restart all             // restart both
module.exports = {
  apps: [
    {
      name: "thor-bot",
      script: "index.js",
      cwd: __dirname,
      time: true,
      max_memory_restart: "400M",
    },
    {
      name: "thor-dash",
      script: "npm",
      args: "run start",
      cwd: __dirname + "/dashboard",
      time: true,
      max_memory_restart: "400M",
    },
  ],
};
