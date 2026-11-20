import { Redirect, useLocalSearchParams } from "expo-router";
import { WidgetEditScreen } from "@/features/dashboards/WidgetEditScreen";
import { isSafeId } from "@/features/shared/logic";

/** A widget's title or its alert (`/widget-edit/<id>?field=title|alert`), pushed from its screen. */
export default function WidgetEditRoute() {
  const { id, field } = useLocalSearchParams<{ id: string; field?: string }>();
  if (!isSafeId(id)) return <Redirect href="/dashboards" />;
  return <WidgetEditScreen key={id} id={id} field={field === "alert" ? "alert" : "title"} />;
}
