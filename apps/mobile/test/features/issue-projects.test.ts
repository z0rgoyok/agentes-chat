import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueProject } from "@agenteschat/client";
import {
  liveProjectFilter,
  NO_PROJECT,
  pickableProjects,
  projectFilterRows,
} from "@agenteschat/client/lib/issue-projects";
import { bodyTones } from "@agenteschat/ui/agent/engine";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features/issues", path), "utf8");

const project = (n: number, name: string, archived = false): IssueProject => ({
  id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
  name,
  color: ["indigo", "violet", "rose", "amber", "green", "teal", "graphite"][n % 7] ?? "graphite",
  archived,
  open: n,
});
/** Twenty, one with the longest name a project takes, one archived. */
const LONG = "Reestruturação do atendimento ".repeat(4).slice(0, 80);
const projects = [
  ...Array.from({ length: 19 }, (_, k) => project(k + 1, k === 6 ? LONG : `Cliente ${k + 1}`)),
  project(20, "Acme 2025", true),
];

describe("Tarefas' projects on the phone", () => {
  test("the filter's pushed picker: every task, the nineteen in use, the tasks with none, the archived one last", () => {
    const rows = projectFilterRows(projects);
    expect(rows).toHaveLength(21);
    expect(rows.at(-2)).toBeNull();
    expect(rows.at(-1)?.name).toBe("Acme 2025");
    // The chip pushes the task picker (screens, never a list opened in place), which lists them in that order.
    const screen = src("IssuesScreen.tsx");
    expect(screen).toContain('openTaskPick({ what: "projectFilter", value: shown, apply: setFilter });');
    expect(screen).toContain('router.push("/issues/pick");');
    const pick = src("TaskPickScreen.tsx");
    expect(pick).toContain('{ key: "", label: t("issues.projects.all")');
    expect(pick).toContain("...projectFilterRows(projects).map(");
    expect(pick).toContain('...(p.archived ? { sub: t("issues.projects.archivedMark") } : {}),');
    // No project in the workspace: no chip, the screen as it was.
    expect(screen).toContain("{projects.length > 0 ? (");
  });

  test("a deleted project's filter falls back to every task; none and an archived one stay", () => {
    expect(liveProjectFilter(projects, projects[19]?.id ?? "")).toBe(projects[19]?.id ?? "");
    expect(liveProjectFilter(projects, NO_PROJECT)).toBe(NO_PROJECT);
    expect(liveProjectFilter(projects, "00000000-0000-7000-8000-000000000099")).toBe("");
    expect(src("IssuesScreen.tsx")).toContain("const shown = liveProjectFilter(projects, filter);");
  });

  test("both views ask the server for the project's tasks, and say each task's project only among every task", () => {
    const screen = src("IssuesScreen.tsx");
    // Asked once for both views, so the header and its pull to refresh are one.
    expect(screen.match(/useIssues\(orgId, "", shown\)/g)).toHaveLength(1);
    expect(screen).toMatch(/<BoardCard\s+issue=\{i\}\s+live=\{card <= LIVE_CARDS\}\s+project=\{project === ""\}/);
    expect(screen).toContain('{project && i.project ? <ProjectName project={i.project} variant="small" /> : null}');
    expect(src("parts.tsx")).toContain("{project && i.project ? <ProjectName project={i.project} /> : null}");
    // A long name wraps inside the card's line, its dot on the first line: never cut.
    const name = src("parts.tsx").split("export function ProjectName")[1]?.split("\n}\n")[0] ?? "";
    expect(name).toContain("styles.wraps");
    expect(name).toContain("style={styles.shrink}");
    expect(name).not.toContain("numberOfLines");
  });

  test("a new task from a project's tasks starts in it, from an archived one or the tasks with none it doesn't", () => {
    const screen = src("IssuesScreen.tsx");
    expect(screen).toContain("project && !project.archived");
    expect(screen).toContain("params: { project: project.id }");
    expect(screen).toContain("project && project !== NO_PROJECT ? { project } : {}");
    const form = src("NewIssueForm.tsx");
    expect(form).toContain("useState<string | null>(fromProject ?? null)");
    expect(form).toContain("...(project ? { projectId: project.id } : {}),");
    // The form offers the ones in use, then none, on the pushed picker. With no project in the workspace the row isn't
    // there.
    expect(pickableProjects(projects)).toHaveLength(19);
    expect(form).toContain("{projects.length > 0 ? (");
    expect(form).toContain('pickOn({ what: "project", value: project, apply: setProjectId })');
    expect(src("TaskPickScreen.tsx")).toContain("key: NO_PROJECT,");
  });

  test("the task's strip starts with Projeto, and its picker still names the task's own archived project", () => {
    const task = src("IssueScreen.tsx");
    const strip = task.split("<View style={styles.chips}>")[1] ?? "";
    expect(strip.indexOf('label={t("issues.projects.label")}')).toBeGreaterThan(-1);
    expect(strip.indexOf('label={t("issues.projects.label")}')).toBeLessThan(
      strip.indexOf('label={t("issues.column")}'),
    );
    expect(task).toContain('value={i.project?.name ?? t("issues.projects.none")}');
    expect(task).toContain("patch: { projectId } }");
    expect(pickableProjects(projects, projects[19]).at(-1)?.name).toBe("Acme 2025");
    expect(task).toContain('what: "project",');
    expect(src("TaskPickScreen.tsx")).toContain("...pickableProjects(projects, pick.value).map((p) => ({");
  });

  test("a project's dot is its colour's middle tone, as on the web, and a hollow ring for none", () => {
    for (const p of projects) expect(bodyTones(p.color)[2]).toMatch(/^#[0-9a-f]{6}$/i);
    const parts = src("parts.tsx");
    expect(parts).toContain("bodyTones(color)[2]");
    expect(parts).toContain("{ borderWidth: 1.5, borderColor: c.faint }");
  });
});
