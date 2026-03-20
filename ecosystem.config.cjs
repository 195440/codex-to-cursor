module.exports = {
  apps: [
    {
      name: "codex-to-cursor",
      cwd: __dirname,
      script: "dist/src/index.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      kill_timeout: 5000,
      time: true,
      env: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
