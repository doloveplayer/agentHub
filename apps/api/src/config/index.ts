// Re-export config so that both config.ts and config/index.ts resolve to the same object.
// (Resolver may prefer one over the other depending on the bundler/runtime.)
export { config } from '../config.js';
