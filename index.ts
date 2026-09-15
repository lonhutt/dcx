#!/usr/bin/env bun

const args = Bun.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`
🚀 My Custom Bun CLI

Usage:
  dcx <name>        Greets a user by name
  dcx --version, -v Shows current version
  dcx --help, -h    Shows this help menu
  `);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log("1.0.0");
  process.exit(0);
}

const name = args[0];
console.log(`✨ Hello, ${name}! Welcome to your Bun-powered CLI.`);
