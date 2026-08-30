/**
 * Public paper-reader runtime entry point.
 *
 * V1 event payloads remain readable through the migration projection inside the
 * V2 engine, but every new command and model call is executed by V2.
 */
export * from './paper-reader-v2-engine.js';
