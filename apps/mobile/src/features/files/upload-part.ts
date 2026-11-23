import { File } from "expo-file-system";

/** A file on the phone (a picked photo, video or document, one shared from another app) on its way up. */
export interface LocalFile {
  uri: string;
  name: string;
  type: string;
}

/**
 * A local file as a form part the app's `fetch` sends. That `fetch` is Expo's, whose FormData takes a part with
 * `bytes()` (its filename and type from `name` and `type`) and refuses React Native's `{ uri }` part: given one, every
 * upload threw "Unsupported FormDataPart implementation" before it left the phone, so no photo, video or file ever went
 * (the voice messages met it first: `voice/outbox.ts`). The bytes are read only as the request is built.
 */
export function uploadPart(file: LocalFile): globalThis.File {
  const source = new File(file.uri);
  return { name: file.name, type: file.type, bytes: () => source.bytes() } as unknown as globalThis.File;
}
