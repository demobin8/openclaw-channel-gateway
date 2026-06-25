#!/usr/bin/env node

/**
 * Lite Gateway CLI bootstrap (CommonJS, cross-platform).
 *
 * npm's bin shim invokes this script. It spawns `node --import <loader> <cli>`
 * so the ESM loader hook activates before any module graph is built.
 */

"use strict";

const { spawn } = require("child_process");
const path = require("path");
const { pathToFileURL } = require("url");

const root = path.resolve(__dirname, "..");
const loader = pathToFileURL(path.join(root, "dist", "loader.js")).href;
const cli = path.join(root, "dist", "cli.js");

const args = ["--import", loader, cli, ...process.argv.slice(2)];

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  cwd: process.cwd(),
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  console.error("[ocg] Failed to start:", err.message);
  process.exit(1);
});
