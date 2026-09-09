export { PlaywrightSurfaceDriver, type WebDriverOptions, coerce } from './driver.js';
export { openSession, DEFAULT_VIEWPORT, type Session, type SessionOptions } from './session.js';
export { CdpLiveView, type CdpLiveViewOptions } from './liveview.js';
export { harvestTarget, CONFIDENCE, type HarvestInput } from './harvest.js';
export {
  resolveTarget,
  AGREEMENT_MIN,
  type DomLookup,
  type ResolveContext,
} from './resolve.js';
export {
  flatten,
  byRef,
  descendants,
  scopeOf,
  named,
  norm,
  sameText,
  frameOfRef,
  ordinalOfRef,
  type FlatNode,
} from './tree.js';
