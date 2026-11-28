import type { Skill, SkillChoice, SkillDetail, SkillSkipped, SkillVia } from "@agenteschat/client";
import { useCatalog, useConnections, useGitHubRepos, useSkillAction } from "@agenteschat/client";
import { fromConnection } from "@agenteschat/client/lib/connected";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  formatBytes,
  SKILL_ASSET_MB,
  SKILL_TEXT_MB,
  SKILL_ZIP_BYTES,
  SKILL_ZIP_MB,
} from "@agenteschat/client/lib/files";
import { formatPercent } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  githubRepoLink,
  hiddenRepoOf,
  hiddenRepoText,
  pickableCount,
  pickSkills,
  type SkillPendingView,
  type SkillText,
  searchRepos,
  skillPendingViews,
  skillPickOf,
  skillViaText,
  skippedSkillText,
} from "@agenteschat/client/lib/skills";
import {
  Alert,
  Button,
  Checkbox,
  CheckboxPill,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  Diff,
  diffLines,
  Field,
  Icon,
  InfoHint,
  Input,
  ListRow,
  Locked,
  SearchField,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
  useUnsavedInDialog,
} from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectFlow, type FlowState } from "@/components/ConnectFlow";
import { ConnectorIcon } from "@/components/ConnectorIcon";
import { LoadingLine, useStepText } from "@/components/Loading";
import { ForWhom, type OwnerTab } from "@/components/OwnerScope";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useEdited } from "@/hooks/useEdited";
import { useToast } from "@/lib/toast";
import { skillTitle } from "./skills/common";

/** How many skills an agent's picker shows without a search. */
const INLINE = 6;

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function searchSkills(skills: Skill[], query: string, { nameOnly = false } = {}) {
  const q = fold(query.trim());
  return q
    ? skills.filter((s) =>
        fold(nameOnly ? `${s.name} ${skillTitle(s)}` : `${s.name} ${skillTitle(s)} ${s.description}`).includes(q),
      )
    : skills;
}

/** A .zip as base64 (writes are JSON only). */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** GitHub's own mark, as the connector catalog draws it (in ink), for a skill installed from github.com. */
const GITHUB_MARK = { iconUrl: "/connectors/github.svg", brandColor: null };

/** One line led by GitHub's mark: which of the workspace's GitHub connections read a private repository. */
function ViaLine({ children }: { children: string }) {
  return (
    <p className="small muted ac-iconline skill-via">
      <ConnectorIcon def={GITHUB_MARK} label="GitHub" />
      <span>{children}</span>
    </p>
  );
}

type SkillScope = OwnerTab;

/**
 * An agent's skills (its page, Criar agente): the library as pills, with a search past INLINE. The search matches
 * names only, since a pill shows nothing else, and only hides pills: a skill switched on stays on while hidden. A
 * personal skill shows a lock; someone else's shows only while on, with its person, so who manages agents turns it off.
 */
