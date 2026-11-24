import type { PickOption } from "./PickerSheet";

/** Options in runs under their `section`'s header; one run with no header when none says one. */
export function sectionsOf(options: readonly PickOption[]): { key: string; title?: string; options: PickOption[] }[] {
  const out: { key: string; title?: string; options: PickOption[] }[] = [];
  for (const o of options) {
    const last = out.at(-1);
    if (last && (o.section === undefined || o.section === last.title)) last.options.push(o);
    else out.push({ key: o.section ?? o.key, ...(o.section ? { title: o.section } : {}), options: [o] });
  }
  return out;
}
