import { Platform } from "react-native";
import { RISE_IN } from "@/ui";

/**
 * A row that just arrived at the bottom rises 6pt into place (`RISE_IN`: `--dur-base`, as on the web, on the strong
 * ease-out every entrance uses); only while it is fresh: history, a jump and a row scrolled back into view never do.
 */
export const ENTER = RISE_IN;
export const FRESH_MS = 800;
/** The composer's capsule from the screen's sides; what lines up with it (the "@" picker, who is working) too. */
export const DOCK_SIDE = 16;
/** Holding a message opens the system's menu where there is one (iOS); elsewhere, the app's sheet. */
export const NATIVE_MENU = Platform.OS === "ios";
