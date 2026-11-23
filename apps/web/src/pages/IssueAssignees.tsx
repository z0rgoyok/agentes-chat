import type { Actor } from "@agenteschat/client";
import { joinNames } from "@agenteschat/client/lib/format";
import { assigneeNames } from "@agenteschat/client/lib/issues";
import { AvatarStack, Button, Dialog, DialogBody, DialogFooter } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { actorFromKey, actorKey, useActors } from "@/components/actors";
import { PeoplePicker, type PickKey } from "@/components/MemberPicker";

/** The agent of a task that is at work, and how: its face moves while it runs and rests closed once stalled. */
export interface WorkingFace {
  agentId: string;
  work: "running" | "stalled";
}

/**
 * Several people and agents as faces only, overlapping, in their order: the first `max`, then a quiet "+N". Everyone's
 * name is the group's title and its accessible name, as the faces alone name nobody. The agent at work keeps its
 * moving face, whole above its neighbours.
 */
export function AssigneeFaces({
  all,
  working,
  max = 3,
  size = "sm",
}: {
  all: Actor[];
  working?: WorkingFace;
  max?: number;
  size?: "xs" | "sm";
}) {
  const { t } = useTranslation();
  const actors = useActors();
  const names = joinNames(all.map(actors.name), t);
  return (
    <span className="issue-faces" data-size={size} role="img" aria-label={names} title={names}>
      <AvatarStack>
        {all
          .slice(0, max)
          .map((a) =>
            a.type === "agent" && working?.agentId === a.id ? (
              <AgentAvatar
                key={actorKey(a)}
                className="issue-faces__working"
                agentId={a.id}
                size={size}
                name={actors.name(a)}
                running={working.work === "running"}
                state={working.work === "running" ? "writing" : undefined}
                expression={working.work === "stalled" ? "closed" : undefined}
              />
            ) : (
              actors.avatar(a, size)
            ),
          )}
      </AvatarStack>
      {all.length > max && <span className="issue-faces__more tabular">+{all.length - max}</span>}
    </span>
  );
}

/**
 * "Assignee" as a dialog: the people and agents of the workspace with a box each, the picked ones on top. Every change
 * is told at once (`onChange`, the whole list in the order they were picked), so its one button only closes.
 */
export function AssigneesDialog({
  value,
  onChange,
  onClose,
}: {
  value: Actor[];
  onChange: (next: Actor[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const selected = new Set(value.map(actorKey)) as Set<PickKey>;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("issues.form.assignee")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogBody>
        <PeoplePicker
          label={t("issues.assignees.people")}
          searchLabel={t("newChannel.membersSearch")}
          emptyText={(q) => t("newChannel.membersEmpty", { q })}
          selected={selected}
          onChange={(next) => onChange([...next].flatMap((k) => actorFromKey(k) ?? []))}
          me
        />
      </DialogBody>
      <DialogFooter bar note={t("newChannel.selected", { count: value.length })}>
        <Button variant="primary" onClick={onClose}>
          {t("issues.assignees.done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Who has a task, as the button that changes it: their faces and their names as a short list, or the field's name
 * with the person glyph while nobody has it. It opens `AssigneesDialog`.
 */
export function AssigneesField({ value, onChange }: { value: Actor[]; onChange: (next: Actor[]) => void }) {
  const { t } = useTranslation();
  const actors = useActors();
  const [open, setOpen] = useState(false);
  const label = t("issues.form.assignee");
  const names = assigneeNames(t, value.map(actors.name));
  const [only] = value;
  return (
    <>
      <Button
        size="sm"
        icon={only ? undefined : "person"}
        aria-label={only ? `${label}: ${joinNames(value.map(actors.name), t)}` : label}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {value.length > 1 ? <AssigneeFaces all={value} size="xs" max={4} /> : only && actors.avatar(only, "xs")}
        {only ? names : label}
      </Button>
      {open && <AssigneesDialog value={value} onChange={onChange} onClose={() => setOpen(false)} />}
    </>
  );
}
