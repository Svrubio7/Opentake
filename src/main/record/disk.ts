// Free space on the drive that holds the recordings.
import { mkdir, statfs } from "node:fs/promises";
import type { DiskSpace } from "../../shared/types";
import { recordingsRoot } from "./takes";

export async function diskSpace(): Promise<DiskSpace> {
  const root = recordingsRoot();
  await mkdir(root, { recursive: true });
  const s = await statfs(root);
  return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
}
