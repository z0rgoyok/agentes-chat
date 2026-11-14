import { type ApiClient, createHttpApi } from "@agenteschat/client";
import { appHeaders, readCookie } from "./auth";
import { serverOf } from "./server-choice";

/**
 * The API client for a place (a server, or one of its accounts: ADR 0183): every request with the session cookie from SecureStore and
 * `X-Agentes-Client: mobile` (ADR 0035 §3). Screens reach it through `useApi()`.
 */
export const createApi = (place: string): ApiClient =>
  createHttpApi({ baseUrl: serverOf(place), headers: async () => appHeaders(await readCookie(place)) });
