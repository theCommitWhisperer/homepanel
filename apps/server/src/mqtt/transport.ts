import type { FastifyBaseLogger } from "fastify";
import mqtt, { type MqttClient } from "mqtt";
import { topics } from "@homepanel/protocol";
import type { AgentManager, AgentTransport } from "./agents.js";

export class MqttTransport implements AgentTransport {
  private client: MqttClient;
  private _status: "connected" | "disconnected" = "disconnected";

  constructor(url: string, opts: { username?: string; password?: string }, manager: AgentManager, log: FastifyBaseLogger) {
    this.client = mqtt.connect(url, {
      username: opts.username,
      password: opts.password,
      clientId: `homepanel-server-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
    });
    this.client.on("connect", () => {
      this._status = "connected";
      log.info({ url }, "mqtt: connected");
      this.client.subscribe(topics.all, { qos: 1 }, (err) => err && log.error({ err: err.message }, "mqtt: subscribe failed"));
    });
    this.client.on("close", () => {
      if (this._status === "connected") log.warn("mqtt: disconnected");
      this._status = "disconnected";
    });
    this.client.on("error", (err) => log.warn({ err: err.message }, "mqtt: error"));
    this.client.on("message", (topic, payload) => manager.handleMessage(topic, payload));
  }

  get status() {
    return this._status;
  }

  publish(topic: string, payload: string) {
    this.client.publish(topic, payload, { qos: 1 });
  }

  stop() {
    this.client.end(true);
  }
}

export class NullTransport implements AgentTransport {
  readonly status = "disabled" as const;
  publish() {}
  stop() {}
}
