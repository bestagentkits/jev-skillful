#!/usr/bin/env node
import { run } from "./cli.js";

// Set the exit code rather than calling process.exit(): the catalog command can
// write megabytes of JSON, and process.exit() would terminate the process before
// pending stdout writes flush, truncating the output into invalid JSON.
process.exitCode = await run(process.argv.slice(2));
