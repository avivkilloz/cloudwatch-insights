"""MQTT connections held by the server (PLATFORM_PLAN.md §16.13, D54).

The MQTT pane's connection used to live in one browser tab. It is a
background run now (D51): the server connects, as whoever pressed Connect,
and the run's poll drains each connection's buffer into the session, so
every tab, member and the agent read one stream.

A connection lives on the replica that opened it, in `REGISTRY`, keyed by
its run handle's `key`. A replica that claims the run after its holder died
finds no connection under the key and reconnects -- as does a connection
that dropped, since the presigned URL it was opened with has expired by then.

The network is behind `connect()`, one function: tests and `dev/fake_aws`
replace it with an in-process broker.
"""

from __future__ import annotations

import collections
import itertools
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Protocol
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

# The newest messages a connection keeps for the next poll, and the most of
# one payload kept: 200 of 8 KB fit the browser's session cap with room.
BUFFER = 200
MAX_PAYLOAD = 8 * 1024
CONNECT_TIMEOUT_SECONDS = 10.0

_ids = itertools.count(1)


class MqttError(Exception):
    """Why a connection couldn't be made or kept, in a sentence for the pane."""


class Conn(Protocol):
    """One open connection: what `connect()` hands back."""

    def subscribe(self, topic: str) -> None: ...
    def unsubscribe(self, topic: str) -> None: ...
    def alive(self) -> bool: ...
    def error(self) -> Optional[str]: ...
    def close(self) -> None: ...


Deliver = Callable[[str, bytes], None]


def matches(topic_filter: str, topic: str) -> bool:
    """Whether `topic` matches an MQTT filter (`+` one level, `#` the rest)."""
    want = topic_filter.split("/")
    have = topic.split("/")
    for i, part in enumerate(want):
        if part == "#":
            return True
        if i >= len(have) or (part != "+" and part != have[i]):
            return False
    return len(want) == len(have)


class _PahoConn:
    """paho-mqtt over the presigned WebSocket URL, MQTT 3.1.1, QoS 0 -- what
    the browser tester spoke. Reconnecting is ours (the URL expires), so
    paho's own is off."""

    def __init__(self, url: str, client_id: str, deliver: Deliver) -> None:
        import paho.mqtt.client as paho  # imported here: only a real connection needs it

        parts = urlsplit(url)
        self._error: Optional[str] = None
        self._connected = threading.Event()
        self._closed = False
        client = paho.Client(
            paho.CallbackAPIVersion.VERSION2, client_id=client_id, transport="websockets",
            protocol=paho.MQTTv311, reconnect_on_failure=False,
        )
        client.ws_set_options(path=f"{parts.path}?{parts.query}")
        client.tls_set()

        def on_connect(_c, _u, _flags, reason, _props) -> None:
            if reason.is_failure:
                self._error = f"IoT Core refused the connection: {reason}."
            else:
                self._connected.set()

        def on_disconnect(_c, _u, _flags, reason, _props) -> None:
            self._connected.clear()
            if not self._closed:
                self._error = f"The connection dropped: {reason}."

        client.on_connect = on_connect
        client.on_disconnect = on_disconnect
        client.on_message = lambda _c, _u, msg: deliver(msg.topic, msg.payload)
        self._client = client
        try:
            client.connect(parts.hostname or "", parts.port or 443, keepalive=30)
        except OSError as e:
            raise MqttError(f"Couldn't reach {parts.hostname}: {e}") from None
        client.loop_start()
        if not self._connected.wait(CONNECT_TIMEOUT_SECONDS):
            self.close()
            raise MqttError(
                self._error
                or "IoT Core didn't accept the connection in time. The group's role needs iot:Connect, "
                "iot:Subscribe and iot:Receive, and an IoT policy may limit the client id."
            )

    def subscribe(self, topic: str) -> None:
        self._client.subscribe(topic, qos=0)

    def unsubscribe(self, topic: str) -> None:
        self._client.unsubscribe(topic)

    def alive(self) -> bool:
        return self._connected.is_set()

    def error(self) -> Optional[str]:
        return self._error

    def close(self) -> None:
        self._closed = True
        try:
            self._client.disconnect()
        finally:
            self._client.loop_stop()


def connect(account_id: str, region: str, identity: Any, client_id: str, deliver: Deliver) -> tuple[Conn, str]:
    """A connection to the account's IoT Core endpoint, as `identity`, and the
    endpoint's name. What tests and the fake replace."""
    from . import iot_mqtt_signer

    signed = iot_mqtt_signer.build_presigned_ws_url(account_id, region, identity)
    try:
        return _PahoConn(signed["url"], client_id, deliver), signed["endpoint"]
    except MqttError as e:
        raise MqttError(f"{e}{_why(signed['url'])}") from None


