/**
 * @homepanel/ai — tiny OpenAI-compatible chat client with tool calling and an approval-gated
 * Assistant. Used by the installer (setup guide) and the server (/api/admin/assistant).
 */
export { PRESETS, resolveProvider, chatUrl } from "./presets.js";
export type { ProviderId, ProviderConfig, ProviderPreset, ResolvedProvider } from "./presets.js";
export { AiError, chatCompletion, chatWithFallback, testProvider } from "./client.js";
export type { AiErrorKind, ChatRequest, ChatResult, WireMessage, WireTool, WireToolCall } from "./client.js";
export { Assistant } from "./assistant.js";
export type { ToolDef, AssistantOptions } from "./assistant.js";
