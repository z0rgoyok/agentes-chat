import { Redirect } from "expo-router";

export default function ManagedServerOnly() {
  return <Redirect href="/me/workspaces" />;
}
