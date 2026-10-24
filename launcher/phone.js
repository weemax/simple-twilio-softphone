#!/usr/bin/env node
// npm run phone: start Operator with one command. See launcher/supervisor.js.

const { startPhone, stopPhone } = require('./supervisor');

const HELP = `Usage: npm run phone [-- options]

Starts the local service, React, the ngrok tunnel and the Operator desktop
app, waits until each is ready, and stops all of them when you quit Operator
or press Ctrl+C. Programs it did not start are never stopped.

Options:
  --react-port <port>     React's port (default 3000)
  --service-port <port>   the local service's port (default: PORT in server/.env, or 5050)
  --ngrok-url <address>   the fixed ngrok address for this run, such as
                          https://abc123xyz.ngrok-free.dev (default: NGROK_URL in
                          server/.env; without either, ngrok picks a new address)
  --stop                  stop the npm run phone running from this project, or
                          what an earlier one left running
  --help                  show this help
`;

function parse(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.split('=', 2);
    const value = () => {
      const v = inline !== undefined ? inline : argv[++i];
      const port = Number(v);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${flag} needs a port number from 1 to 65535.`);
      }
      return port;
    };
    if (flag === '--help' || flag === '-h') opts.help = true;
    else if (flag === '--stop') opts.stop = true;
    else if (flag === '--react-port') opts.reactPort = value();
    else if (flag === '--service-port') opts.servicePort = value();
    else if (flag === '--ngrok-url') {
      opts.ngrokUrl = inline !== undefined ? inline : argv[++i];
      if (!opts.ngrokUrl) throw new Error('--ngrok-url needs an https address, such as https://abc123xyz.ngrok-free.dev.');
    }
    else throw new Error(`Unknown option ${arg}. Run npm run phone -- --help.`);
  }
  return opts;
}

// A closed terminal must not stop the launcher before it stops its children.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

let opts;
try {
  opts = parse(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`[phone] ${err.message}\n`);
  process.exit(2);
}
if (opts.help) {
  process.stdout.write(HELP);
} else if (opts.stop) {
  stopPhone().then((code) => process.exit(code));
} else {
  startPhone({ reactPort: opts.reactPort, servicePort: opts.servicePort, ngrokUrl: opts.ngrokUrl }).done.then((code) =>
    process.exit(code)
  );
}
