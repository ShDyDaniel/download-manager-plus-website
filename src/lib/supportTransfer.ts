/**
 * Peer-to-peer file & text transfer for the live support session.
 *
 * MIRRORED byte-for-byte in both repos — desktop src/lib/supportTransfer.ts and
 * website src/lib/supportTransfer.ts. The customer's app and the operator's
 * browser speak this protocol to each other, so a change must land in both.
 *
 * The bytes travel over a WebRTC data channel, DTLS-encrypted, directly between
 * the two machines. Nothing touches object storage or the database; the only
 * server traffic is one offer and one answer so the peers can find each other.
 * There is deliberately NO relay (TURN): a network that blocks a direct
 * connection gets a clear message rather than a pay-per-gigabyte detour
 * (Daniel's call, Sep 2026).
 *
 * Roles never change: the customer's app always makes the offer and the
 * operator's browser always answers, whichever way the file is going — a data
 * channel carries data both ways.
 */

export const MAX_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
/** Integrity block. Both ends MUST agree — it's what makes the fingerprint
 *  independent of how the bytes happened to be split into messages. */
const HASH_BLOCK_BYTES = 1024 * 1024;
const HIGH_WATER_BYTES = 8 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 25_000;
const GATHER_TIMEOUT_MS = 4_000;

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export type TransferMeta =
  | { kind: "file"; name: string; size: number; mime: string }
  | { kind: "text"; size: number };

export type TransferPayload =
  | { kind: "file"; blob: Blob; name: string; mime: string }
  | { kind: "text"; text: string };

/** The two networks can't reach each other without a relay. `detail` says what
 *  the local side actually managed before giving up, which is the difference
 *  between "a firewall ate our STUN requests" and "both sides are behind NATs
 *  that only a relay can cross" — two very different fixes. */
export class BlockedNetworkError extends Error {
  readonly detail: string;
  constructor(detail = "") {
    super(detail ? `blocked ${detail}` : "blocked");
    this.name = "BlockedNetworkError";
    this.detail = detail;
  }
}

/**
 * What this side gathered, compactly, for diagnosis:
 *   host  — our own addresses. Always present; only useful on the same network.
 *   srflx — our public address, learned from a STUN server. **Zero means the
 *           STUN servers never answered**, so we were never reachable from
 *           outside and no relay would have been needed to notice.
 *   relay — a TURN server. Always zero: we don't run one on purpose.
 */
export function candidateSummary(pc: RTCPeerConnection): string {
  const sdp = pc.localDescription?.sdp || "";
  const n = (t: string) => (sdp.match(new RegExp(`typ ${t}`, "g")) || []).length;
  return `host=${n("host")} srflx=${n("srflx")} relay=${n("relay")}`;
}

/** Bytes arrived, but not the bytes that were sent. */
export class IntegrityError extends Error {
  constructor() {
    super("integrity");
    this.name = "IntegrityError";
  }
}

export const CLOSED = Symbol("closed");
export type Message = string | ArrayBuffer;

/**
 * Buffers every message from the moment the channel exists. Without it the
 * sender can get its first message out before the receiver has attached a
 * listener — the event fires to nobody, the header is lost, and both ends sit
 * waiting on each other.
 */
export class Inbox {
  private queue: Message[] = [];
  private waiters: Array<(m: Message | typeof CLOSED) => void> = [];
  private closed = false;
  constructor(channel: RTCDataChannel) {
    channel.binaryType = "arraybuffer";
    channel.onmessage = (e) => {
      const data = e.data as Message;
      const w = this.waiters.shift();
      if (w) w(data);
      else this.queue.push(data);
    };
    channel.onclose = () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(CLOSED);
    };
  }
  next(): Promise<Message | typeof CLOSED> {
    const m = this.queue.shift();
    if (m !== undefined) return Promise.resolve(m);
    if (this.closed) return Promise.resolve(CLOSED);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export interface Link {
  channel: RTCDataChannel;
  inbox: Inbox;
}

export function createPeer(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS });
}

/** Resolve once ICE gathering is done, so the SDP carries every candidate and
 *  the whole negotiation fits in ONE offer + ONE answer — no trickle, no stream
 *  of tiny signaling writes. */
function gatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", done);
      resolve();
    };
    // Some networks never report "complete"; a few seconds of candidates is
    // plenty to connect with.
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", done);
      resolve();
    }, GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", done);
  });
}

/** Offerer side — always the customer's app. */
export async function makeOffer(pc: RTCPeerConnection): Promise<{ link: Link; sdp: string }> {
  const channel = pc.createDataChannel("xfer", { ordered: true });
  const link: Link = { channel, inbox: new Inbox(channel) };
  await pc.setLocalDescription(await pc.createOffer());
  await gatheringComplete(pc);
  return { link, sdp: pc.localDescription?.sdp ?? "" };
}

/** Answerer side — always the operator's browser. */
export async function makeAnswer(
  pc: RTCPeerConnection,
  offerSdp: string,
): Promise<{ link: Promise<Link>; sdp: string }> {
  // Listen BEFORE applying the offer, so the channel can't slip past.
  const link = new Promise<Link>((resolve) => {
    pc.addEventListener(
      "datachannel",
      (e) => resolve({ channel: e.channel, inbox: new Inbox(e.channel) }),
      { once: true },
    );
  });
  await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await gatheringComplete(pc);
  return { link, sdp: pc.localDescription?.sdp ?? "" };
}

export async function acceptAnswer(pc: RTCPeerConnection, answerSdp: string): Promise<void> {
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
}

/** Wait for the channel to open, or fail with BlockedNetworkError when the two
 *  networks can't reach each other directly. */
