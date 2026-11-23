import { fromBase64, toBase64 } from "@agenteschat/live";
import { Directory, File, Paths } from "expo-file-system";
import { perServer } from "@/lib/server";

/**
 * Changes made to a live file on this phone that the server hasn't stored yet (ADR 0196 §2), kept across the app being
 * closed: one file per live file and server, in the app's own documents (not the cache, which the system may clear),
 * as `lib/outbox.ts` keeps unsent messages. They go back into the file the next time it opens, and leave once the
 * server has them. Never throws: a phone that can't keep them still sends them while the app stays open.
 */
export interface KeptChanges {
  read(fileId: string): Uint8Array | null;
  /** Null forgets them (the server has them all). */
  write(fileId: string, update: Uint8Array | null): void;
}

const folder = () => new Directory(Paths.document, "live-files");

export const keptChangesFor = (server: string): KeptChanges => {
  const file = (fileId: string) => new File(folder(), `${perServer(`unsent-${fileId}`, server)}.b64`);
  return {
    read(fileId) {
      try {
        const f = file(fileId);
        if (!f.exists) return null;
        const bytes = fromBase64(f.textSync().trim());
        return bytes.byteLength > 0 ? bytes : null;
      } catch {
        return null;
      }
    },
    write(fileId, update) {
      try {
        const f = file(fileId);
        if (!update || update.byteLength === 0) {
          if (f.exists) f.delete();
          return;
        }
        if (!folder().exists) folder().create({ intermediates: true });
        f.write(toBase64(update));
      } catch {
        // Not kept: they still go while the app stays open.
      }
    },
  };
};
