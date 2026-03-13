/**
 * Shared types for context module.
 *
 * Extracted to break the circular dependency between assembler.ts and manifest.ts.
 */

export interface ContextManifest {
  version: 'v1';
  taskId: string;
  layers: {
    seed: string[];      // Always included (task card, inputs/)
    optional: string[];  // Included if budget allows
    deep: string[];      // Only on explicit request
  };
}
