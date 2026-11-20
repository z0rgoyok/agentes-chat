import { type Database, rowsOf, sql } from "@agenteschat/db";

// Every column that holds text (a string, an array of them or JSON), but the ids a foreign key ties at either end.
const TEXT_COLUMNS = `
  select c.relname as "table", a.attname as "column",
    case when t.typname = 'jsonb' then 'json' when t.typcategory = 'A' then 'array' else 'text' end as "type"
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid
  join pg_type t on t.oid = a.atttypid
  left join pg_type e on e.oid = t.typelem and t.typcategory = 'A'
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
    and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
    and (t.typcategory = 'S' or t.typname = 'jsonb' or e.typcategory = 'S')
    and not exists (select 1 from pg_constraint k where k.contype = 'f'
      and ((k.conrelid = c.oid and a.attnum = any(k.conkey)) or (k.confrelid = c.oid and a.attnum = any(k.confkey))))
  order by 1, 2`;

// A JSON value with every string in it replaced by the path that leads to it, but ids, times and what `keep` names.
const CANARY_JSON = `
  create function canary_json(j jsonb, path text, keep text[]) returns jsonb language plpgsql as $$
  begin
    if path = any(keep) then return j; end if;
    case jsonb_typeof(j)
      when 'string' then
        if (j #>> '{}') ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)$'
        then return j; end if;
        return to_jsonb(path);
      when 'object' then
        return coalesce((select jsonb_object_agg(e.key, canary_json(e.value, path || '.' || e.key, keep))
          from jsonb_each(j) e), '{}'::jsonb);
      when 'array' then
        return coalesce((select jsonb_agg(canary_json(e.value, path, keep) order by e.n)
          from jsonb_array_elements(j) with ordinality e(value, n)), '[]'::jsonb);
      else return j;
    end case;
  end $$`;

/**
 * Gives every text column of the database a canary that names it (`canary.<table>.<column>`, and inside JSON the
 * path that leads to each string), in every row, but the columns `keep` lists as `table: columns` (`column.path`
 * inside a JSON column). Returns how many columns.
 */
export async function poison(db: Database, keep: Record<string, string[]>) {
  const columns = rowsOf<{ table: string; column: string; type: "text" | "array" | "json" }>(
    await db.execute(sql.raw(TEXT_COLUMNS)),
  );
  const kept = Object.entries(keep).flatMap(([table, names]) => names.map((name) => `${table}.${name}`));
  const paths = `array[${kept.map((k) => `'canary.${k}'`).join(", ")}]::text[]`;
  await db.execute(sql.raw("create sequence canary_n"));
  await db.execute(sql.raw(CANARY_JSON));
  let poisoned = 0;
  for (const { table, column, type } of columns) {
    if (kept.includes(`${table}.${column}`)) continue;
    const name = `canary.${table}.${column}`;
    // Numbered: some of these columns are unique.
    const mark = `'${name}.r' || nextval('canary_n')`;
    const value =
      type === "text" ? mark : type === "array" ? `array[${mark}]` : `canary_json("${column}", '${name}', ${paths})`;
    await db.execute(sql.raw(`update "${table}" set "${column}" = ${value}`));
    poisoned += 1;
  }
  return poisoned;
}
