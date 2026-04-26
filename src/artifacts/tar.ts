import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runTar(args: string[]): Promise<void> {
  try {
    await execFileAsync("tar", args, { maxBuffer: 1024 * 1024 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`tar failed: ${message}`);
  }
}

export async function createTarGz(sourceDir: string, archivePath: string): Promise<void> {
  await mkdir(dirname(archivePath), { recursive: true });
  await runTar(["-czf", archivePath, "-C", dirname(sourceDir), basename(sourceDir)]);
}

export async function extractTarGz(archivePath: string, destParent: string): Promise<void> {
  await mkdir(destParent, { recursive: true });
  await runTar(["-xzf", archivePath, "-C", destParent]);
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
