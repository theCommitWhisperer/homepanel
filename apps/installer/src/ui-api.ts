/**
 * What the HomePanel window (apps/desktop/src/ui) uses from the installer: the setup bridge, the
 * system check and the fake worlds for `--fake`. No side effects on import.
 */
export { startSetup, runSetup, summaryFor, MODES, type RunSetupOptions, type SetupDeps, type SetupHandle, type SetupResult } from "./bridge/run.js";
export type { SetupEvent, EventSink, AiChoice, SetupMode, SummaryItem, RunState } from "./bridge/events.js";
export { WebPrompter, webOut } from "./bridge/web.js";
export { runPrechecks, CHECKS, TASK_TRAY } from "./precheck/checks.js";
export { recommend, nextHaStep } from "./precheck/recommend.js";
export { realPrecheckEnv, countLhmSensors } from "./precheck/real.js";
export { fakePrecheckEnv, SCENARIOS, type FakeScenario } from "./precheck/fake.js";
export type { Check, Fix, Recommendation, PrecheckResult, PrecheckEnv, Facts } from "./precheck/types.js";
