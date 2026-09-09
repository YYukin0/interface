/**
 * What a run leaves behind.
 *
 *   writer.ts     the run directory, the redacted audit log, the summary
 *   recording.ts  the compiler's structured input, and readers for both files
 *   sink.ts       late-bound destination for the driver's captures
 */
export { FileEvidenceWriter, newRunId, type FileEvidenceOptions } from './writer.js';
export { EvidenceSink } from './sink.js';
export {
  RecordingWriter,
  readRecording,
  readRequest,
  readTrace,
  readManifest,
  TRACE_FILE,
  RECORDING_FILE,
  MANIFEST_FILE,
  REQUEST_FILE,
} from './recording.js';
