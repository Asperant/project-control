/**
 * @project-control/contracts
 *
 * Single source of truth for every request and response that crosses the
 * browser <-> Caddy <-> Control API boundary. Both sides import from here, so a
 * shape can never drift between client and server without a type error.
 *
 * Every schema is a *runtime* validator (Zod), not just a type: the API parses
 * untrusted input with these, and the web panel parses untrusted responses with
 * them too. Nothing is trusted because of where it came from.
 */

export * from './common.js';
export * from './auth.js';
export * from './system.js';
export * from './artifacts.js';
export * from './projects.js';
export * from './errors.js';
