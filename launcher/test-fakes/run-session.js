#!/usr/bin/env node
// Runs the launcher in its own process, as `npm run phone` does, with the
// options in FAKE_SESSION_OPTIONS (JSON). Tests use it to press Ctrl+C on a
// real launcher process and to stop one from another process.

const { startPhone } = require('../supervisor');

const options = JSON.parse(process.env.FAKE_SESSION_OPTIONS);
startPhone({ ...options, handleSignals: true }).done.then((code) => process.exit(code));
