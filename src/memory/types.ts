import Database from "better-sqlite3";

/** Type alias for a better-sqlite3 database instance */
export type SqliteDb = InstanceType<typeof Database>;
