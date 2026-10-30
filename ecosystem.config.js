module.exports = {
  apps: [
    {
      name: "flash-arb-bot",
      script: "bot/run.js",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        LOG_FORMAT: "json",
        DRY_RUN: "true",
      },
    },
  ],
};
