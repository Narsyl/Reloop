// Preload for CLI scripts (tsx -r): `server-only` throws outside a Next.js server bundle.
// Stubbing it here is safe for read-only operational scripts run from the terminal.
const Module = require("module");
const orig = Module._load;
Module._load = function (request, ...rest) {
  if (request === "server-only") return {};
  return orig.call(this, request, ...rest);
};
