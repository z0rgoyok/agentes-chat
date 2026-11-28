import type { Skill } from "@agenteschat/client";
import { cx, Icon, type IconName } from "@agenteschat/ui";
import { AgentAvatar } from "@/components/AgentAvatar";

/*
 * What every skill screen shows of a skill: its name for people (else its file name), its line (else what its
 * SKILL.md says), its icon on the connector plate, and the faces of the agents that know it.
 */

/** Its name for people, written when it was installed or made; its own name until then. */
export const skillTitle = (s: Pick<Skill, "name" | "title">) => s.title?.trim() || s.name;

/** When to use it, in one line: the line written for people, else the first line of its description. */
export const skillLine = (s: Pick<Skill, "summary" | "description">) =>
  s.summary?.trim() || s.description.split(/\n/)[0]?.trim() || "";

/** The icons a skill may carry (`SKILL_ICONS` on the server); anything else is a book. */
const ICONS: ReadonlySet<string> = new Set<IconName>([
  "book",
  "chart",
  "document",
  "page",
  "table",
  "mail",
  "message",
  "quote",
  "image",
  "video",
  "code",
  "pullRequest",
  "issues",
  "calendar",
  "search",
  "globe",
  "wallet",
  "coin",
  "send",
  "note",
  "members",
  "person",
  "shield",
  "bulb",
  "database",
  "diagram",
  "drive",
  "edit",
  "list",
  "phone",
  "repo",
  "routines",
  "mic",
  "layers",
  "flag",
  "check",
  "clock",
]);
export const skillIcon = (s: Pick<Skill, "icon">): IconName =>
  s.icon && ICONS.has(s.icon) ? (s.icon as IconName) : "book";

/** The skill's icon on the connector plate (as an app's in Connectors): `md` in a card's rows, `lg` in lists, `xl` on its page. */
export function SkillMark({ skill, size = "lg" }: { skill: Pick<Skill, "icon">; size?: "md" | "lg" | "xl" }) {
  return (
    <span
      className={cx(
        "connector-icon connector-icon--mono",
        size !== "md" && "connector-icon--lg",
        `sk-mark sk-mark--${size}`,
      )}
      aria-hidden="true"
    >
      <Icon name={skillIcon(skill)} size={size === "md" ? 16 : 20} />
    </span>
  );
}

/** The faces of the agents that know a skill, the first few, each named on hover. */
export function SkillFaces({
  ids,
  nameOf,
  max = 5,
}: {
  ids: readonly string[];
  nameOf: (id: string) => string;
  max?: number;
}) {
  // An empty cell keeps the row's columns in place.
  if (ids.length === 0) return <span className="ac-avatar-stack sk-faces" aria-hidden="true" />;
  return (
    <span className="ac-avatar-stack sk-faces">
      {ids.slice(0, max).map((id) => (
        <AgentAvatar key={id} agentId={id} name={nameOf(id)} size="xs" labelled title={nameOf(id)} />
      ))}
      {ids.length > max && <span className="sk-faces__more tabular">+{ids.length - max}</span>}
    </span>
  );
}