export function waitOpen(pc: RTCPeerConnection, channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener("open", onOpen);
      pc.removeEventListener("iceconnectionstatechange", onIce);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onIce = () => {
      if (pc.iceConnectionState !== "failed") return;
      cleanup();
      reject(new BlockedNetworkError(`ice=failed ${candidateSummary(pc)}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new BlockedNetworkError(`timeout ice=${pc.iceConnectionState} ${candidateSummary(pc)}`),
      );
    }, CONNECT_TIMEOUT_MS);
    channel.addEventListener("open", onOpen);
    pc.addEventListener("iceconnectionstatechange", onIce);
  });
}

/**
 * Integrity fingerprint: SHA-256 of each 1 MiB block (native WebCrypto, which
 * cannot hash a stream), then SHA-256 over the concatenated block digests.
 * Both ends cut blocks at the same file offsets, so the result is identical no
 * matter how the bytes were split into channel messages.
 */
export class BlockHasher {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private digests: ArrayBuffer[] = [];
  async push(bytes: Uint8Array): Promise<void> {
    let off = 0;
    while (off < bytes.byteLength) {
      const take = Math.min(HASH_BLOCK_BYTES - this.pendingBytes, bytes.byteLength - off);
      this.pending.push(bytes.subarray(off, off + take));
      this.pendingBytes += take;
      off += take;
      if (this.pendingBytes === HASH_BLOCK_BYTES) await this.flush();
    }
  }
  private async flush(): Promise<void> {
    if (!this.pendingBytes) return;
    const block = new Uint8Array(this.pendingBytes);
    let o = 0;
    for (const p of this.pending) {
      block.set(p, o);
      o += p.byteLength;
    }
    this.digests.push(await crypto.subtle.digest("SHA-256", block));
    this.pending = [];
    this.pendingBytes = 0;
  }
  async finish(): Promise<string> {
    await this.flush();
    const all = new Uint8Array(this.digests.length * 32);
    this.digests.forEach((d, i) => all.set(new Uint8Array(d), i * 32));
    const final = await crypto.subtle.digest("SHA-256", all);
    return Array.from(new Uint8Array(final))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}

function waitDrain(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount < HIGH_WATER_BYTES) return Promise.resolve();
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = HIGH_WATER_BYTES / 2;
    const done = () => {
      channel.removeEventListener("bufferedamountlow", done);
      channel.removeEventListener("close", done);
      resolve();
    };
    channel.addEventListener("bufferedamountlow", done);
    channel.addEventListener("close", done);
  });
}

function parseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Never trust the other end's header: bound every field it controls. */
function readMeta(j: Record<string, unknown>): TransferMeta | null {
  const size = Number(j.size);
  if (!Number.isFinite(size) || size < 0) return null;
  if (j.kind === "text") return size <= MAX_TEXT_BYTES ? { kind: "text", size } : null;
  if (j.kind !== "file" || size > MAX_TRANSFER_BYTES) return null;
  return {
    kind: "file",
    size,
    name: String(j.name ?? "file").slice(0, 200),
    mime: String(j.mime ?? "application/octet-stream").slice(0, 120),
  };
}

/** Send a file or a text; resolves once the receiver confirms it intact. */
export async function sendPayload(
  link: Link,
  payload: TransferPayload,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const { channel, inbox } = link;
  const blob = payload.kind === "text" ? new Blob([payload.text]) : payload.blob;
  const meta: TransferMeta =
    payload.kind === "text"
      ? { kind: "text", size: blob.size }
      : {
          kind: "file",
          name: payload.name,
          size: blob.size,
          mime: payload.mime || "application/octet-stream",
        };
  const limit = meta.kind === "text" ? MAX_TEXT_BYTES : MAX_TRANSFER_BYTES;
  if (meta.size > limit) throw new Error("too-large");
  channel.send(JSON.stringify({ t: "meta", ...meta }));
  const hasher = new BlockHasher();
  let sent = 0;
  while (sent < blob.size) {
    const chunk = new Uint8Array(await blob.slice(sent, sent + CHUNK_BYTES).arrayBuffer());
    await waitDrain(channel);
    if (channel.readyState !== "open") throw new Error("closed");
    channel.send(chunk);
    await hasher.push(chunk);
    sent += chunk.byteLength;
    onProgress(sent, blob.size);
  }
  channel.send(JSON.stringify({ t: "end", digest: await hasher.finish() }));
  for (;;) {
    const m = await inbox.next();
    if (m === CLOSED) throw new Error("closed");
    if (typeof m !== "string") continue;
    const j = parseJson(m);
    if (j?.t !== "ack") continue;
    if (j.ok !== true) throw new IntegrityError();
    return;
  }
}

export interface ReceiveSink {
  /** The header arrived. Return false to refuse the transfer. */
  begin(meta: TransferMeta): Promise<boolean> | boolean;
  write(chunk: Uint8Array): Promise<unknown>;
  /** ok=false means discard whatever was written. */
  end(ok: boolean): Promise<unknown>;
}

/** Receive one file or text; resolves with its header once verified intact. */
export async function receivePayload(
  link: Link,
  sink: ReceiveSink,
  onProgress: (done: number, total: number) => void,
): Promise<TransferMeta> {
  const { channel, inbox } = link;
  let meta: TransferMeta | null = null;
  let got = 0;
  let begun = false;
  const hasher = new BlockHasher();
  try {
    for (;;) {
      const m = await inbox.next();
      if (m === CLOSED) throw new Error("closed");
      if (typeof m === "string") {
        const j = parseJson(m);
        if (j?.t === "meta" && !meta) {
          meta = readMeta(j);
          if (!meta || !(await sink.begin(meta))) {
            channel.send(JSON.stringify({ t: "ack", ok: false }));
            throw new Error("refused");
          }
          begun = true;
        } else if (j?.t === "end" && meta) {
          const ok = got === meta.size && (await hasher.finish()) === j.digest;
          begun = false;
          await sink.end(ok);
          channel.send(JSON.stringify({ t: "ack", ok }));
          if (!ok) throw new IntegrityError();
          return meta;
        }
      } else {
        if (!meta) throw new Error("protocol");
        const chunk = new Uint8Array(m);
        got += chunk.byteLength;
        if (got > meta.size) throw new IntegrityError();
        await hasher.push(chunk);
        await sink.write(chunk);
        onProgress(got, meta.size);
      }
    }
  } catch (err) {
    if (begun) await Promise.resolve(sink.end(false)).catch(() => undefined);
    throw err;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Files that can run code when opened. The receiving side warns before saving. */
export function isRunnableFile(name: string): boolean {
  return /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|jse?|wsf|jar|app|dmg|pkg|sh|command|py|dll|lnk|reg|apk)$/i.test(
    name,
  );
}
