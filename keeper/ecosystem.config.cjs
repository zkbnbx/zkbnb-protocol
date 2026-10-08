// pm2 process file for the zkBNB keeper. `pm2 start ecosystem.config.cjs`
//
// Privacy stage 2 adds two more apps, each OPT-IN so that this file starts exactly the stage-1 keeper on a host
// that has not been set up for them:
//   grove-coordinator  ENABLE_COORDINATOR=1 pm2 start ecosystem.config.cjs --only grove-coordinator
//   grove-relayer      ENABLE_RELAYER=1 pm2 start ecosystem.config.cjs --only grove-relayer   (keeper/src/relayer)
// In production the Coordinator and the relayer MUST run on DIFFERENT HOSTS, under different keys, with no shared
// logs (privacy/PRIVACY-SPEC.md section 2.10 / 5.2): the relayer sees IPs and public inputs, the Coordinator holds
// the key that could decrypt intents. Never run both on the VPS that serves the other. `all` never runs either.
const apps = [
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
];

if (process.env.ENABLE_COORDINATOR === "1") {
  apps.push({
    name: "grove-coordinator",
    script: "node_modules/.bin/tsx",
    // opens / voids epochs every 15 s; daily key rotation is a cron job on the same host:
    //   0 3 * * *  cd <keeper> && npx tsx src/index.ts rotate-key --once
    args: "src/index.ts coordinator --interval 15",
    cwd: __dirname,
    env: { NODE_ENV: "production" },
    autorestart: true,
    max_restarts: 50,
    restart_delay: 10_000,
    time: true,
  });
}

if (process.env.ENABLE_RELAYER === "1") {
  apps.push({
    // stage-2 relayer (HTTP, RELAYER_PORT, default 8788 on 127.0.0.1 behind the reverse proxy / Tor hidden service).
    // MUST run on a different host from grove-coordinator (see the comment at the top). Its own wallet:
    // RELAYER_PRIVATE_KEY, never KEEPER_PRIVATE_KEY. It writes no access log; pm2's own log gets one line per send.
    name: "grove-relayer",
    script: "node_modules/.bin/tsx",
    args: "src/index.ts relayer",
    cwd: __dirname,
    env: { NODE_ENV: "production" },
    autorestart: true,
    max_restarts: 50,
    restart_delay: 10_000,
    time: true,
  });
}

module.exports = { apps };
