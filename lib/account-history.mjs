import { createReadStream } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Paginated rollouts refer to their original home's projection database. A
// private legacy-header snapshot lets official fork replay the same raw events
// in another home; only the storage-mode header changes, never the transcript.
export async function portableRollout(source, home, thread) {
  const original = await stat(source),
    directory = path.join(home, "imports");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, randomUUID() + ".jsonl"),
    output = await open(file, "wx", 0o600);
  let header = Buffer.alloc(0),
    started = false;
  try {
    if (!original.size) throw Error("empty rollout");
    for await (const chunk of createReadStream(source, { end: original.size - 1 })) {
      if (started) {
        await output.writeFile(chunk);
        continue;
      }
      header = Buffer.concat([header, chunk]);
      const newline = header.indexOf(10);
      if (newline < 0) {
        if (header.length > 4 * 1024 * 1024) throw Error("oversize header");
        continue;
      }
      const record = JSON.parse(header.subarray(0, newline).toString("utf8"));
      if (record.type !== "session_meta" || record.payload?.id !== thread)
        throw Error("rollout identity changed");
      record.payload.history_mode = "legacy";
      await output.writeFile(JSON.stringify(record) + "\n");
      await output.writeFile(header.subarray(newline + 1));
      header = null;
      started = true;
    }
    const latest = await stat(source);
    if (!started || latest.size !== original.size || latest.mtimeMs !== original.mtimeMs)
      throw Error("source updated during copy");
    await output.sync();
    return file;
  } catch (e) {
    await unlink(file).catch(() => {});
    throw e;
  } finally {
    await output.close();
  }
}
