/**
 * Internal HTTP helpers for IPC route handlers.
 *
 * Kept in-module so the request/response style is uniform across routes and
 * DoS mitigations (body-size caps — T-43-06) live in one place.
 *
 * @module ipc/http-utils
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { IpcError, IpcErrorKind } from "./schemas.js";

/** Default cap on incoming request bodies (1 MiB). */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/**
 * Read an HTTP request body into a UTF-8 string, capped at `maxBytes`.
 * Rejects with a `PayloadTooLargeError` when the cap is exceeded.
 */
export async function readBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) {
        const err = new PayloadTooLargeError(
          `request body exceeded ${maxBytes} bytes`,
        );
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Thrown by readBody when the body exceeds the configured cap. */
export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

/** Write a JSON response with the given HTTP status. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Send a typed IpcError response. Chooses HTTP status from the error kind. */
export function sendError(
  res: ServerResponse,
  error: IpcError,
): void {
  sendJson(res, httpStatusForKind(error.kind), { error });
}

/** HTTP status mapping for `IpcErrorKind` — consumers send this response code. */
export function httpStatusForKind(kind: IpcErrorKind): number {
  switch (kind) {
    case "validation":
      return 400;
    case "not-found":
      return 404;
    case "permission":
      return 403;
    case "timeout":
      return 504;
    case "unavailable":
      return 503;
    case "internal":
    default:
      return 500;
  }
}

/** Map unclassified thrown errors to an IpcError kind via message keywords. */
export function classifyError(err: unknown): IpcErrorKind {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/permission|forbidden|unauthorized/.test(msg)) return "permission";
  if (/not found/.test(msg)) return "not-found";
  if (/timeout|timed out/.test(msg)) return "timeout";
  return "internal";
}
