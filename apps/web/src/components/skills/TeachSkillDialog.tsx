import type { SkillDraft } from "@agenteschat/client";
import { useDraftSkill, useSaveDraftedSkill } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  Locked,
  Menu,
  MenuCheckboxItem,
  Select,
  Textarea,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { Markdown } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import { SkillMark } from "./common";
import "./skills.css";

/**
 * "Teach something new": one question (how the work is done, in the person's words), who will know it and, where skills
 * split, for whom. The right hand writes the skill (title, when, steps) and shows it before it is saved, with the
 * apps it uses that an agent doesn't have yet; "Adjust" changes it in words. A GitHub link or a .zip are the other
 * ways in, from the footer.
 */
export function TeachSkillDialog({
  open,
  onOpenChange,
  agentIds,
  personalOnly,
  split,
  onSaved,
  onFromLink,
  onFromZip,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Who will know it, to start with. */
  agentIds: string[];
  /** Only a skill of the person's own (they don't manage agents). */
  personalOnly: boolean;
  /** Skills split into the team's and each person's: "For whom" shows. */
  split: boolean;
  onSaved: (id: string) => void;
  onFromLink?: () => void;
  onFromZip?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const write = useDraftSkill(org.id);
  const save = useSaveDraftedSkill(org.id);
  const rightHand = rightHandOf(dir.agents);
  const writer = rightHand?.name ?? t("skills.teach.writer");
  const [words, setWords] = useState("");
  const [who, setWho] = useState<string[]>(agentIds);
  const [personal, setPersonal] = useState(personalOnly);
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [change, setChange] = useState("");
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh dialog on each opening
  useEffect(() => {
    if (!open) return;
    setWords("");
    setWho(agentIds);
    setPersonal(personalOnly);
    setDraft(null);
    setChange("");
    setError(null);
  }, [open]);

  const nameOf = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const whoNames = joinNames(who.map(nameOf), t);
  const busy = write.isPending || save.isPending;
  const fail = (e: unknown) => setError(errorText(t, e as Error));

  const writeIt = (withChange?: string) => {
    setError(null);
    write.mutate(
      {
        words,
        agentIds: who,
        ...(personal ? { personal } : {}),
        ...(draft && withChange ? { draft, change: withChange } : {}),
      },
      {
        onSuccess: (d) => {
          setDraft(d);
          setChange("");
        },
        onError: fail,
      },
    );
  };
  const saveIt = () => {
    if (!draft) return;
    setError(null);
    const { apps: _apps, ...skill } = draft;
    save.mutate(
      { ...skill, agentIds: who, ...(personal ? { personal } : {}) },
      {
        onSuccess: (saved) => {
          toast.show(
            who.length > 0
              ? t("skills.teach.saved", { skill: draft.title, agents: whoNames, count: who.length })
              : t("skills.teach.savedNobody", { skill: draft.title }),
            "success",
          );
          onOpenChange(false);
          onSaved(saved.id);
        },
        onError: fail,
      },
    );
  };

  const whoPicker = (
    <Menu
      align="start"
      label={t("skills.teach.who")}
      trigger={
        <div className="ac-select sk-who">
          <button type="button" className="ac-select__trigger">
            <span className="ac-select__value">
              {who.length > 0 ? (
                <>
                  <span className="ac-avatar-stack">
                    {who.slice(0, 3).map((id) => (
                      <AgentAvatar key={id} agentId={id} name={nameOf(id)} size="xs" />
                    ))}
                  </span>
                  <span className="ac-select__text">{whoNames}</span>
                </>
              ) : (
                <span className="ac-select__text muted">{t("skills.teach.nobody")}</span>
              )}
            </span>
            <Icon name="chevronDown" size={16} className="ac-select__chev" />
          </button>
        </div>
      }
    >
      {dir.agents.map((a) => (
        <MenuCheckboxItem
          key={a.id}
          leading={<AgentAvatar agentId={a.id} name={a.name} size="xs" />}
          checked={who.includes(a.id)}
          onCheckedChange={(on) => setWho((w) => (on ? [...w, a.id] : w.filter((x) => x !== a.id)))}
        >
          {a.name}
        </MenuCheckboxItem>
      ))}
    </Menu>
  );

  /** The apps the skill uses: who lacks one (with the way to give it), else that every agent has them. */
  const appsLine = (d: SkillDraft) => {
    if (d.apps.length === 0 || who.length === 0) return null;
    const lacking = d.apps.filter((a) => a.missing.length > 0);
    if (lacking.length === 0)
      return (
        <p className="sk-teach__check ac-iconline">
          <Icon name="check" size={16} />
          <span>
            {t("skills.teach.appsOk", {
              agents: whoNames,
              apps: joinNames(
                d.apps.map((a) => a.label),
                t,
              ),
              count: who.length,
            })}
          </span>
        </p>
      );
    return lacking.map((app) => (
      <p key={app.id} className="sk-teach__check sk-teach__check--miss ac-iconline">
        <Icon name="alert" size={16} />
        <span>
          {t("skills.teach.appMissing", {
            agents: joinNames(app.missing.map(nameOf), t),
            app: app.label,
            count: app.missing.length,
          })}{" "}
          {app.missing[0] && (
            <Link
              className="ac-link"
              to="/org/$orgId/agents/$agentId"
              params={{ orgId: org.id, agentId: app.missing[0] }}
              search={{ tab: "access" }}
            >
              {t("skills.teach.giveAccess")}
            </Link>
          )}
        </span>
      </p>
    ));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("skills.page.teachNew")}
      closeLabel={t("common.close")}
      width={560}
      unsaved={words.trim().length > 0 && !save.isSuccess}
    >
      <Locked when={busy}>
        <DialogBody className="sk-teach">
          {!draft ? (
            <>
              <Field
                label={personal ? t("skills.teach.askMine") : t("skills.teach.ask")}
                id="sk-teach-words"
                example={t("skills.teach.help", agentGrammar(writer))}
              >
                <Textarea
                  rows={6}
                  autoGrow
                  value={words}
                  onChange={(e) => setWords(e.target.value)}
                  placeholder={t("skills.teach.placeholder")}
                />
              </Field>
              <div className="sk-teach__pair">
                <Field label={t("skills.teach.who")} group>
                  {whoPicker}
                </Field>
                {split && !personalOnly && (
                  <Field label={t("skills.personal.forWhom")}>
                    <Select
                      value={personal ? "personal" : "team"}
                      onValueChange={(v) => setPersonal(v === "personal")}
                      options={[
                        { value: "team", label: t("skills.teach.forTeam"), leading: <Icon name="members" size={16} /> },
                        { value: "personal", label: t("skills.teach.forMe"), leading: <Icon name="lock" size={16} /> },
                      ]}
                    />
                  </Field>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="sk-teach__said ac-iconline">
                {rightHand && <AgentAvatar agentId={rightHand.id} name={rightHand.name} size="sm" />}
                <span>{t("skills.teach.wrote")}</span>
              </p>
              <div className="sk-teach__draft">
                <div className="sk-teach__head ac-mediarow">
                  <span className="ac-mediarow__face">
                    <SkillMark skill={draft} />
                  </span>
                  <span className="ac-mediarow__head">
                    <h3>{draft.title}</h3>
                  </span>
                  <p className="ac-mediarow__body muted">{draft.summary}</p>
                </div>
                <h4 className="ac-eyebrow">{t("skills.one.how")}</h4>
                <div className="sk-teach__body">
                  <Markdown source={draft.body} />
                </div>
                {appsLine(draft)}
              </div>
              <form
                className="sk-ask"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (change.trim()) writeIt(change.trim());
                }}
              >
                <Input
                  aria-label={t("skills.teach.adjust")}
                  value={change}
                  onChange={(e) => setChange(e.target.value)}
                  placeholder={t("skills.teach.adjustPlaceholder")}
                />
                <Button type="submit" disabled={!change.trim() || busy} loading={write.isPending}>
                  {t("skills.teach.adjust")}
                </Button>
              </form>
            </>
          )}
          {error && <Alert>{error}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter
        note={
          !draft && (onFromLink || onFromZip) ? (
            // The icon and the question as one line; the ways in after it, out of that line.
            <span className="sk-teach__other">
              <span className="ac-iconline">
                <Icon name="link" size={14} />
                <span>{t("skills.teach.haveOne")}</span>
              </span>
              {onFromLink && (
                <button type="button" className="ac-link" onClick={onFromLink}>
                  {t("skills.teach.link")}
                </button>
              )}
              {onFromLink && onFromZip && <span aria-hidden="true">·</span>}
              {onFromZip && (
                <button type="button" className="ac-link" onClick={onFromZip}>
                  {t("skills.teach.zip")}
                </button>
              )}
            </span>
          ) : undefined
        }
        busyNote={write.isPending ? t("skills.teach.writing", agentGrammar(writer)) : undefined}
      >
        {draft ? (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
              {t("common.back")}
            </Button>
            <Button variant="primary" disabled={busy} loading={save.isPending} onClick={saveIt}>
              {who.length > 0 ? t("skills.teach.saveFor", { agents: whoNames }) : t("skills.teach.save")}
            </Button>
          </>
        ) : (
          <>
            <Button disabled={busy} onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={!words.trim() || busy}
              loading={write.isPending}
              onClick={() => writeIt()}
            >
              {t("skills.teach.write")}
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
