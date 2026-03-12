export { getConfigValue, setConfigValue, validateConfig } from "./manager.js";
export type { ConfigChange } from "./manager.js";
export {
  DEFAULT_DATA_DIR,
  resolveDataDir,
  orgChartPath,
  projectManifestPath,
  eventsDir,
  daemonPidPath,
  daemonSocketPath,
  murmurStateDir,
  memoryDbPath,
  runArtifactDir,
} from "./paths.js";
