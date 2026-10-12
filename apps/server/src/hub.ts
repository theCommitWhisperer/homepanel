import { EventEmitter } from "node:events";
import type { DataKey } from "@homepanel/protocol";

export interface KeyValue {
  value: unknown;
  ts: number;
}

/**
 * Latest value per data key. Kiosk sessions listen to "change" and forward the keys
 * they subscribed to.
 */
export class StateHub extends EventEmitter {
  private values = new Map<DataKey, KeyValue>();

  set(key: DataKey, value: unknown) {
    const kv = { value, ts: Date.now() };
    this.values.set(key, kv);
    this.emit("change", key, kv);
  }

  get(key: DataKey): KeyValue | undefined {
    return this.values.get(key);
  }

  delete(key: DataKey) {
    this.values.delete(key);
  }

  keys(prefix = ""): DataKey[] {
    return [...this.values.keys()].filter((k) => k.startsWith(prefix));
  }
}
