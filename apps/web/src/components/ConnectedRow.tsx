import type { Agent } from "@agenteschat/client";
import { AvatarStack, FoldRow } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";

/** Faces on the line: the count after them says how many there are. */
const MAX_FACES = 5;

/**
 * Settings → Conectores: one connected thing (a service, an MCP server, a mailbox, a database) as one line: its tile,
 * its name, its state's pill and who uses it. The line opens to `details` (the account, when, how many tools) and
 * `actions`. Whatever needs the person is a pill on the line, never only inside.
 */
export function ConnectedRow({
  icon,
  name,
  chips,
  meta,
  using,
  total,
  details,
  actions,
}: {
  icon: ReactNode;
  name: string;
  chips: ReactNode;
  /** A line under the name at the row's full width (whose personal connection it is). */
  meta?: ReactNode;
  using: Agent[];
  total: number;
  /** One muted line each, always in the same order. */
  details: ReactNode[];
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <FoldRow
      className="connected-row"
      face={icon}
      title={
        <span className="list-title">
          <span>{name}</span>
          {chips}
        </span>
      }
      body={meta && <MetaLine>{meta}</MetaLine>}
      end={
        <span className="connected-row__who small muted">
          {using.length > 0 && (
            <AvatarStack>
              {using.slice(0, MAX_FACES).map((a) => (
                <AgentAvatar key={a.id} agentId={a.id} name={a.name} size="xs" />
              ))}
            </AvatarStack>
          )}
          {using.length > 0 ? t("connectors.usedBy", { count: using.length, total }) : t("connectors.usedByNone")}
        </span>
      }
    >
      {details.map(
        (line, i) =>
          line && (
            // biome-ignore lint/suspicious/noArrayIndexKey: a line's place is what it is
            <span key={i} className="connected-row__text small muted">
              {line}
            </span>
          ),
      )}
      {actions && <div className="ac-acts">{actions}</div>}
    </FoldRow>
  );
}

function MetaLine({ children }: { children: ReactNode }) {
  return <span className="ac-mediarow__meta connected-row__meta ac-iconline">{children}</span>;
}
