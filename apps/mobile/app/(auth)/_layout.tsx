import { Sheet } from "@lodev09/react-native-true-sheet/navigation/expo-router";
import { useRouteSheetOptions } from "@/ui";

/** A link straight to the sheet still has the sign-in under it. */
export const unstable_settings = { anchor: "(pages)" };

/**
 * Signed out: the sign-in's screens (`(pages)`), and "Onde fica o seu workspace?" as a sheet over them, the system's
 * own as every sheet of the app (`useRouteSheetOptions`), sized to its rows.
 */
export default function AuthLayout() {
  const sheet = useRouteSheetOptions();
  return (
    <Sheet>
      <Sheet.Screen name="(pages)" />
      <Sheet.Screen name="where" options={sheet(["auto"])} />
    </Sheet>
  );
}
