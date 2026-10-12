import type { HaEntityState } from "@homepanel/protocol";
import type { EventEmitter } from "node:events";

export type HaStatus = "connected" | "disconnected" | "demo";

export interface CameraFetchResult {
  status: number;
  contentType: string;
  body: NodeJS.ReadableStream | Buffer;
  /** release resources if the client goes away */
  close?: () => void;
}

/**
 * Anything that looks like Home Assistant: the real WS bridge or the demo fake.
 * Emits "state" (entityId, newState | null, oldState | null) and "status" (HaStatus).
 */
export interface HaSource extends EventEmitter {
  readonly status: HaStatus;
  start(): void;
  stop(): void;
  states(): HaEntityState[];
  getState(entityId: string): HaEntityState | undefined;
  callService(domain: string, service: string, data?: Record<string, unknown>): Promise<void>;
  camera(entityId: string, kind: "snapshot" | "stream", signal: AbortSignal): Promise<CameraFetchResult>;
}
