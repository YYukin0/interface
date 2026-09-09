/**
 * The cheap half: turn one recorded run into a reviewable, replayable artifact.
 *
 *   compile.ts      recording.jsonl → capability.json, and every inference it warns about
 *   checkpoints.ts  what appeared on screen → an assertion replay can evaluate
 *   contract.ts     the inputs and outputs a calling agent sees
 *
 * Nothing here talks to a model or to a browser. It reads a directory and
 * returns a value, which is why the heuristics above can be improved and
 * re-run against every recording ever captured without paying for another
 * discovery run.
 */
export { RecordingCompiler, COMPILER_VERSION, type CompilerOptions } from './compile.js';
export { inferCheckpoint, type InferredCheckpoint } from './checkpoints.js';
export { buildContracts, type Contracts } from './contract.js';
