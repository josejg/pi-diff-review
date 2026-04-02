import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ReviewHostMessage, ReviewWindowData, ReviewWindowMessage } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "..", "web");

// Env-configurable defaults
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;

interface ServerConfig {
  host: string;
  port: number;
  sessionTimeoutMs: number;
  publicUrl: string | null;
}

function loadConfig(): ServerConfig {
  return {
    host: process.env.PI_DIFF_REVIEW_HOST ?? DEFAULT_HOST,
    port: parseInt(process.env.PI_DIFF_REVIEW_PORT ?? "0", 10) || DEFAULT_PORT,
    sessionTimeoutMs: parseInt(process.env.PI_DIFF_REVIEW_SESSION_TIMEOUT_MS ?? "", 10) || DEFAULT_SESSION_TIMEOUT_MS,
    publicUrl: process.env.PI_DIFF_REVIEW_PUBLIC_URL ?? null,
  };
}

export interface ReviewSession {
  /** Send a host->browser message. Silently drops if no client is connected. */
  send(message: ReviewHostMessage): void;
  /** Wait for the browser to submit or cancel. Resolves null if session timed out or was closed externally. */
  waitForResult(): Promise<ReviewWindowMessage | null>;
  /** Shut down the server and clean up. */
  close(): void;
  /** The URL to print for the user. */
  url: string;
  /** The bound port. */
  port: number;
  /** The session token. */
  token: string;
}

export type OnBrowserMessage = (message: ReviewWindowMessage) => void;

function escapeForInlineJson(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function buildSessionHtml(data: ReviewWindowData, token: string): string {
  const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
  const payload = escapeForInlineJson(JSON.stringify(data));
  return templateHtml.replace("__INLINE_DATA__", payload).replaceAll("__SESSION_TOKEN__", token);
}

function getContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}

function extractToken(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return url.searchParams.get("token");
}

export function startReviewServer(
  data: ReviewWindowData,
  onMessage: OnBrowserMessage,
): Promise<ReviewSession> {
  const config = loadConfig();
  const token = randomBytes(24).toString("base64url");
  const sessionHtml = buildSessionHtml(data, token);

  let activeWs: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPongAt = Date.now();
  let closed = false;

  // Result promise wiring
  let resolveResult: ((value: ReviewWindowMessage | null) => void) | null = null;
  const resultPromise = new Promise<ReviewWindowMessage | null>((resolve) => {
    resolveResult = resolve;
  });

  const settle = (value: ReviewWindowMessage | null): void => {
    if (resolveResult == null) return;
    const fn = resolveResult;
    resolveResult = null;
    fn(value);
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const reqToken = url.searchParams.get("token");

    // All routes require the session token
    if (reqToken !== token) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: invalid or missing session token.");
      return;
    }

    const pathname = url.pathname;

    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(sessionHtml);
      return;
    }

    if (pathname === "/app.js") {
      try {
        const content = readFileSync(join(webDir, "app.js"), "utf8");
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(content);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const reqToken = extractToken(req);
    if (reqToken !== token) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    // Only one active client at a time
    if (activeWs != null) {
      try {
        activeWs.close(1000, "Replaced by new connection");
      } catch {}
    }

    activeWs = ws;
    lastPongAt = Date.now();
    resetSessionTimeout();

    ws.on("pong", () => {
      lastPongAt = Date.now();
      resetSessionTimeout();
    });

    ws.on("message", (raw) => {
      resetSessionTimeout();
      try {
        const message = JSON.parse(String(raw)) as ReviewWindowMessage;
        onMessage(message);
      } catch {
        // Malformed message — ignore
      }
    });

    ws.on("close", () => {
      if (activeWs === ws) {
        activeWs = null;
      }
    });

    ws.on("error", () => {
      if (activeWs === ws) {
        activeWs = null;
      }
    });
  });

  function startHeartbeat(): void {
    heartbeatTimer = setInterval(() => {
      if (activeWs == null) return;
      if (Date.now() - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        // Client is unresponsive — drop the connection
        try {
          activeWs.terminate();
        } catch {}
        activeWs = null;
        return;
      }
      try {
        activeWs.ping();
      } catch {}
    }, HEARTBEAT_INTERVAL_MS);
  }

  function resetSessionTimeout(): void {
    if (sessionTimer != null) clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
      // Session expired — close everything
      settle(null);
      cleanup();
    }, config.sessionTimeoutMs);
  }

  function cleanup(): void {
    if (closed) return;
    closed = true;
    if (heartbeatTimer != null) clearInterval(heartbeatTimer);
    if (sessionTimer != null) clearTimeout(sessionTimer);
    heartbeatTimer = null;
    sessionTimer = null;

    if (activeWs != null) {
      try {
        activeWs.close(1000, "Session ended");
      } catch {}
      activeWs = null;
    }

    wss.close();
    server.close();
  }

  return new Promise<ReviewSession>((resolve, reject) => {
    server.listen(config.port, config.host, () => {
      const addr = server.address();
      if (addr == null || typeof addr === "string") {
        reject(new Error("Failed to bind server"));
        return;
      }

      const boundPort = addr.port;
      const baseUrl = config.publicUrl ?? `http://${config.host}:${boundPort}`;
      const sessionUrl = `${baseUrl}/?token=${token}`;

      startHeartbeat();
      resetSessionTimeout();

      resolve({
        send(message: ReviewHostMessage): void {
          if (activeWs == null || activeWs.readyState !== activeWs.OPEN) return;
          activeWs.send(JSON.stringify(message));
        },
        waitForResult: () => resultPromise,
        close: () => {
          settle(null);
          cleanup();
        },
        url: sessionUrl,
        port: boundPort,
        token,
      });
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}
