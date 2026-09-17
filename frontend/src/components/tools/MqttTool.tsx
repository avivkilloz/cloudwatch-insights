import { useEffect, useRef, useState } from "react";
import type { MqttClient } from "mqtt";
import { api, Environment } from "../../api";

interface ReceivedMessage {
  id: number;
  topic: string;
  payload: string;
  timestamp: number;
}

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

const MAX_MESSAGES = 200;
let nextMessageId = 1;

function randomClientId(): string {
  return `cloudwatch-insights-${Math.random().toString(16).slice(2)}`;
}

export default function MqttTool() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState<number | "">("");
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);

  const [subscribeTopic, setSubscribeTopic] = useState("");
  const [subscriptions, setSubscriptions] = useState<string[]>([]);
  const [publishTopic, setPublishTopic] = useState("");
  const [publishPayload, setPublishPayload] = useState("");

  const [messages, setMessages] = useState<ReceivedMessage[]>([]);

  const clientRef = useRef<MqttClient | null>(null);

  useEffect(() => {
    api.listEnvironments().then(setEnvironments);
    return () => {
      clientRef.current?.end(true);
    };
  }, []);

  async function connect() {
    if (!environmentId) {
      setError("Choose an environment first.");
      return;
    }
    setStatus("connecting");
    setError(null);
    try {
      const conn = await api.getMqttPresignedUrl(Number(environmentId));
      // Loaded on demand -- mqtt.js is a sizeable dependency this page
      // shouldn't pay for until this specific tool is actually used. Which
      // export actually holds the `connect` function varies by bundler/dev
      // server (named export vs. wrapped under `.default`), so resolve it
      // defensively instead of assuming one shape.
      const mqttModule: any = await import("mqtt");
      const mqttConnect: typeof import("mqtt").connect =
        mqttModule.connect ?? mqttModule.default?.connect ?? mqttModule.default;
      if (typeof mqttConnect !== "function") {
        throw new Error("Could not load the MQTT client library.");
      }
      const client = mqttConnect(conn.url, {
        clientId: randomClientId(),
        protocolVersion: 4,
        // The presigned URL is only valid for a few minutes -- an
        // automatic reconnect after that would just keep failing auth
        // with a now-expired signature, so surface the disconnect instead
        // of retrying silently.
        reconnectPeriod: 0,
      });
      clientRef.current = client;
      setEndpoint(conn.endpoint);

      client.on("connect", () => setStatus("connected"));
      client.on("close", () => setStatus((s) => (s === "error" ? s : "disconnected")));
      client.on("error", (err) => {
        setError(err.message);
        setStatus("error");
      });
      client.on("message", (topic, payload) => {
        setMessages((prev) =>
          [{ id: nextMessageId++, topic, payload: payload.toString(), timestamp: Date.now() }, ...prev].slice(
            0,
            MAX_MESSAGES
          )
        );
      });
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    }
  }

  function disconnect() {
    clientRef.current?.end(true);
    clientRef.current = null;
    setStatus("disconnected");
    setSubscriptions([]);
    setEndpoint(null);
  }

  function subscribe() {
    const topic = subscribeTopic.trim();
    if (!topic || !clientRef.current) return;
    clientRef.current.subscribe(topic, { qos: 0 }, (err) => {
      if (err) {
        setError(err.message);
        return;
      }
      setSubscriptions((prev) => (prev.includes(topic) ? prev : [...prev, topic]));
      setSubscribeTopic("");
    });
  }

  function unsubscribe(topic: string) {
    clientRef.current?.unsubscribe(topic);
    setSubscriptions((prev) => prev.filter((t) => t !== topic));
  }

  function publish() {
    const topic = publishTopic.trim();
    if (!topic || !clientRef.current) return;
    clientRef.current.publish(topic, publishPayload, { qos: 0 });
  }

  const connected = status === "connected";

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <select
          value={environmentId}
          onChange={(e) => setEnvironmentId(e.target.value ? Number(e.target.value) : "")}
          disabled={connected || status === "connecting"}
        >
          <option value="">Choose environment…</option>
          {environments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} ({e.account_id} · {e.region})
            </option>
          ))}
        </select>
        {!connected ? (
          <button onClick={connect} disabled={status === "connecting" || !environmentId}>
            {status === "connecting" ? "Connecting…" : "Connect"}
          </button>
        ) : (
          <button className="secondary" onClick={disconnect}>
            Disconnect
          </button>
        )}
        <span className={`tag ${connected ? "ok" : status === "error" ? "error" : ""}`}>{status}</span>
        {endpoint && <span className="muted">{endpoint}</span>}
      </div>
      {error && <p className="error-text">{error}</p>}

      <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <span className="field-label">Subscribe</span>
          <div className="row">
            <input
              type="text"
              placeholder="topic/#"
              value={subscribeTopic}
              onChange={(e) => setSubscribeTopic(e.target.value)}
              disabled={!connected}
              style={{ flex: 1 }}
            />
            <button className="secondary" onClick={subscribe} disabled={!connected || !subscribeTopic.trim()}>
              Subscribe
            </button>
          </div>
          {subscriptions.length > 0 && (
            <div className="row" style={{ marginTop: 8 }}>
              {subscriptions.map((t) => (
                <span key={t} className="tag">
                  {t}{" "}
                  <button
                    className="danger"
                    style={{ padding: "0 6px", marginLeft: 4 }}
                    onClick={() => unsubscribe(t)}
                    title="Unsubscribe"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          <span className="field-label" style={{ marginTop: 14, display: "block" }}>
            Publish
          </span>
          <input
            type="text"
            placeholder="topic"
            value={publishTopic}
            onChange={(e) => setPublishTopic(e.target.value)}
            disabled={!connected}
            style={{ width: "100%", marginBottom: 6 }}
          />
          <textarea
            rows={3}
            placeholder="Message payload"
            value={publishPayload}
            onChange={(e) => setPublishPayload(e.target.value)}
            disabled={!connected}
          />
          <button onClick={publish} disabled={!connected || !publishTopic.trim()} style={{ marginTop: 6 }}>
            Publish
          </button>
        </div>

        <div style={{ flex: 1, minWidth: 260 }}>
          <span className="field-label">Incoming messages</span>
          {messages.length === 0 && <p className="muted">Subscribe to a topic to see messages arrive here.</p>}
          <div className="checkbox-list" style={{ maxHeight: 320 }}>
            {messages.map((m) => (
              <div key={m.id} className="result-row" style={{ marginBottom: 6 }}>
                <div className="result-row-detail" style={{ borderTop: "none" }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="tag">{m.topic}</span>
                    <span className="muted">{new Date(m.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <pre className="tool-json-output" style={{ marginTop: 6, marginBottom: 0 }}>
                    {m.payload}
                  </pre>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <p className="muted" style={{ marginTop: 10 }}>
        Connecting mints a short-lived, SigV4-signed WebSocket URL using the chosen environment's assumed role (the
        same mechanism the AWS IoT console's own MQTT test client uses), then connects straight from your browser to
        that account's IoT Core endpoint -- the MQTT session itself never passes through this app's backend. The
        role needs <code>iot:DescribeEndpoint</code>, <code>iot:Connect</code>, <code>iot:Publish</code>,{" "}
        <code>iot:Subscribe</code>, and <code>iot:Receive</code> permissions, and the endpoint must be reachable
        from wherever your browser is.
      </p>
    </div>
  );
}
