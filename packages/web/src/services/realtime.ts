/**
 * Realtime event bus for live tracking (SSE).
 *
 * Single-node today: an in-process pub/sub. The publish/subscribe surface is
 * deliberately tiny and async so a Redis pub/sub backend can replace the
 * in-memory bus for multi-node fan-out WITHOUT touching route code.
 *
 * Channels are keyed by booking public token so the public tracking page can
 * subscribe to exactly one work order.
 */
import { log } from "../api/lib/logger";
import { getRedis, getRedisSub, redisEnabled } from "../api/lib/redis";

export type TrackEvent = {
  type: "location" | "status" | "eta" | "message";
  token: string;
  data: unknown;
  at: number;
};

type Subscriber = (e: TrackEvent) => void;

interface Bus {
  publish(channel: string, e: TrackEvent): Promise<void>;
  subscribe(channel: string, fn: Subscriber): () => void;
}

// ---- in-memory bus (default) ----------------------------------------------
class MemoryBus implements Bus {
  private subs = new Map<string, Set<Subscriber>>();
  async publish(channel: string, e: TrackEvent) {
    const set = this.subs.get(channel);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(e);
      } catch {
        /* never let one bad subscriber break the fan-out */
      }
    }
  }
  subscribe(channel: string, fn: Subscriber) {
    let set = this.subs.get(channel);
    if (!set) {
      set = new Set();
      this.subs.set(channel, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.subs.delete(channel);
    };
  }
  /** number of active subscribers across all channels (for /ready metrics) */
  size() {
    let n = 0;
    for (const s of this.subs.values()) n += s.size;
    return n;
  }
}

// ---- Redis bus (multi-node) -----------------------------------------------
/**
 * Redis-backed pub/sub. publish() does a Redis PUBLISH; every node's
 * subscriber connection receives the message and fans it out to that node's
 * local SSE callbacks. Subscriber callbacks are kept in-process (per node);
 * the SUBSCRIBE/UNSUBSCRIBE to Redis is reference-counted per channel so we
 * only hold one Redis subscription per active channel per node.
 */
class RedisBus implements Bus {
  private local = new Map<string, Set<Subscriber>>();
  private wired = false;

  private wire() {
    if (this.wired) return;
    const sub = getRedisSub();
    if (!sub) return;
    this.wired = true;
    sub.on("message", (channel: string, payload: string) => {
      const set = this.local.get(channel);
      if (!set) return;
      let e: TrackEvent;
      try {
        e = JSON.parse(payload) as TrackEvent;
      } catch {
        return;
      }
      for (const fn of set) {
        try {
          fn(e);
        } catch {
          /* never let one bad subscriber break the fan-out */
        }
      }
    });
  }

  async publish(channel: string, e: TrackEvent) {
    const r = getRedis();
    if (!r) return;
    try {
      await r.publish(channel, JSON.stringify(e));
    } catch (err) {
      log.error("realtime: redis publish failed", { err: (err as Error).message });
    }
  }

  subscribe(channel: string, fn: Subscriber) {
    this.wire();
    let set = this.local.get(channel);
    if (!set) {
      set = new Set();
      this.local.set(channel, set);
      // first local subscriber for this channel → SUBSCRIBE on Redis
      getRedisSub()?.subscribe(channel).catch((err) =>
        log.error("realtime: redis subscribe failed", { err: (err as Error).message }),
      );
    }
    set.add(fn);
    return () => {
      const s = this.local.get(channel);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) {
        this.local.delete(channel);
        // last local subscriber gone → UNSUBSCRIBE from Redis
        getRedisSub()?.unsubscribe(channel).catch(() => {});
      }
    };
  }

  size() {
    let n = 0;
    for (const s of this.local.values()) n += s.size;
    return n;
  }
}

const memBus = new MemoryBus();
const redisBus = new RedisBus();
let bus: Bus = memBus;

/**
 * Swap in a Redis-backed bus for multi-node. The Redis bus should:
 *  - publish -> redis PUBLISH channel JSON
 *  - subscribe -> redis SUBSCRIBE, fan out to local SSE connections
 * Keep this function the only integration point.
 */
export function setRealtimeBus(b: Bus) {
  bus = b;
  log.info("realtime: custom bus installed");
}

/**
 * Pick the bus based on environment. Call once at boot. With REDIS_URL set we
 * use the Redis bus for cross-node fan-out; otherwise the in-memory bus.
 */
export function initRealtimeBus() {
  if (redisEnabled()) {
    bus = redisBus;
    log.info("realtime: using Redis bus (multi-node)");
  } else {
    bus = memBus;
    log.info("realtime: using in-memory bus (single-node)");
  }
}

const chan = (token: string) => `track:${token}`;

export function publishTrack(e: Omit<TrackEvent, "at">) {
  return bus.publish(chan(e.token), { ...e, at: Date.now() });
}

export function subscribeTrack(token: string, fn: Subscriber) {
  return bus.subscribe(chan(token), fn);
}

/**
 * Driver-app real-time messaging — reuses the exact same pub/sub bus as live
 * tracking above (in-memory single-node, Redis multi-node) instead of a
 * separate system. "direct" = the rider<->dispatch thread, keyed by riderId
 * (both directions of that one conversation publish/subscribe to the same
 * channel). "job" = a per-booking thread, keyed by bookingId.
 *
 * These are deliberately signal-only: the event just tells a listening
 * client "something changed, go refetch" (mirroring the existing HTTP GETs
 * that already fetch/shape the actual message list) rather than trying to
 * carry the full message payload through the bus — far less risk of
 * duplicating serialization/notification logic in two places.
 */
/**
 * "inbox" is company-keyed rather than thread-keyed: the unified admin inbox
 * needs to light up for ANY new message in the tenant, whichever thread it
 * landed in. Senders publish to both their own thread channel and the tenant
 * inbox channel so an open thread and the inbox list both refresh.
 */
type MsgKind = "direct" | "job" | "inbox";

const msgChan = (kind: MsgKind, key: string) => `msg:${kind}:${key}`;

export function publishMsg(kind: MsgKind, key: string) {
  return bus.publish(msgChan(kind, key), { type: "message", token: key, data: null, at: Date.now() });
}

export function subscribeMsg(kind: MsgKind, key: string, fn: Subscriber) {
  return bus.subscribe(msgChan(kind, key), fn);
}

export function realtimeStats() {
  const backend = bus === redisBus ? "redis" : "memory";
  const activeSubscribers =
    bus === memBus ? memBus.size() : bus === redisBus ? redisBus.size() : -1;
  return { backend, activeSubscribers };
}
