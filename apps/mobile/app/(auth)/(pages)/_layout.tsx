import { type NativeStackNavigationOptions, Stack } from "expo-router";
import { useMemo } from "react";
import { coverBarOptions, usePushedOptions, useScrollUnderPushedOptions } from "@/ui/navigation";
import { useTheme } from "@/ui/theme";

/**
 * Sign in and sign up (the e-mail, then each step the server asks for: `sign-in/*`), your server and the QR scanner:
 * the platform's push between them, the system's back (the bar's button, the edge swipe) going to the screen before.
 * Their sky is the cover, so the bar is clear over it, the back button over the art; the first screen has none. The
 * language's list is pushed like any list, its content scrolling under the bar.
 */
export default function AuthPages() {
  const { colors } = useTheme();
  const pushed = usePushedOptions();
  const scrollUnder = useScrollUnderPushedOptions();
  const screenOptions = useMemo(() => {
    const sky: NativeStackNavigationOptions = {
      ...pushed,
      ...coverBarOptions,
      contentStyle: { backgroundColor: colors.bg },
    };
    const list: NativeStackNavigationOptions = { ...pushed, ...scrollUnder };
    return ({ route }: { route: { name: string } }) => (route.name === "language" ? list : sky);
  }, [colors.bg, pushed, scrollUnder]);
  return <Stack screenOptions={screenOptions} />;
}
