import type { SkillDetail, SkillEvent, SkillSourceUpdate, SkillUse } from "@agenteschat/client";
import { useApi, useRewriteSkill, useSkill, useSkillAction, useSkillSettings } from "@agenteschat/client";
import { errorText, isGone } from "@agenteschat/client/lib/errors";
import { joinNames, relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { messagePath } from "@agenteschat/client/lib/message-links";
import { can } from "@agenteschat/client/lib/permissions";
import {
  changedByText,
  changesSinceLink,
  SKILL_UPDATE_TOAST,
  skillPendingViews,
  skillRefusalText,
  skillRemovalText,
  skillUpdateErrorText,
  skillUpdateWords,
} from "@agenteschat/client/lib/skills";
import {
  Alert,
  Avatar,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  diffLines,
  EmptyState,
  Field,
  Icon,
  Input,
  Locked,
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuSeparator,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentSwitches } from "@/components/AgentSwitches";
import { ErrorState, LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { ProseDiff } from "@/components/ProseDiff";
import { EditSkill, PendingDiff } from "@/components/Skills";
import { useDirectory } from "@/hooks/useDirectory";
import { Markdown } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import { SkillFaces, SkillMark, skillLine, skillTitle } from "./common";
import "./skills.css";

/** How many files its "Also uses" names before "and N more". */
const FILES_NAMED = 4;

/** When to use it, two lines at most; "See more" opens all it says of that, in its own words (its description). */
function SkillAbout({ s, title }: { s: SkillDetail; title: string }) {
  const { t } = useTranslation();
  const line = skillLine(s);
  const ref = useRef<HTMLParagraphElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    // Measured again when the line changes (a new version's).
    if (!el || !line) return;
    const check = () => setCut(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(check);
    watch.observe(el);
    return () => watch.disconnect();
  }, [line]);
  if (!line) return null;
  const plain = (text: string) => text.replace(/\s+/g, " ").replace(/\.$/, "").trim();
  const more = cut || plain(s.description) !== plain(line);
  return (
    <>
      <p ref={ref} className="sk-one__line">
        {line}
      </p>
      {more && (
        <Button variant="link" className="sk-one__more" onClick={() => setOpen(true)}>
          {t("skills.one.readMore")}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen} title={title} closeLabel={t("common.close")} width={560}>
        <DialogBody>
          <p className="sk-one__about">{s.description}</p>
        </DialogBody>
      </Dialog>
    </>
  );
}

/**
 * A skill's page: what it teaches (its steps, the files it uses), who knows it and how often they used it this week,
 * where it was used, and what changed (each change opened in place, Undo on the newest). A change asked in words
 * applies at once with Undo; the rest (edit the text, update from its link, remove) is in "…". When its link and
 * the agents both changed it, the choice is one line with the two changes side by side.
 */
export function SkillPage({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const api = useApi();
  const dir = useDirectory(org.id);
  const skill = useSkill(org.id, id);
  const action = useSkillAction(org.id);
  const refresh = useSkillAction(org.id, { silent: true });
  // A skill's own "agents improve it" left unset follows the workspace's switch.
  const settings = useSkillSettings(org.id, can(org, "manage_agents"));
  const rewrite = useRewriteSkill(org.id, id);
  const [editing, setEditing] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [who, setWho] = useState<string[] | null>(null);
  const [savingWho, setSavingWho] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [ask, setAsk] = useState("");
  const [askError, setAskError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const s = skill.data;
  const back = (
    <Link to="/org/$orgId/skills" params={{ orgId: org.id }} className="ac-back">
      <Icon name="chevronLeft" />
      {t("skills.title")}
    </Link>
  );
  if (!s)
    return (
      <div className="page page--full sk-one">
        {back}
        {/* Removed says so; any other failure (offline, the server) offers to try again. */}
        {skill.isError && isGone(skill.error) ? (
          <EmptyState size="page" title={t("skills.one.goneTitle")}>
            {t("skills.one.gone")}
          </EmptyState>
        ) : skill.isError ? (
          <ErrorState error={skill.error} onRetry={() => void skill.refetch()} />
        ) : (
          <LoadingLine width={260} />
        )}
      </div>
    );

  const when = (at: string) => relativeTime(t, i18n.language, at);
  const nameOf = (agentId: string) => dir.agentById.get(agentId)?.name ?? t("channel.unknownAgent");
  const personName = (userId: string) => dir.memberById.get(userId)?.name ?? t("channel.unknownPerson");
  // A personal skill is its person's to change; a team one, who manages agents'. Everyone else reads it.
  const manages = s.ownerUserId ? s.ownerUserId === me.user.id : can(org, "manage_agents");
  const agentIds = s.agentIds ?? [];
  const weekUses = s.weekUses ?? 0;
  const history = s.history ?? [];
  const uses = s.uses ?? [];
  const title = skillTitle(s);
  const fromLink = s.source === "url" && Boolean(s.sourceUrl);

  const saveWho = async (ids: string[]) => {
    const before = new Set(agentIds);
    const after = new Set(ids);
    const changed = [...new Set([...before, ...after])].filter((a) => before.has(a) !== after.has(a));
    setSavingWho(true);
    try {
      for (const agentId of changed)
        await action.mutateAsync({ type: "assign", agentId, skills: [{ skillId: s.id, enabled: after.has(agentId) }] });
      setWho(null);
      void skill.refetch();
    } catch {
      // The app's error toast says why; the dialog stays open on what was picked.
    } finally {
      setSavingWho(false);
    }
  };
  const undo = () =>
    action.mutate(
      { type: "undoUpdate", id: s.id },
      {
        onSuccess: () => {
          toast.show(t("skills.one.undone", { name: title }));
          void skill.refetch();
        },
      },
    );
  const askChange = () => {
    const words = ask.trim();
    if (!words) return;
    setAskError(null);
    rewrite.mutate(words, {
      onSuccess: () => {
        setAsk("");
        void skill.refetch();
        toast.show(t("skills.one.changed", { name: title }), "success", { label: t("skills.undo"), run: undo });
      },
      onError: (e) => setAskError(errorText(t, e as Error)),
    });
  };
  const updateFromLink = () =>
    refresh.mutate(
      { type: "updateFromSource", id: s.id },
      {
        onSuccess: (r) => {
          toast.show(t(SKILL_UPDATE_TOAST[(r as SkillSourceUpdate).status], { name: title }));
          void skill.refetch();
        },
        onError: (e) => toast.show(skillRefusalText(t, e, can(org, "manage_connectors")), "error"),
      },
    );

  /** Who did a line of its history: an agent's face, a person's avatar, or its link. */
  const byFace = (e: SkillEvent) =>
    e.by?.type === "agent" ? (
      <AgentAvatar agentId={e.by.id} name={nameOf(e.by.id)} size="sm" />
    ) : e.by?.type === "person" ? (
      <Avatar
        name={personName(e.by.id)}
        imageUrl={dir.memberById.get(e.by.id)?.avatarUrl ?? undefined}
        size="sm"
        framed
      />
    ) : (
      <span className="sk-line__icon" aria-hidden="true">
        <Icon name="link" size={16} />
      </span>
    );
  const byName = (e: SkillEvent) =>
    e.by?.type === "agent" ? nameOf(e.by.id) : e.by?.type === "person" ? personName(e.by.id) : "";
  const eventText = (e: SkillEvent) => {
    const name = byName(e);
    switch (e.kind) {
      case "rewritten":
        return e.words
          ? t("skills.one.event.rewrittenWords", { name, words: e.words })
          : t("skills.one.event.rewritten", { name });
      case "link":
        return t("skills.one.event.link");
      default:
        return t(`skills.one.event.${e.kind}`, { name, ...(e.by?.type === "agent" ? agentGrammar(name) : {}) });
    }
  };

  /** Where a skill was used: the words that asked and the place, opening the conversation at that message. */
  const useLine = (u: SkillUse, i: number) => {
    const agent = nameOf(u.agentId);
    const place =
      u.channelKind === "channel" && u.channelName
        ? t("skills.one.inChannel", { agent, channel: u.channelName, ...agentGrammar(agent) })
        : u.channelKind === "dm"
          ? t("skills.one.inDm", agentGrammar(agent))
          : u.channelKind === "task"
            ? t("skills.one.inTask", agentGrammar(agent))
            : t("skills.one.somewhere", agentGrammar(agent));
    const to =
      u.channelId && u.messageId
        ? messagePath(org.id, { id: u.messageId, channelId: u.channelId, threadId: u.threadId })
        : null;
    return (
      <li key={`${u.at}-${i}`} className="sk-line ac-iconline">
        <AgentAvatar agentId={u.agentId} name={agent} size="sm" />
        <span className="sk-line__text">
          {to ? (
            <button type="button" className="sk-line__open" onClick={() => void navigate({ href: to })}>
              {u.excerpt ? t("skills.one.quoted", { words: u.excerpt }) : t("skills.one.openConversation")}
            </button>
          ) : (
            <b>{t("skills.one.usedPrivately")}</b>
          )}
          <small>
            {place} · {when(u.at)}
          </small>
        </span>
      </li>
    );
  };

  const words = skillUpdateWords(t, i18n.language, s);
  const waiting = words.waiting;
  const views = skillPendingViews(s);
  const agentsView = views.find((v) => v.id === "agents");
  const linkView = views.find((v) => v.id === "link");
  const by = changedByText(t, i18n.language, changesSinceLink(s), nameOf);
  const reopen = () => action.mutate({ type: "reopenUpdate", id: s.id }, { onSuccess: () => void skill.refetch() });
  const choose = (apply: boolean) =>
    action.mutate(
      { type: apply ? "approveUpdate" : "dismissUpdate", id: s.id },
      {
        onSuccess: (r) => {
          void skill.refetch();
          if (apply && (r as SkillSourceUpdate).status === "waiting")
            return toast.show(t("skills.pending.changedAgain", { name: title }), "info");
          toast.show(
            t((apply ? waiting?.applied : waiting?.kept) ?? "skills.pending.applied", { name: title }),
            "success",
            {
              label: t("skills.undo"),
              run: apply ? undo : reopen,
            },
          );
        },
      },
    );

  const files = s.files.filter((f) => f.status !== "ignored" && (manages || f.status === "stored"));
  const lastChange = history.find((e) => e.kind !== "installed" && e.kind !== "created");
  const origin = history.find((e) => e.kind === "installed" || e.kind === "created");
  const originText =
    s.origin === "agent" && s.ownerAgentId
      ? t("skills.one.learnedBy", { ...agentGrammar(nameOf(s.ownerAgentId)), when: when(s.createdAt) })
      : fromLink
        ? s.autoUpdate
          ? t("skills.one.fromLinkAuto")
          : t("skills.one.fromLink")
        : s.source === "upload"
          ? t("skills.one.fromZip")
          : origin?.by?.type === "person"
            ? t("skills.one.madeBy", { name: personName(origin.by.id), when: when(s.createdAt) })
            : t("skills.one.madeHere");

  return (
    <div className="page page--full sk-one">
      {back}
      {/* The title's capitals at the tile's top; the actions on its line while they fit, else under it. */}
      <header className="sk-one__head ac-faceline">
        <SkillMark skill={s} size="xl" />
        <div className="sk-one__main ac-actline">
          <div className="sk-one__titles">
            <h1 className="ac-captop">{title}</h1>
            <SkillAbout s={s} title={title} />
          </div>
          <div className="sk-one__acts ac-captop">
            {(manages || can(org, "manage_agents")) && (
              <Button onClick={() => setWho(agentIds)}>{t("skills.one.teachOther")}</Button>
            )}
            <Menu
              align="end"
              label={t("agent.moreActions")}
              trigger={<Button iconOnly icon="more" aria-label={t("agent.moreActions")} />}
            >
              {manages && (
                <>
                  <MenuItem icon="edit" onSelect={() => setEditing(true)}>
                    {t("skills.one.editText")}
                  </MenuItem>
                  <MenuItem icon="page" onSelect={() => setNaming(title)}>
                    {t("skills.one.rename")}
                  </MenuItem>
                  {fromLink && (
                    <>
                      <MenuItem icon="refresh" onSelect={updateFromLink}>
                        {t("skills.refresh")}
                      </MenuItem>
                      <MenuCheckboxItem
                        icon="clock"
                        checked={s.autoUpdate ?? false}
                        onCheckedChange={(on) => action.mutate({ type: "update", id: s.id, patch: { autoUpdate: on } })}
                      >
                        {t("skills.autoUpdate")}
                      </MenuCheckboxItem>
                    </>
                  )}
                  {!s.ownerUserId && (
                    <MenuCheckboxItem
                      icon="personAdd"
                      checked={s.defaultForNewAgents}
                      onCheckedChange={(on) =>
                        action.mutate({ type: "update", id: s.id, patch: { defaultForNewAgents: on } })
                      }
                    >
                      {t("skills.defaultForNew")}
                    </MenuCheckboxItem>
                  )}
                  {can(org, "manage_agents") && (
                    <MenuCheckboxItem
                      icon="bulb"
                      checked={s.agentsImprove ?? settings.data?.agentsImprove ?? true}
                      onCheckedChange={(on) =>
                        action.mutate({ type: "update", id: s.id, patch: { agentsImprove: on } })
                      }
                    >
                      {t("skills.agentsImproveThis")}
                    </MenuCheckboxItem>
                  )}
                </>
              )}
              {api.skills.zipUrl && (
                <MenuItem
                  icon="download"
                  onSelect={() => window.location.assign(api.skills.zipUrl?.(org.id, s.id) ?? "")}
                >
                  {t("skills.one.download")}
                </MenuItem>
              )}
              {manages && (
                <>
                  <MenuSeparator />
                  <MenuItem icon="trash" danger onSelect={() => setRemoving(true)}>
                    {t("skills.remove")}
                  </MenuItem>
                </>
              )}
            </Menu>
          </div>
        </div>
      </header>

      {manages && waiting && (
        <section className="sk-choice" aria-label={t("skills.waitingChip")}>
          <div className="sk-choice__line ac-actline">
            <span className="sk-choice__text ac-iconline">
              <Icon name="alert" size={16} />
              <span>
                {waiting.title}
                <small>{[by && `${by}.`, waiting.lead].filter(Boolean).join(" ")}</small>
              </span>
            </span>
            <div className="sk-choice__acts">
              <Button disabled={action.isPending} onClick={() => choose(false)}>
                {waiting.keep}
              </Button>
              <Button disabled={action.isPending} onClick={() => choose(true)}>
                {waiting.apply}
              </Button>
            </div>
          </div>
          {s.pendingUpdate?.edited && agentsView && linkView ? (
            <div className="sk-choice__two">
              <div>
                <h3>{t("skills.diff.agents")}</h3>
                <ProseDiff
                  label={t("skills.diff.agents")}
                  lines={diffLines(agentsView.before.body.split("\n"), agentsView.after.body.split("\n"))}
                />
              </div>
              <div>
                <h3>{t("skills.diff.link")}</h3>
                <ProseDiff
                  label={t("skills.diff.link")}
                  lines={diffLines(linkView.before.body.split("\n"), linkView.after.body.split("\n"))}
                />
              </div>
            </div>
          ) : (
            <PendingDiff skill={s as SkillDetail} />
          )}
        </section>
      )}
      {manages && words.kept && (
        <p className="small muted sk-quiet">
          <span>{words.kept}</span>{" "}
          <button type="button" className="ac-link" onClick={reopen}>
            {t("skills.undo")}
          </button>
        </p>
      )}
      {manages && s.updateError && <Alert>{skillUpdateErrorText(t, s.updateError)}</Alert>}

      <dl className="sk-strip">
        <div>
          <dt>{t("skills.one.who")}</dt>
          <dd>
            {agentIds.length > 0 ? (
              <>
                <SkillFaces ids={agentIds} nameOf={nameOf} max={4} />
                <span className="sk-strip__names">{joinNames(agentIds.map(nameOf), t)}</span>
              </>
            ) : (
              <span className="muted">{t("skills.one.nobody")}</span>
            )}
            {(manages || can(org, "manage_agents")) && (
              <button type="button" className="ac-link" onClick={() => setWho(agentIds)}>
                {t("skills.one.change")}
              </button>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("skills.one.week")}</dt>
          <dd>
            {weekUses > 0 ? (
              t("skills.one.times", { count: weekUses })
            ) : (
              <span className="muted">{t("skills.one.notUsed")}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("skills.one.lastChange")}</dt>
          <dd>
            {lastChange ? (
              lastChange.kind === "link" ? (
                t("skills.one.byLink", { when: when(lastChange.at) })
              ) : (
                `${byName(lastChange) || t("skills.one.someone")}, ${when(lastChange.at)}`
              )
            ) : (
              <span className="muted">{t("skills.one.never")}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("skills.one.from")}</dt>
          <dd>{originText}</dd>
        </div>
      </dl>

      <div className="sk-one__grid">
        <div className="sk-one__doc">
          <h2>{t("skills.one.how")}</h2>
          {editing ? (
            <EditSkill
              skill={s}
              onDone={() => {
                setEditing(false);
                void skill.refetch();
              }}
            />
          ) : (
            <div className="sk-one__body">
              <Markdown source={s.body} />
            </div>
          )}
          {!editing && files.length > 0 && (
            <p className="sk-files">
              <span className="muted">{t("skills.one.alsoUses")}</span>
              {files.slice(0, FILES_NAMED).map((f) => (
                <span key={f.path} className="sk-files__one ac-iconline">
                  <Icon
                    name={f.status === "script" ? "code" : f.mime.startsWith("image/") ? "image" : "file"}
                    size={14}
                  />
                  <span>{f.path}</span>
                </span>
              ))}
              {files.length > FILES_NAMED && (
                <span className="muted">{t("skills.moreFiles", { count: files.length - FILES_NAMED })}</span>
              )}
            </p>
          )}
          {manages && !editing && (
            <form
              className="sk-askbox"
              onSubmit={(e) => {
                e.preventDefault();
                askChange();
              }}
            >
              <label htmlFor="sk-ask" className="sk-askbox__label">
                {t("skills.one.ask")}
              </label>
              <span className="sk-ask">
                <Input
                  id="sk-ask"
                  value={ask}
                  onChange={(e) => setAsk(e.target.value)}
                  placeholder={t("skills.one.askPlaceholder")}
                  disabled={rewrite.isPending}
                />
                <Button type="submit" disabled={!ask.trim() || rewrite.isPending} loading={rewrite.isPending}>
                  {t("skills.one.askSend")}
                </Button>
              </span>
              {askError ? (
                <Alert>{askError}</Alert>
              ) : (
                <small className="muted">
                  {agentIds.length > 0
                    ? t("skills.one.askHelp", {
                        agents: joinNames(agentIds.slice(0, 2).map(nameOf), t),
                        count: Math.min(agentIds.length, 2),
                      })
                    : t("skills.one.askHelpNobody")}
                </small>
              )}
            </form>
          )}
        </div>
        <aside className="sk-one__side">
          <section aria-labelledby="sk-uses">
            <h2 id="sk-uses">{t("skills.one.lastTimes")}</h2>
            {uses.length > 0 ? (
              <ul className="sk-lines">{uses.map(useLine)}</ul>
            ) : (
              <p className="small muted">{t("skills.one.noUses")}</p>
            )}
          </section>
          <section aria-labelledby="sk-changes">
            <h2 id="sk-changes">{t("skills.one.changes")}</h2>
            {history.length > 0 ? (
              <ul className="sk-lines">
                {history.map((e) => (
                  <li key={e.id} className="sk-line ac-iconline" data-undone={e.undone || undefined}>
                    {byFace(e)}
                    <span className="sk-line__text">
                      <b>{eventText(e)}</b>
                      <small>
                        {when(e.at)}
                        {e.undone && <> · {t("skills.history.undone")}</>}
                        {e.before !== null && e.after !== null && e.before !== e.after && (
                          <button
                            type="button"
                            className="ac-link"
                            onClick={() => setOpen(open === e.id ? null : e.id)}
                          >
                            {open === e.id ? t("skills.history.hide") : t("skills.history.show")}
                          </button>
                        )}
                        {e.undoable && manages && (
                          <button type="button" className="ac-link" onClick={undo}>
                            {t("skills.undo")}
                          </button>
                        )}
                      </small>
                      {open === e.id && e.before !== null && e.after !== null && (
                        <ProseDiff label={eventText(e)} lines={diffLines(e.before.split("\n"), e.after.split("\n"))} />
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">{t("skills.one.noChanges")}</p>
            )}
          </section>
        </aside>
      </div>

      {who && (
        <Dialog
          open
          onOpenChange={(o) => !o && !savingWho && setWho(null)}
          title={t("skills.agents.dialogTitle", { name: title })}
          description={t("skills.agents.dialogText")}
          closeLabel={t("common.close")}
          width={480}
        >
          <Locked when={savingWho}>
            <DialogBody>
              <AgentSwitches value={who} onChange={setWho} />
            </DialogBody>
          </Locked>
          <DialogFooter>
            <Button disabled={savingWho} onClick={() => setWho(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" loading={savingWho} disabled={savingWho} onClick={() => void saveWho(who)}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
      {naming !== null && (
        <Dialog
          open
          onOpenChange={(o) => !o && setNaming(null)}
          title={t("skills.one.rename")}
          closeLabel={t("common.close")}
          width={440}
        >
          <form
            style={{ display: "contents" }}
            onSubmit={(e) => {
              e.preventDefault();
              action.mutate(
                { type: "update", id: s.id, patch: { title: naming.trim() } },
                {
                  onSuccess: () => {
                    setNaming(null);
                    void skill.refetch();
                  },
                },
              );
            }}
          >
            <DialogBody>
              <Field label={t("skills.one.name")} id="sk-rename" example={t("skills.one.nameHelp", { name: s.name })}>
                <Input value={naming} onChange={(e) => setNaming(e.target.value)} maxLength={60} />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button type="button" onClick={() => setNaming(null)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="primary" loading={action.isPending}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      )}
      <Dialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("skills.removeTitle", { name: title })}
        description={skillRemovalText(
          t,
          agentIds.map((a) => ({ name: nameOf(a) })),
        )}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setRemoving(false)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            disabled={action.isPending}
            loading={action.isPending && action.variables?.type === "remove"}
            onClick={() =>
              action.mutate(
                { type: "remove", id: s.id },
                {
                  onSuccess: () => {
                    toast.show(t("skills.removed", { name: title }));
                    void navigate({ to: "/org/$orgId/skills", params: { orgId: org.id } });
                  },
                },
              )
            }
          >
            {t("skills.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
