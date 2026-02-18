import Database from "better-sqlite3";
import { load } from "sqlite-vec";

const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

const CREATE_FILES_TABLE = `
  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    chunk_count INTEGER NOT NULL,
    tier TEXT,
    pool TEXT,
    indexed_at INTEGER
  );
`;

const CREATE_CHUNKS_TABLE = `
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    tier TEXT,
    pool TEXT,
    importance REAL,
    tags TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    accessed_at INTEGER,
    UNIQUE(file_path, chunk_index)
  );
`;

const createVecTable = (dimensions: number) =>
  `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(chunk_id integer primary key, embedding float[${dimensions}]);`;

const CREATE_FTS_TABLE =
  "CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(content, file_path, tags);";

const applySchema = (db: Database, dimensions: number) => {
  db.exec(CREATE_FILES_TABLE);
  db.exec(CREATE_CHUNKS_TABLE);
  db.exec(createVecTable(dimensions));
  db.exec(CREATE_FTS_TABLE);
};

export function initMemoryDb(dbPath: string): Database;
export function initMemoryDb(dbPath: string, dimensions: number): Database;
export function initMemoryDb(
  dbPath: string,
  dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): Database {
  const db = new Database(dbPath);
  load(db);
  applySchema(db, dimensions);
  return db;
}
