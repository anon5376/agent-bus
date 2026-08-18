#!/usr/bin/env node
// Stable daemon entrypoint used by dist/cli.js when it spawns broker/dashboard/supervisors.
// Keeping this tiny shim at the repository root avoids installation-path assumptions.
import "./dist/cli.js";
