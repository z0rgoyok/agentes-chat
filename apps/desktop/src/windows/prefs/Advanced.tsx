import { TASK_LIMIT_BOUNDS } from "@agenteschat/adapters/machine-protocol";
import type { ControlConfig, ControlConfigPatch } from "@agenteschat/adapters/runner-control";
import { Button, Segmented } from "@agenteschat/ui";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../../app";
import type { Platform } from "../../control/platform";
import { orgName, pairedHomes } from "../../control/store";
import { OrgTile, Stepper } from "../../ui/bits";
import { CardTitle, hintFor, PrefCard, PrefHead, PrefRow } from "../../ui/settings";
import { useToast } from "../../ui/Toast";
import { shortPath } from "../../ui/time";

/**
 * The runner's defaults (the same numbers `agentes-runner`'s `DEFAULT_LIMITS` uses when the config has none): on
 * Linux, where free memory decides room for a turn, more conversations stay open, and longer. Its
 * task limit is sized to the computer: `config.get` says it (`defaultMaxConcurrentTasks`), 3 from an older runner.
 */
export const defaultLimits = (
  platform: Platform,
  maxConcurrentTasks = 3,
): Required<Omit<ControlConfigPatch, "name">> => ({
  maxConcurrentTasks,
  taskMaxSeconds: 4 * 3600,
  brainMaxProcesses: platform === "linux" ? 8 : 1,
  brainIdleMinutes: platform === "linux" ? 60 : 30,
});

type Limit = keyof ReturnType<typeof defaultLimits>;

const TASK_MAX = ["3600", "14400", "28800"] as const;
const idleChoices = (platform: Platform) => (platform === "linux" ? ["10", "20", "30", "60"] : ["3", "5", "10", "30"]);

