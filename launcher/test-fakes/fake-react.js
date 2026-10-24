#!/usr/bin/env node
// Stand-in for the React dev server (react-scripts start) in launcher tests.
// Serves CRA's page shell on PORT once ready, and starts a helper process of
// its own, as react-scripts does, so tests can see whole-group shutdown.
//
// FAKE_REACT_MODE: ok (default) | never (answers 503 forever, like a build
//                  that never finishes)
// FAKE_REACT_RECORD: file to write { pid, helperPid } to

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const port = Number(process.env.PORT);
const mode = process.env.FAKE_REACT_MODE || 'ok';
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
if (process.env.FAKE_REACT_RECORD) {
  fs.writeFileSync(process.env.FAKE_REACT_RECORD, JSON.stringify({ pid: process.pid, helperPid: helper.pid }));
}

console.log('Starting the development server...');
http
  .createServer((req, res) => {
    if (mode === 'never') {
      res.writeHead(503);
      return res.end('still compiling');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!DOCTYPE html><html><head><title>Operator</title></head><body><div id="root"></div></body></html>');
  })
  .listen(port, '0.0.0.0', () => {
    if (mode !== 'never') console.log('Compiled successfully!');
  });
