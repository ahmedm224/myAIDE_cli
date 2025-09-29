#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./ui/App";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));

const program = new Command();

program
  .name("myaide")
  .description("Interactive multi-agent coding assistant")
  .argument("[request...]", "Optional initial request")
  .option("-v, --version", "Output version")
  .action((requestParts: string[], options: { version?: boolean }) => {
    if (options.version) {
      // eslint-disable-next-line no-console
      console.log(pkg.version ?? "0.0.0");
      process.exit(0);
    }
    const request = requestParts.join(" ") || undefined;
    render(React.createElement(App, { initialRequest: request }));
  });

program.parse(process.argv);
