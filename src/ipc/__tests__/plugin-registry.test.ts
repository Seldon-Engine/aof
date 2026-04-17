/**
 * Phase 43 — Wave 0 RED test
 *
 * Covers decision D-11: plugin registration is IMPLICIT — an active long-poll
 * IS a registered plugin. Registry tracks active handles; auto-releases on
 * `res.on("close")` fire.
 *
 * RED anchor: imports from "../plugin-registry.js" which does not yet exist.
 * Wave 2 lands `src/ipc/plugin-registry.ts` exporting `PluginRegistry`.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PluginRegistry } from "../plugin-registry.js"; // INTENTIONALLY MISSING — Wave 2 creates this (D-11).

/**
 * Minimal EventEmitter-based stand-in for IncomingMessage/ServerResponse.
 * PluginRegistry subscribes to `res.on("close")` — we only need that surface
 * for the auto-release contract.
 */
function makeReqRes(): { req: EventEmitter; res: EventEmitter } {
  return { req: new EventEmitter(), res: new EventEmitter() };
}

describe("PluginRegistry (D-11 implicit registration)", () => {
  it("hasActivePlugin() is false initially", () => {
    const registry = new PluginRegistry();
    expect(registry.hasActivePlugin()).toBe(false);
  });

  it("register(req, res) returns a handle; hasActivePlugin() becomes true", () => {
    const registry = new PluginRegistry();
    const { req, res } = makeReqRes();

    const handle = registry.register(req as never, res as never);

    expect(handle).toBeDefined();
    expect(registry.hasActivePlugin()).toBe(true);
  });

  it("handle.release() clears the registration", () => {
    const registry = new PluginRegistry();
    const { req, res } = makeReqRes();

    const handle = registry.register(req as never, res as never);
    handle.release();

    expect(registry.hasActivePlugin()).toBe(false);
  });

  it("activeCount() returns N after N registrations", () => {
    const registry = new PluginRegistry();
    const handles = [];

    for (let i = 0; i < 3; i++) {
      const { req, res } = makeReqRes();
      handles.push(registry.register(req as never, res as never));
    }

    expect(registry.activeCount()).toBe(3);
    // Release one; count drops.
    handles[0]!.release();
    expect(registry.activeCount()).toBe(2);
  });

  it("res.on('close') firing auto-releases the registration (Pitfall 2)", () => {
    const registry = new PluginRegistry();
    const { req, res } = makeReqRes();

    registry.register(req as never, res as never);
    expect(registry.hasActivePlugin()).toBe(true);

    // Simulate the HTTP server closing the response stream.
    res.emit("close");

    expect(registry.hasActivePlugin()).toBe(false);
  });

  it("reset() clears all registrations (test helper)", () => {
    const registry = new PluginRegistry();

    for (let i = 0; i < 5; i++) {
      const { req, res } = makeReqRes();
      registry.register(req as never, res as never);
    }
    expect(registry.activeCount()).toBe(5);

    registry.reset();
    expect(registry.activeCount()).toBe(0);
    expect(registry.hasActivePlugin()).toBe(false);
  });

  it("D-13: pluginId defaults to 'openclaw' for registrations without explicit id", () => {
    const registry = new PluginRegistry();
    const { req, res } = makeReqRes();

    registry.register(req as never, res as never);

    expect(registry.hasActivePlugin("openclaw")).toBe(true);
  });
});
