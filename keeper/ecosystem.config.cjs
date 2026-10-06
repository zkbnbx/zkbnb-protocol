// pm2 process file for the zkBNB keeper. `pm2 start ecosystem.config.cjs`
module.exports = {
  apps: [
    {
      name: process.env.PM2_NAME || "zkbnb-keeper",
      script: "node_modules/.bin/tsx",
      args: "src/index.ts all",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 10_000,
      time: true,
    },
  ],
};
