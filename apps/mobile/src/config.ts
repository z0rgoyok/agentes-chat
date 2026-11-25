import Constants from "expo-constants";
import { MANAGED_SERVER } from "./lib/managed-server";

/** Removes trailing slashes: "https://app.agentes.chat/" → "https://app.agentes.chat". */
export const trimBase = (url: string) => url.replace(/\/+$/, "");

const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: string; variant?: string };

/** The managed service for this app, independent of saved settings or build environment. */
export const API_URL = MANAGED_SERVER;

/** "development" | "preview" | "production". */
export const APP_VARIANT = extra.variant ?? "production";

/** The deep-link scheme (app.config.ts `scheme`). */
export const SCHEME = "agenteschat";

/** Prefix for everything the app keeps in SecureStore (keys allow only letters, digits, ".", "-" and "_"). */
export const STORAGE_PREFIX = "agenteschat";