export function Advanced() {
  const { t } = useTranslation();
  const host = useHost();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const homes = pairedHomes(snap);
  const ids = homes.map((h) => h.homeId).join(" ");
  // Each workspace's own limits, in `homes` order (null: it didn't answer).
  const [configs, setConfigs] = useState<(ControlConfig | null)[]>([]);

  const load = useCallback(
    () =>
      Promise.all(
        ids
          .split(" ")
          .filter(Boolean)
          .map((id) => store.request(id, { type: "config.get" }).catch(() => null)),
      ),
    [store, ids],
  );
  useEffect(() => {
    let live = true;
    void load().then((c) => live && setConfigs(c));
    return () => {
      live = false;
    };
  }, [load]);

  const config = configs.find(Boolean) ?? null;
  const defaults = defaultLimits(host.platform, config?.defaultMaxConcurrentTasks);
  const idle = idleChoices(host.platform);
  const limits = { ...defaults, ...(config ?? {}) };
  const limitsOf = (c: ControlConfig) => ({ ...defaultLimits(host.platform, c.defaultMaxConcurrentTasks), ...c });
  const label = (key: Limit, v: number) =>
    key === "taskMaxSeconds"
      ? t("desktop.common.hours", { count: v / 3600 })
      : key === "brainIdleMinutes"
        ? t("desktop.common.minutes", { count: v })
        : String(v);
  /** One control sets every workspace: where they differ now, the row says each one's number. */
  const mixed = (key: Limit) => {
    const each = homes.flatMap((h, i) => {
      const c = configs[i];
      return c ? [{ name: orgName(h), value: limitsOf(c)[key] }] : [];
    });
    if (new Set(each.map((e) => e.value)).size < 2) return undefined;
    const values = each.map((e) => `${e.name} ${label(key, e.value)}`).join(", ");
    return t("desktop.prefs.advanced.mixed", { values });
  };

  // Limits apply to each organization: the same numbers go to every one. Read back after, so a workspace the change
  // didn't reach shows its own number.
  const change = async (patch: ControlConfigPatch, done?: string) => {
    setConfigs((all) => all.map((c) => (c ? { ...c, ...patch } : c)));
    try {
      await store.requestAll({ type: "config.set", patch });
      if (done) toast(done);
    } catch {
      toast(t("desktop.common.error"), "alert");
      setConfigs(await load());
    }
  };

  const disabled = homes.length === 0;
  return (
    <>
      <PrefHead
        title={t("desktop.prefs.advanced.title")}
        lead={t("desktop.prefs.advanced.lead")}
        action={
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => void change(defaults, t("desktop.prefs.advanced.defaultsDone"))}
          >
            {t("desktop.prefs.advanced.defaults")}
          </Button>
        }
      />

      <CardTitle>{t("desktop.prefs.advanced.longJobs")}</CardTitle>
      <PrefCard>
        {/* Where tasks start on the computer's room, a count would be a setting that changes nothing. */}
        {!config?.tasksOnRoom && (
          <PrefRow
            title={t("desktop.prefs.advanced.concurrent")}
            hint={hintFor(t, t("desktop.prefs.advanced.concurrent"), t("desktop.prefs.advanced.concurrentDesc"))}
            desc={mixed("maxConcurrentTasks")}
            end={
              <Stepper
                label={t("desktop.prefs.advanced.concurrent")}
                value={limits.maxConcurrentTasks}
                min={TASK_LIMIT_BOUNDS[0]}
                max={TASK_LIMIT_BOUNDS[1]}
                onChange={(v) => void change({ maxConcurrentTasks: v })}
              />
            }
          />
        )}
        <PrefRow
          title={t("desktop.prefs.advanced.maxTime")}
          hint={hintFor(t, t("desktop.prefs.advanced.maxTime"), t("desktop.prefs.advanced.maxTimeDesc"))}
          desc={mixed("taskMaxSeconds")}
          end={
            <Segmented
              size="sm"
              label={t("desktop.prefs.advanced.maxTime")}
              value={
                (TASK_MAX as readonly string[]).includes(String(limits.taskMaxSeconds))
                  ? String(limits.taskMaxSeconds)
                  : ""
              }
              onValueChange={(v) => void change({ taskMaxSeconds: Number(v) })}
              options={TASK_MAX.map((s) => ({
                value: s as string,
                label: t("desktop.common.hours", { count: Number(s) / 3600 }),
              }))}
            />
          }
        />
      </PrefCard>

      <CardTitle>{t("desktop.prefs.advanced.claude")}</CardTitle>
      <PrefCard>
        <PrefRow
          title={t("desktop.prefs.advanced.brainMax")}
          hint={hintFor(t, t("desktop.prefs.advanced.brainMax"), t("desktop.prefs.advanced.brainMaxDesc"))}
          desc={mixed("brainMaxProcesses")}
          end={
            <Stepper
              label={t("desktop.prefs.advanced.brainMax")}
              value={limits.brainMaxProcesses}
              min={1}
              max={8}
              onChange={(v) => void change({ brainMaxProcesses: v })}
            />
          }
        />
        <PrefRow
          title={t("desktop.prefs.advanced.brainIdle")}
          desc={mixed("brainIdleMinutes")}
          end={
            <Segmented
              size="sm"
              label={t("desktop.prefs.advanced.brainIdle")}
              value={idle.includes(String(limits.brainIdleMinutes)) ? String(limits.brainIdleMinutes) : ""}
              onValueChange={(v) => void change({ brainIdleMinutes: Number(v) })}
              options={idle.map((m) => ({
                value: m,
                label: t("desktop.common.minutes", { count: Number(m) }),
              }))}
            />
          }
        />
      </PrefCard>

      <CardTitle hint={hintFor(t, t("desktop.prefs.advanced.folder"), t("desktop.prefs.advanced.folderDesc"))}>
        {t("desktop.prefs.advanced.folder")}
      </CardTitle>
      <PrefCard>
        {homes.map((h) => (
          <PrefRow
            key={h.homeId}
            lead={<OrgTile logo={h.logo} size="md" />}
            title={orgName(h)}
            desc={h.status?.workspace && <span className="dk-path">{shortPath(h.status.workspace)}</span>}
            end={
              h.status?.workspace ? (
                <Button size="sm" variant="ghost" onClick={() => void host.revealFolder(h.status?.workspace ?? "")}>
                  {t("desktop.common.open")}
                </Button>
              ) : undefined
            }
          />
        ))}
      </PrefCard>
    </>
  );
}