def _why(url: str) -> str:
    """What IoT Core (or whatever answered in its place) said to the
    handshake. paho reports a refused upgrade as "not upgraded" and nothing
    more -- the browser hid it the same way, which is what the probe was
    written for -- and a firewall answering instead of AWS looked exactly
    like a missing permission. The URL carries the session token, so it is
    never part of the sentence, even where an exception quotes it."""
    from . import iot_mqtt_signer

    probe = iot_mqtt_signer.probe_presigned_url(url)
    if probe["status_code"] == 101:
        return " (the WebSocket handshake itself was accepted, so it was MQTT that refused)"
    body = re.sub(r"wss?://\S+", "the endpoint", probe["body"] or "")
    said = f"HTTP {probe['status_code']}" if probe["status_code"] else "the handshake failed"
    if probe["status_code"] and not any(h.lower().startswith("x-amzn-") for h in probe["headers"]):
        said += " from something that isn't AWS (no x-amzn headers: a proxy or firewall?)"
    return f" ({said}{': ' + body if body else ''})"


@dataclass
class Subscription:
    key: str
    client_id: str
    endpoint: str = ""
    topics: list[str] = field(default_factory=list)
    conn: Optional[Conn] = None
    buffer: collections.deque = field(default_factory=lambda: collections.deque(maxlen=BUFFER))
    lock: threading.Lock = field(default_factory=threading.Lock)

    def deliver(self, topic: str, payload: bytes) -> None:
        text = payload[:MAX_PAYLOAD].decode("utf-8", errors="replace")
        if len(payload) > MAX_PAYLOAD:
            text += f"\n… (cut at {MAX_PAYLOAD // 1024} KB of {len(payload) // 1024} KB)"
        with self.lock:
            self.buffer.append({"id": f"{self.key[:8]}-{next(_ids)}", "topic": topic, "payload": text, "timestamp": int(time.time() * 1000)})

    def drain(self) -> list[dict[str, Any]]:
        """Everything received since the last drain, newest first."""
        with self.lock:
            out = list(reversed(self.buffer))
            self.buffer.clear()
        return out

    def close(self) -> None:
        if self.conn is not None:
            try:
                self.conn.close()
            except Exception:  # noqa: BLE001 - closing is best-effort
                logger.debug("Closing MQTT connection %s failed", self.key, exc_info=True)
            self.conn = None


REGISTRY: dict[str, Subscription] = {}
_registry_lock = threading.Lock()
# Keys closed on purpose (Stop, Disconnect, a restart replacing the run). A
# run's key is never used again, so a poll that finds one gone must not open
# it back up: the manager's tick of the old run, polling just as a restart
# closed it, reconnected it with the old topics -- a connection no run held,
# open until the replica stopped. Bounded: a replica only needs the recent ones.
_closed: collections.OrderedDict[str, None] = collections.OrderedDict()
CLOSED_KEPT = 10_000


def open_subscription(
    key: str, account_id: str, region: str, identity: Any, topics: list[str], reopen: bool = False
) -> Optional[Subscription]:
    """Connects and subscribes; replaces any connection already under `key`.
    A `reopen` (a poll's) of a key closed on purpose opens nothing and is None
    -- checked again once connected, since a close can land meanwhile."""
    if reopen and closed(key):
        return None
    sub = Subscription(key=key, client_id=f"cloudwatch-insights-{key[:12]}", topics=list(topics))
    conn, endpoint = connect(account_id, region, identity, sub.client_id, sub.deliver)
    sub.conn, sub.endpoint = conn, endpoint
    for topic in sub.topics:
        conn.subscribe(topic)
    with _registry_lock:
        if reopen and key in _closed:
            old, sub = sub, None
        else:
            old = REGISTRY.pop(key, None)
            REGISTRY[key] = sub
    if old is not None:
        old.close()
    return sub


def closed(key: str) -> bool:
    with _registry_lock:
        return key in _closed


def get(key: str) -> Optional[Subscription]:
    with _registry_lock:
        return REGISTRY.get(key)


def close(key: str) -> bool:
    with _registry_lock:
        sub = REGISTRY.pop(key, None)
        _closed[key] = None
        while len(_closed) > CLOSED_KEPT:
            _closed.popitem(last=False)
    if sub is None:
        return False
    sub.close()
    return True


def close_all() -> None:
    with _registry_lock:
        subs = list(REGISTRY.values())
        REGISTRY.clear()
    for sub in subs:
        sub.close()

