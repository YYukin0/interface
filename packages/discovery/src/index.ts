/**
 * The expensive half: one model-driven run that teaches the system a procedure.
 *
 *   tools.ts   the model's vocabulary as JSON Schema, and a parser that trusts none of it
 *   prompt.ts  what the model sees each turn, and why it is not a conversation
 *   model.ts   the ONLY model SDK import in the system (I1)
 *   risk.ts    per-step risk inference, conservative by construction
 *   values.ts  parameter substitution out, classification in
 *   loop.ts    observe → decide → policy → act → record
 */
export { DiscoveryLoop, DEAD_END_STREAK, MAX_INVALID_TURNS, type DiscoveryLoopOptions } from './loop.js';
export {
  AnthropicDecisionModel,
  ScriptedDecisionModel,
  DEFAULT_MODEL,
  DEFAULT_TOOL_CHOICE,
  ENV,
  parseToolChoice,
  type DecisionModel,
  type ModelReply,
  type ScriptedStep,
  type AnthropicModelOptions,
  type ToolChoiceMode,
} from './model.js';
/** Re-exported for callers that build a discovery run; it lives in `@cua/evidence`. */
export { EvidenceSink } from '@cua/evidence';
export {
  TOOLS,
  toolsWithRationale,
  parseCall,
  describeInputs,
  type ToolSchema,
  type ParsedCall,
} from './tools.js';
export {
  systemPrompt,
  turnPrompt,
  renderTree,
  renderHistory,
  describeAction,
  LINE_BUDGET,
  type TurnInput,
  type HistoryEntry,
  type RenderedTree,
} from './prompt.js';
export { inferRisk, policyActionOf } from './risk.js';
export { resolve, record, recordExtracted, patternOf, inputRefName, INPUT_REF } from './values.js';