export function SkillPicker({
  skills,
  selected,
  onChange,
  idPrefix,
}: {
  skills: Skill[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const [q, setQ] = useState("");
  const offered = skills.filter((s) => !s.ownerUserId || s.ownerUserId === me.user.id || selected.has(s.id));
  const searchable = offered.length > INLINE;
  const shown = searchable ? searchSkills(offered, q, { nameOnly: true }) : offered;
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onChange(next);
  };
  return (
    <div className="skill-picker">
      {searchable && (
        <SearchField
          size="sm"
          aria-label={t("skills.search")}
          placeholder={t("skills.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onClear={() => setQ("")}
          clearLabel={t("filters.clearSearch")}
        />
      )}
      {shown.length > 0 ? (
        <div className="newag__pills">
          {shown.map((s) => (
            <CheckboxPill
              key={s.id}
              id={`${idPrefix}-${s.id}`}
              checked={selected.has(s.id)}
              onCheckedChange={(on) => toggle(s.id, on)}
            >
              {s.ownerUserId ? (
                <span className="ac-iconline skill-pill">
                  <Icon name="lock" size={14} />
                  <span>
                    {skillTitle(s)}
                    {s.ownerUserId !== me.user.id && (
                      <span className="muted">
                        {" · "}
                        {t("skills.personal.of", {
                          name: dir.memberById.get(s.ownerUserId)?.name ?? t("channel.unknownPerson"),
                        })}
                      </span>
                    )}
                  </span>
                </span>
              ) : (
                skillTitle(s)
              )}
            </CheckboxPill>
          ))}
        </div>
      ) : (
        <span className="small muted">{t("skills.noResults", { q })}</span>
      )}
    </div>
  );
}

type InstallTab = "github" | "zip" | "write";

/**
 * Where connecting GitHub from Instalar skill comes back to: Skills, with the link to read again. A link too long
 * for the connect flow's `returnTo` (500 characters, a desktop window's `desktop:` before it) comes back to Skills.
 */
const returnHere = (orgId: string, url: string, forAgentId?: string) => {
  const skills = `/org/${orgId}/skills`;
  const back = `${skills}?install=${encodeURIComponent(url)}${forAgentId ? `&agent=${encodeURIComponent(forAgentId)}` : ""}`;
  return back.length <= 490 ? back : skills;
};

/**
 * Instalar skill: a GitHub link, a .zip or written here. A link holding several skills (or a repository picked from
 * the connected GitHub) lists them to pick. A private repository is read on the server through the workspace's
 * GitHub, and the dialog says which connection read it. When none can, it says the repository looks private or
 * missing and offers to connect GitHub (or to ask whoever manages connectors). Once GitHub is connected it reads the
 * link again while the connect flow goes on to what GitHub does and who uses it, as from Conectores (`initialUrl`
 * and `connected` when signing in on GitHub left the page). `forAgentId`: opened from that agent's card, a box (on by
 * default) turns what installs on for it, and only from the card's own link (`initialUrl`): a link typed over it or a
 * repository picked instead goes on for nobody. A pick named like an installed or a removed skill says it replaces it.
 * `scope`: where skills split into the team's and each person's, "Para quem" starts there (Equipe only for who manages
 * agents); absent, the team's library as before.
 */
export function InstallSkillDialog({
  open,
  onOpenChange,
  onInstalled,
  initialUrl,
  initialFile,
  connected = false,
  returnTo,
  forAgentId,
  scope: startScope,
  only,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: (id: string) => void;
  initialUrl?: string;
  /** A .zip sent in a conversation (an agent's card): read on the server from Drive, its skills listed to pick. */
  initialFile?: { id: string; name: string };
  connected?: boolean;
  /** Where signing in on GitHub comes back to, for the link being read; Skills by default. */
  returnTo?: (url: string) => string;
  forAgentId?: string;
  scope?: SkillScope;
  /** One way in alone, without the tabs: a GitHub link or a .zip (the Skills page's own links). */
  only?: "github" | "zip";
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "manage_agents");
  const [scope, setScope] = useState<SkillScope>(startScope ?? "team");
  const personal = startScope !== undefined && scope === "personal";
  const mine = personal ? { personal } : {};
  const toast = useToast();
  const action = useSkillAction(org.id, { silent: true });
  const repos = useGitHubRepos(org.id, open);
  const catalog = useCatalog();
  const connections = useConnections(org.id, open && connected);
  const dir = useDirectory(org.id);
  // Only a live agent the server would turn it on for: not one archived or gone since its card.
  const forName = forAgentId ? dir.agentById.get(forAgentId)?.name : undefined;
  /** "Fica ligada para Ada": on by default, shown (and sent) only while the link is the card's own. */
  const [turnOn, setTurnOn] = useState(true);
  /** A .zip on its way: the share of it sent, from the moment it's read for sending until the server answers. */
  const [sending, setSending] = useState<number | null>(null);
  /** Stops the .zip on its way: Cancel, or the dialog closing. */
  const stop = useRef<AbortController | null>(null);
  const busy = action.isPending || sending !== null;
  const timerStep = useStepText(action.isPending && sending === null, [
    t("skills.installStep.fetching"),
    t("skills.installStep.reading"),
    t("skills.installStep.saving"),
  ]);
  const installStep =
    sending === null
      ? timerStep
      : sending < 1
        ? t("skills.zipSending", { percent: formatPercent(i18n.language, sending * 100) })
        : t("skills.installStep.saving");
  const [tab, setTab] = useState<InstallTab>("github");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const tooBig = file !== null && file.size > SKILL_ZIP_BYTES;
  const [form, setForm] = useState({ name: "", description: "", body: "" });
  const unsaved = useEdited(open, form);
  const [error, setError] = useState<string | null>(null);
  /** A link the workspace's GitHub couldn't read either, and whether GitHub is connected. */
  const [hidden, setHidden] = useState<ReturnType<typeof hiddenRepoOf>>(null);
  /** The skills a link holds when it holds several, those that can't be installed, and the ones picked. */
  const [choices, setChoices] = useState<SkillChoice[] | null>(null);
  const [skipped, setSkipped] = useState<SkillSkipped[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [via, setVia] = useState<SkillVia | null>(null);
  /** The .zip whose skills are listed to pick (sent again with the picks); null: the list, if any, is a link's. */
  const [zipSent, setZipSent] = useState<string | null>(null);
  /** The list is the card's .zip (`initialFile`), read on the server: its picks name it again. */
  const [fileListed, setFileListed] = useState(false);
  /** Out of what was listed: a new link read, a new file, another tab. */
  const unlist = () => {
    setChoices(null);
    setZipSent(null);
    setFileListed(false);
  };
  /** The connected GitHub's repositories in place of the tabs, to read one. */
  const [browsing, setBrowsing] = useState(false);
  /** Connecting GitHub, over the dialog. */
  const [flow, setFlow] = useState<FlowState | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const github = catalog.data?.connectors.find((c) => c.id === "github");
  const githubOk = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+/.test(url.trim());
  const writeOk = form.name.trim() && form.description.trim() && form.body.trim();
  const done = (skill: unknown) => {
    const s = skill as SkillDetail;
    toast.show(t("skills.installed", { name: s.name }));
    onOpenChange(false);
    onInstalled(s.id);
  };
  const installedPicked = (installed: unknown) => {
    const list = installed as SkillDetail[];
    if (list.length === 1) return done(list[0]);
    toast.show(t("skills.installedMany", { count: list.length }));
    onOpenChange(false);
  };
  const pick = (paths: string[], on: boolean) => setPicked(pickSkills(picked, paths, on, choices ?? []));
  const cardLink = forAgentId && forName ? initialUrl?.trim() : undefined;
  const forCard = cardLink !== undefined && url.trim() === cardLink;
  /** The card's .zip is the one on the zip tab (no other file picked), and the box for its agent shows. */
  const cardFile = initialFile && !file ? initialFile : undefined;
  const forFileCard = Boolean(cardFile && forAgentId && forName);
  /** Reads the card's .zip on the server and lists its skills to pick (one picked already). */
  const readFile = (fileId: string) => {
    setError(null);
    action.mutate(
      { type: "import", input: { fileId, list: true, ...mine } },
      {
        onSuccess: (result) => {
          const found = skillPickOf(result);
          if (!found) return done(result);
          setChoices(found.choices);
          setSkipped(found.skipped);
          setVia(null);
          setZipSent(null);
          setFileListed(true);
          setPicked(new Set(found.choices.length === 1 ? found.choices.map((c) => c.path) : []));
        },
        onError: (e) => setError(errorText(t, e, i18n.language, { maxMb: SKILL_ZIP_MB })),
      },
    );
  };
  /** The agent what installs from `link` goes on for, when the box shows it and is checked. */
  const sendFor = (link: string) =>
    turnOn && cardLink !== undefined && link.trim() === cardLink ? forAgentId : undefined;
  /** Reads a GitHub link: one skill installs at once, unless `list`; several (or `list`) are listed to pick. */
  const read = (link: string, list = false) => {
    setError(null);
    setHidden(null);
    const forAgent = sendFor(link);
    action.mutate(
      {
        type: "import",
        input: list
          ? { url: link, list, ...mine }
          : { url: link, ...(forAgent ? { forAgentId: forAgent } : {}), ...mine },
      },
      {
        onSuccess: (result) => {
          const found = skillPickOf(result);
          if (!found) return done(result);
          setChoices(found.choices);
          setSkipped(found.skipped);
          setVia(found.via);
          setPicked(new Set());
        },
        onError: (e) => {
          const missing = hiddenRepoOf(e);
          if (missing) setHidden(missing);
          else setError(errorText(t, e));
        },
      },
    );
  };
  // Opening starts afresh, on the link it couldn't read when back from connecting GitHub on its site, read once more
  // to pick (once per opening: development runs effects twice).
  const readAgain = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening only
  useEffect(() => {
    if (!open) {
      readAgain.current = undefined;
      stop.current?.abort();
      return;
    }
    setUrl(initialUrl ?? "");
    if (only) setTab(only);
    setFile(null);
    setSending(null);
    setForm({ name: "", description: "", body: "" });
    setError(null);
    setHidden(null);
    unlist();
    setBrowsing(false);
    setTurnOn(true);
    setScope(startScope ?? "team");
    if (initialUrl && readAgain.current !== initialUrl) {
      readAgain.current = initialUrl;
      read(initialUrl, true);
    }
    if (initialFile && readAgain.current !== initialFile.id) {
      readAgain.current = initialFile.id;
      setTab("zip");
      readFile(initialFile.id);
    }
  }, [open]);
  useEffect(() => () => stop.current?.abort(), []);
  // Signed in on GitHub: its confirmation, as Conectores shows after signing in.
  const resumed = useRef(false);
  useEffect(() => {
    if (!open || !connected || resumed.current || !connections.data || !catalog.data) return;
    resumed.current = true;
    const connection = connections.data.find((c) => c.connector === "github" && !c.revokedAt);
    if (!connection || !can(org, "manage_connectors")) return;
    const item = fromConnection(connection, catalog.data.connectors);
    setFlow({ step: "done", item });
  }, [open, connected, connections.data, catalog.data, org]);
  const submit = async () => {
    setError(null);
    const onError = (e: Error) => setError(errorText(t, e));
    if (tab === "github") {
      if (!githubOk) return setError(t("skills.githubInvalid"));
      if (!choices || zipSent !== null) return read(url.trim());
      if (picked.size === 0) return setError(t("skills.pickMissing"));
      action.mutate(
        {
          type: "importPicked",
          url: url.trim(),
          paths: choices.map((c) => c.path).filter((p) => picked.has(p)),
          forAgentId: sendFor(url),
          ...mine,
        },
        { onSuccess: installedPicked, onError },
      );
    } else if (tab === "zip" && choices && fileListed && cardFile) {
      if (picked.size === 0) return setError(t("skills.pickMissing"));
      action.mutate(
        {
          type: "importPickedFile",
          fileId: cardFile.id,
          paths: choices.map((c) => c.path).filter((p) => picked.has(p)),
          ...(turnOn && forFileCard ? { forAgentId } : {}),
          ...mine,
        },
        { onSuccess: installedPicked, onError },
      );
    } else if (tab === "zip" && !file && cardFile) {
      readFile(cardFile.id);
    } else if (tab === "zip" && choices && zipSent !== null) {
      if (picked.size === 0) return setError(t("skills.pickMissing"));
      const stopper = new AbortController();
      stop.current = stopper;
      setSending(0);
      action.mutate(
        {
          type: "importPickedZip",
          zipBase64: zipSent,
          paths: choices.map((c) => c.path).filter((p) => picked.has(p)),
          ...mine,
          upload: { signal: stopper.signal, onProgress: setSending },
        },
        {
          onSuccess: installedPicked,
          onError: (e) => {
            if (!stopper.signal.aborted) setError(errorText(t, e, i18n.language, { maxMb: SKILL_ZIP_MB }));
          },
          onSettled: () => setSending(null),
        },
      );
    } else if (tab === "zip") {
      if (!file) return setError(t("skills.zipMissing"));
      if (tooBig) return;
      const stopper = new AbortController();
      stop.current = stopper;
      setSending(0);
      let zipBase64: string;
      try {
        zipBase64 = await fileToBase64(file);
      } catch {
        setSending(null);
        return setError(t("common.unknownError"));
      }
      if (stopper.signal.aborted) return setSending(null);
      action.mutate(
        { type: "import", input: { zipBase64, ...mine }, upload: { signal: stopper.signal, onProgress: setSending } },
        {
          // A .zip of several skills lists them to pick, as a link does; it is sent again with the picks.
          onSuccess: (result) => {
            const found = skillPickOf(result);
            if (!found) return done(result);
            setZipSent(zipBase64);
            setChoices(found.choices);
            setSkipped(found.skipped);
            setVia(null);
            setPicked(new Set());
          },
          onError: (e) => {
            if (!stopper.signal.aborted) setError(errorText(t, e, i18n.language, { maxMb: SKILL_ZIP_MB }));
          },
          onSettled: () => setSending(null),
        },
      );
    } else {
      if (!writeOk) return setError(t("skills.writeMissing"));
      action.mutate(
        {
          type: "create",
          input: { name: form.name.trim(), description: form.description.trim(), body: form.body, ...mine },
        },
        { onSuccess: done, onError },
      );
    }
  };
  /** The skills a link or a .zip holds, to pick, and those that can't be installed (`choices` set). */
  const pickList = choices && (
    <fieldset className="skill-picks">
      <legend className="small muted">
        {t(zipSent !== null ? "skills.pickLeadZip" : "skills.pickLead", {
          count: choices.length + skipped.length,
        })}
      </legend>
      <label htmlFor="skill-pick-all" className="scope-row">
        <Checkbox
          id="skill-pick-all"
          checked={picked.size === 0 ? false : picked.size === pickableCount(choices) ? true : "indeterminate"}
          onCheckedChange={(on) =>
            pick(
              choices.map((c) => c.path),
              on,
            )
          }
        />
        <span className="scope-row__text">{t("skills.pickAll")}</span>
      </label>
      {choices.map((c, i) => (
        <label key={c.path} htmlFor={`skill-pick-${i}`} className="scope-row">
          <Checkbox id={`skill-pick-${i}`} checked={picked.has(c.path)} onCheckedChange={(on) => pick([c.path], on)} />
          <span className="scope-row__text">
            <span className="skill-pick__name">{c.name}</span>
            {c.sameName && <span className="small muted skill-pick__about">{c.path}</span>}
            {c.replaces && (
              <span className="small muted skill-pick__about">
                {t(c.replaces === "removed" ? "skills.pickReplacesRemoved" : "skills.pickReplaces", {
                  name: c.name,
                })}
              </span>
            )}
            <span className="small muted skill-pick__about">{c.description}</span>
          </span>
        </label>
      ))}
      {skipped.map((s, i) => (
        <label key={s.path} htmlFor={`skill-skip-${i}`} className="scope-row">
          <Checkbox id={`skill-skip-${i}`} checked={false} disabled />
          <span className="scope-row__text">
            <span className="skill-pick__name">{s.path}</span>
            <span className="small muted skill-pick__about">{skippedSkillText(t, s)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
  const mayConnect = can(org, "manage_connectors") && Boolean(github);
  const said = hidden ? hiddenRepoText(t, hidden, mayConnect) : null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      // Opened for one way in, it is named by the way shown: a .zip too big moves it to a GitHub link.
      title={!only ? t("skills.install") : tab === "zip" ? t("skills.page.fromZip") : t("skills.page.fromLink")}
      closeLabel={t("common.close")}
      unsaved={unsaved}
      className={only ? "sk-install-one" : undefined}
    >
      {browsing ? (
        <ConnectedRepos
          onBack={() => setBrowsing(false)}
          onPick={(fullName) => {
            const link = githubRepoLink(fullName);
            setBrowsing(false);
            setUrl(link);
            setChoices(null);
            read(link, true);
          }}
        />
      ) : (
        <form
          style={{ display: "contents" }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Locked when={busy}>
            <DialogBody>
              <Tabs
                value={tab}
                onValueChange={(v) => {
                  setTab(v);
                  setError(null);
                  setHidden(null);
                  unlist();
                }}
                label={t("skills.installHow")}
                items={[
                  { value: "github", label: t("skills.tab.github") },
                  { value: "zip", label: t("skills.tab.zip") },
                  { value: "write", label: t("skills.tab.write") },
                ]}
              >
                <TabPanel value="github">
                  <Field
                    label={t("skills.githubUrl")}
                    id="skill-url"
                    hint={{ name: t("common.about", { label: t("skills.githubUrl") }), text: t("skills.githubHelp") }}
                  >
                    <Input
                      value={url}
                      onChange={(e) => {
                        setUrl(e.target.value);
                        setChoices(null);
                        setHidden(null);
                      }}
                      placeholder="https://github.com/…"
                      inputMode="url"
                    />
                  </Field>
                  {admin && repos.data?.connected && !choices && (
                    <div className="row">
                      <Button size="sm" onClick={() => setBrowsing(true)}>
                        <ConnectorIcon def={GITHUB_MARK} label="GitHub" />
                        {t("skills.fromConnected")}
                      </Button>
                    </div>
                  )}
                  {said && (
                    <div className="skill-hidden">
                      <Alert tone="neutral">{said.text}</Alert>
                      {said.connect && github && (
                        <div className="row">
                          <Button size="sm" variant="primary" onClick={() => setFlow({ step: 0, def: github })}>
                            <ConnectorIcon def={GITHUB_MARK} label="GitHub" />
                            {t("skills.hidden.connectButton")}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                  {choices && via && <ViaLine>{skillViaText(t, via, url)}</ViaLine>}
                  {choices && zipSent === null && !fileListed && pickList}
                  {forCard && (
                    <label htmlFor="skill-for-agent" className="scope-row">
                      <Checkbox
                        id="skill-for-agent"
                        checked={turnOn}
                        onCheckedChange={(on) => setTurnOn(on === true)}
                      />
                      <span className="scope-row__text">
                        {t("skills.forAgent", { agent: forName, count: Math.max(picked.size, 1) })}
                      </span>
                    </label>
                  )}
                </TabPanel>
                <TabPanel value="zip">
                  <span className="ac-hintline small muted">
                    {t("skills.zipHelp", { max: SKILL_ZIP_MB })}
                    <InfoHint name={t("common.about", { label: t("skills.tab.zip") })}>
                      {t("skills.zipAbout", { text: SKILL_TEXT_MB, assets: SKILL_ASSET_MB })}
                    </InfoHint>
                  </span>
                  {/* Our button over a hidden file input: never the native control look. */}
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".zip,application/zip"
                    className="ac-visually-hidden"
                    aria-label={t("skills.zipPick")}
                    onChange={(e) => {
                      setFile(e.target.files?.[0] ?? null);
                      setError(null);
                      unlist();
                    }}
                  />
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <Button type="button" icon="attach" onClick={() => fileInput.current?.click()}>
                      {t("skills.zipPick")}
                    </Button>
                    <span className="small muted">
                      {file
                        ? `${file.name} · ${formatBytes(i18n.language, file.size)}`
                        : (cardFile?.name ?? t("skills.zipNone"))}
                    </span>
                  </div>
                  {file && tooBig && (
                    <div className="skill-hidden">
                      <Alert>
                        {t("skills.zipTooLarge", {
                          name: file.name,
                          size: formatBytes(i18n.language, file.size),
                          max: SKILL_ZIP_MB,
                        })}
                      </Alert>
                      <div className="row">
                        <Button size="sm" icon="link" onClick={() => setTab("github")}>
                          {t("skills.zipUseLink")}
                        </Button>
                      </div>
                    </div>
                  )}
                  {choices && (zipSent !== null || fileListed) && pickList}
                  {forFileCard && fileListed && (
                    <label htmlFor="skill-zip-for-agent" className="scope-row">
                      <Checkbox
                        id="skill-zip-for-agent"
                        checked={turnOn}
                        onCheckedChange={(on) => setTurnOn(on === true)}
                      />
                      <span className="scope-row__text">
                        {t("skills.forAgent", { agent: forName, count: Math.max(picked.size, 1) })}
                      </span>
                    </label>
                  )}
                </TabPanel>
                <TabPanel value="write">
                  <Field label={t("skills.name")} id="skill-name">
                    <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </Field>
                  <Field
                    label={t("skills.description")}
                    id="skill-desc"
                    hint={{
                      name: t("common.about", { label: t("skills.description") }),
                      text: t("skills.descriptionHelp"),
                    }}
                  >
                    <Input
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                    />
                  </Field>
                  <Field
                    label={t("skills.body")}
                    id="skill-body"
                    hint={{ name: t("common.about", { label: t("skills.body") }), text: t("skills.bodyHelp") }}
                  >
                    <Textarea
                      rows={10}
                      value={form.body}
                      onChange={(e) => setForm({ ...form, body: e.target.value })}
                    />
                  </Field>
                </TabPanel>
              </Tabs>
              {startScope !== undefined && (
                <ForWhom
                  label={t("skills.personal.forWhom")}
                  value={scope}
                  locked={!admin}
                  note={t("skills.personal.teamLocked")}
                  onValueChange={(next) => {
                    setScope(next);
                    setChoices(null);
                  }}
                />
              )}
              {error && <Alert>{error}</Alert>}
            </DialogBody>
          </Locked>
          <DialogFooter note={installStep}>
            <Button type="button" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={busy || (tab === "zip" && tooBig)} loading={busy}>
              {t("skills.installSubmit")}
            </Button>
          </DialogFooter>
        </form>
      )}
      <ConnectFlow
        flow={flow}
        returnTo={returnTo?.(url.trim()) ?? returnHere(org.id, url.trim(), sendFor(url))}
        onChange={(next) => {
          // Connected without leaving the page (a token): the link again, to pick, behind the steps that follow.
          if (flow?.step === 0) read(url.trim(), true);
          setFlow(next);
        }}
        onClose={() => setFlow(null)}
      />
    </Dialog>
  );
}

/**
 * Instalar skill › Escolher do GitHub conectado: the repositories the workspace's GitHub reaches, by account, with a
 * search. Picking one reads it; Voltar goes back to the tabs.
 */
function ConnectedRepos({ onPick, onBack }: { onPick: (fullName: string) => void; onBack: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const listing = useGitHubRepos(org.id);
  const [q, setQ] = useState("");
  const accounts = searchRepos(listing.data, q);
  return (
    <>
      {listing.isLoading ? (
        <div className="ac-dialog__body">
          <LoadingLine width={220} />
        </div>
      ) : listing.isError ? (
        <p className="ac-dialog__empty">{t("repos.unavailable")}</p>
      ) : (
        <DialogSearchList
          query={q}
          onQueryChange={setQ}
          searchLabel={t("repos.search")}
          searchPlaceholder={t("repos.search")}
          listLabel={t("skills.connectedRepos")}
          isEmpty={accounts.length === 0}
          emptyText={q.trim() ? t("repos.noMatch", { q: q.trim() }) : t("repos.none")}
        >
          {accounts.map((a) => (
            <section key={a.login} className="skill-repos" aria-label={a.login}>
              <p className="ac-eyebrow">{a.login}</p>
              {a.repositories.map((r) => (
                <ListRow
                  key={r.fullName}
                  lead={<Icon name={r.private ? "lock" : "globe"} size={16} />}
                  title={r.fullName}
                  meta={r.private ? t("repos.private") : t("repos.public")}
                  onClick={() => onPick(r.fullName)}
                />
              ))}
            </section>
          ))}
          {listing.data?.truncated && <p className="small muted">{t("repos.truncated")}</p>}
        </DialogSearchList>
      )}
      <DialogFooter>
        <Button onClick={onBack}>{t("common.back")}</Button>
      </DialogFooter>
    </>
  );
}

/** A line diff of two texts: what it is for (when it changed) over its SKILL.md; one line when nothing differs. */
export function TextDiff({ before, after }: { before: SkillText; after: SkillText }) {
  const { t } = useTranslation();
  const labels = { addedLabel: t("proposals.added"), removedLabel: t("proposals.removed") };
  const description = before.description !== after.description;
  if (!description && before.body === after.body) return <p className="small muted">{t("skills.diff.same")}</p>;
  return (
    <>
      {description && (
        <Diff
          {...labels}
          aria-label={t("skills.description")}
          lines={diffLines([before.description], [after.description])}
        />
      )}
      {before.body !== after.body && (
        <Diff
          {...labels}
          code
          aria-label={t("skills.body")}
          lines={diffLines(before.body.split("\n"), after.body.split("\n"))}
        />
      )}
    </>
  );
}

/**
 * What the waiting update changes: the ways to read it (`skillPendingViews`) as tabs, then each file that runs, new
 * or changed, with its diff (or why it isn't shown).
 */
export function PendingDiff({ skill: s }: { skill: SkillDetail }) {
  const { t } = useTranslation();
  const views = skillPendingViews(s);
  const [tab, setTab] = useState<SkillPendingView["id"]>(views[0]?.id ?? "link");
  if (!s.pending) return <p className="small muted">{t("skills.diff.unavailable")}</p>;
  const labels = { addedLabel: t("proposals.added"), removedLabel: t("proposals.removed") };
  return (
    <div className="skill-diff">
      {views.length > 1 ? (
        <Tabs
          variant="segmented"
          value={tab}
          onValueChange={setTab}
          label={t("skills.diff.label")}
          items={views.map((v) => ({ value: v.id, label: t(`skills.diff.${v.id}`) }))}
        >
          {views.map((v) => (
            <TabPanel key={v.id} value={v.id}>
              <TextDiff before={v.before} after={v.after} />
            </TabPanel>
          ))}
        </Tabs>
      ) : (
        views[0] && <TextDiff before={views[0].before} after={views[0].after} />
      )}
      {s.pending.files.length > 0 && (
        <>
          <h4 className="ac-eyebrow">{t("skills.diff.files")}</h4>
          {s.pending.files.map((f) => (
            <div key={f.path} className="skill-diff__file">
              <span className="skill-file">
                <code>{f.path}</code>
                <Chip icon="code">
                  {t(f.before === null && !f.large ? "skills.diff.newFile" : "skills.diff.changedFile")}
                </Chip>
              </span>
              {f.large || f.after === null ? (
                <p className="small muted">{t("skills.diff.large")}</p>
              ) : (
                <Diff
                  {...labels}
                  code
                  aria-label={f.path}
                  lines={diffLines(f.before?.split("\n") ?? [], f.after.split("\n"))}
                />
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function EditSkill({ skill, onDone }: { skill: SkillDetail; onDone: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useSkillAction(org.id);
  const [form, setForm] = useState({
    description: skill.description,
    body: skill.body,
    defaultForNewAgents: skill.defaultForNewAgents,
  });
  useUnsavedInDialog(useEdited(true, form));
  return (
    <form
      className="stack-4"
      style={{ gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        action.mutate(
          { type: "update", id: skill.id, patch: form },
          {
            onSuccess: () => {
              toast.show(t("skills.saved", { name: skill.name }));
              onDone();
            },
          },
        );
      }}
    >
      <Locked when={action.isPending}>
        {skill.source === "url" && <Alert tone="neutral">{t("skills.editLinkNote")}</Alert>}
        <Field label={t("skills.description")} id="edit-skill-desc">
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field
          label={t("skills.body")}
          id="edit-skill-body"
          hint={{ name: t("common.about", { label: t("skills.body") }), text: t("skills.newVersion") }}
        >
          <Textarea rows={14} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </Field>
        <span className="row" style={{ gap: 10, alignItems: "center" }}>
          <Switch
            id="edit-skill-default"
            checked={form.defaultForNewAgents}
            onCheckedChange={(on) => setForm({ ...form, defaultForNewAgents: on })}
          />
          <label htmlFor="edit-skill-default">{t("skills.defaultForNew")}</label>
        </span>
      </Locked>
      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <Button type="button" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!form.description.trim() || action.isPending}
          loading={action.isPending}
        >
          {t("skills.save")}
        </Button>
      </div>
    </form>
  );
}
