/**
 * Single source of truth for CV AI generation rules. Every rule the model
 * receives is composed from this module — no CV business rule should be
 * duplicated in a provider implementation, a route, or the frontend.
 *
 * CV_AI_RULE_VERSION identifies which rule set produced a given CV, so it can
 * be logged alongside generation results without requiring a schema change.
 * Bump it whenever a rule module's behavior changes meaningfully.
 */
import { getCoreRules } from "./core.rules";
import { getContentRules } from "./content.rules";
import { getHallucinationRules } from "./hallucination.rules";
import { getTailoringRules } from "./tailoring.rules";
import { getEnhancementRules, getEnhancementReminder } from "./enhancement.rules";
import { getFormattingRules } from "./formatting.rules";
import { getClarificationRules } from "./clarification.rules";

export const CV_AI_RULE_VERSION = "2.5";

export const CV_RULES = {
  core: getCoreRules,
  content: getContentRules,
  hallucination: getHallucinationRules,
  tailoring: getTailoringRules,
  enhancement: getEnhancementRules,
  formatting: getFormattingRules,
  clarification: getClarificationRules,
};

export {
  getCoreRules,
  getContentRules,
  getHallucinationRules,
  getTailoringRules,
  getEnhancementRules,
  getEnhancementReminder,
  getFormattingRules,
  getClarificationRules,
};
