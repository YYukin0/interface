/**
 * Detection and redaction, kept separate (I3).
 *
 *   detect.ts    recognizers; returns spans and confidences, changes nothing
 *   redactor.ts  applies them, plus exact-match removal of known values
 *   png.ts       screenshot blackout, dependency-free
 */
export { detect, severityOf, RECOGNIZERS, type Detection } from './detect.js';
export { DefaultRedactor, atSink, type RedactorOptions } from './redactor.js';
export { blackOutRegions, type Region } from './png.js';
