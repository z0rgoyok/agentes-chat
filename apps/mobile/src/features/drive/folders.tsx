import { type Artifact, type DriveFolder, keys, useApi, useDriveArrange, useDriveFolders } from "@agenteschat/client";
import { folderAndInside, folderOutline } from "@agenteschat/client/lib/drive";
import { errorText } from "@agenteschat/client/lib/errors";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { GroupedList, GroupedRow, SCREEN_X, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { shareFile } from "../files/source";
import { useOrgId } from "../shared/hooks";
import { pickOne, showActionSheet } from "../shared/PickerSheet";
import { PromptForm } from "../shared/PromptForm";
import { useSheet } from "../shared/SheetHost";

/** The top level, as a pick (a key can't be null). */
const TOP = "top";

/** A folder's own screen: pushed, so the system's back goes up the path. */
export const openFolder = (id: string) => router.push({ pathname: "/drive", params: { folder: id } });

/** A step of the path: back to that screen when it is in the stack, else to it. */
const goTo = (id: string | null) =>
  router.dismissTo(id ? { pathname: "/drive", params: { folder: id } } : { pathname: "/drive" });

/**
 * The phone's Drive arranging, as the web's: make and rename folders, move files and folders (a picker of the
 * folders as a tree), delete a folder with what's inside, rename a file. Needs the screen's `SheetHostProvider`.
 */
export function useFolderActions() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const sheet = useSheet();
  const toast = useToast();
  const api = useApi();
  const qc = useQueryClient();
  const folders = useDriveFolders(orgId);
  const arrange = useDriveArrange(orgId);
  const all = folders.data ?? [];
  const failed = (e: unknown) => toast({ title: errorText(t, e), icon: "x" });

  const askName = (title: string, initial: string, submitLabel: string, save: (name: string) => Promise<unknown>) =>
    sheet.open(
      <PromptForm
        title={title}
        placeholder={t("drive.name")}
        submitLabel={submitLabel}
        initial={initial}
        onSubmit={async (name) => {
          try {
            await save(name);
            sheet.close();
          } catch (e) {
            failed(e);
          }
        }}
      />,
    );

  /** Where to: the top level, then every folder as a tree (a guide line per level), but the ones being moved. */
  const pickPlace = async (count: number, from: string | null, movingFolder?: string) => {
    const blocked = movingFolder ? folderAndInside(all, movingFolder) : new Set<string>();
    const key = await pickOne({
      title: t("drive.moveTitle", { count }),
      value: from ?? TOP,
      options: [
        { key: TOP, label: t("drive.title"), leading: { kind: "icon", name: "drive" } },
        ...folderOutline(all)
          .filter(({ folder }) => !blocked.has(folder.id))
          .map(({ folder, depth }) => ({
            key: folder.id,
            label: folder.name,
            depth: depth + 1,
            leading: { kind: "icon" as const, name: "drive" as const },
          })),
      ],
    });
    return key === null ? undefined : key === TOP ? null : key;
  };

  const nameOf = (id: string | null) => (id ? (all.find((f) => f.id === id)?.name ?? "") : t("drive.title"));

  const moveFile = async (a: Artifact) => {
    const to = await pickPlace(1, a.folderId ?? null);
    if (to === undefined || to === (a.folderId ?? null)) return;
    try {
      await arrange.move.mutateAsync({ ids: [a.id], folderId: to });
      toast({ title: t("drive.moved", { count: 1, name: nameOf(to) }), icon: "check" });
    } catch (e) {
      failed(e);
    }
  };

  const moveFolder = async (f: DriveFolder) => {
    const to = await pickPlace(1, f.parentId, f.id);
    if (to === undefined || to === f.parentId) return;
    try {
      await arrange.updateFolder.mutateAsync({ id: f.id, parentId: to });
      toast({ title: t("drive.moved", { count: 1, name: nameOf(to) }), icon: "check" });
    } catch (e) {
      failed(e);
    }
  };

  const deleteFolder = async (f: DriveFolder) => {
    const sure = await pickOne({
      title: t("drive.deleteFolderTitle", { name: f.name }),
      note: t("drive.deleteFolderBody"),
      options: [{ key: "delete", label: t("drive.deleteFolder"), destructive: true }],
    });
    if (sure !== "delete") return;
    try {
      const r = await arrange.deleteFolder.mutateAsync(f.id);
      toast({
        title:
          r.kept > 0
            ? t("drive.folderDeletedKept", { count: r.kept })
            : r.trashed > 0
              ? t("drive.folderDeleted", { count: r.trashed })
              : t("drive.folderDeletedEmpty"),
        icon: "check",
      });
    } catch (e) {
      failed(e);
    }
  };

  const deleteFile = async (a: Artifact) => {
    const sure = await pickOne({
      title: t("artifacts.deleteTitle", { title: a.title }),
      note: t("artifacts.deleteBody"),
      options: [{ key: "delete", label: t("artifacts.deleteConfirm"), destructive: true }],
    });
    if (sure !== "delete") return;
    try {
      await api.artifacts.remove(orgId, a.id);
      void qc.invalidateQueries({ queryKey: keys.artifacts(orgId) });
      toast({ title: t("artifacts.deleted"), icon: "check" });
    } catch (e) {
      failed(e);
    }
  };

  /** Enviar cópia: the system's share sheet with the file (save to Files, other apps), as the file screen's. */
  const sendCopy = async (a: Artifact) => {
    try {
      await shareFile(api, orgId, await api.artifacts.get(orgId, a.id, a.version));
    } catch {
      toast({ title: t("mobile.files.shareFailed"), icon: "x" });
    }
  };

  const renameFile = (a: Artifact) =>
    askName(t("drive.renameFile"), a.title, t("drive.rename"), (title) =>
      arrange.rename.mutateAsync({ id: a.id, title }),
    );

  const folderArrange = (f: DriveFolder) => [
    {
      label: t("drive.rename"),
      icon: "pen" as const,
      onPress: () =>
        askName(t("drive.renameFolder"), f.name, t("drive.rename"), (name) =>
          arrange.updateFolder.mutateAsync({ id: f.id, name }),
        ),
    },
    { label: t("drive.moveToMenu"), icon: "right" as const, onPress: () => void moveFolder(f) },
    { label: t("drive.deleteFolder"), icon: "trash" as const, destructive: true, onPress: () => void deleteFolder(f) },
  ];

  return {
    folders: all,
    loaded: folders.isSuccess,
    newFolder: (parentId: string | null) =>
      askName(t("drive.newFolder"), "", t("drive.create"), (name) =>
        arrange.createFolder.mutateAsync({ name, parentId }),
      ),
    /** A folder's actions: its "…" and its long press. `may`: who adds to the Drive arranges it. */
    folderMenu: (f: DriveFolder, may: boolean) =>
      showActionSheet(f.name, [
        { label: t("drive.openFolder"), icon: "drive", onPress: () => openFolder(f.id) },
        ...(may ? folderArrange(f) : []),
      ]),
    /** A file's long press: the web's right click. Open and send a copy for all; the rest by permission. */
    fileMenu: (a: Artifact, open: () => void, may: boolean) =>
      showActionSheet(a.title, [
        { label: t("artifacts.openFile"), icon: "doc", onPress: open },
        { label: t("mobile.files.sendCopy"), icon: "share", onPress: () => void sendCopy(a) },
        ...(may
          ? [
              { label: t("drive.rename"), icon: "pen" as const, onPress: () => renameFile(a) },
              { label: t("drive.moveToMenu"), icon: "right" as const, onPress: () => void moveFile(a) },
            ]
          : []),
        ...(a.canDelete
          ? [
              {
                label: t("artifacts.delete"),
                icon: "trash" as const,
                destructive: true,
                onPress: () => void deleteFile(a),
              },
            ]
          : []),
      ]),
  };
}

/**
 * The folders of where the person is, each a row that opens it; a long press for its actions, and "…" for them too
 * for who arranges the Drive (`more`).
 */
export function FolderRows({
  folders,
  onMenu,
  more,
}: {
  folders: readonly DriveFolder[];
  onMenu: (f: DriveFolder) => void;
  more: boolean;
}) {
  const { t } = useTranslation();
  if (folders.length === 0) return null;
  return (
    <View style={styles.rows}>
      <GroupedList>
        {folders.map((f) => (
          <GroupedRow
            key={f.id}
            icon="drive"
            label={f.name}
            labelLines={0}
            // One centred line for the folder's tile, its name and its "…" (a long name still wraps): as a wrapping
            // row, the tile and the "…" sat a few points under a one-line name's middle.
            media
            chevron={!more}
            onPress={() => openFolder(f.id)}
            onLongPress={() => onMenu(f)}
            {...(more
              ? {
                  buttons: [
                    { icon: "more" as const, label: t("drive.folderMore", { name: f.name }), onPress: () => onMenu(f) },
                  ],
                }
              : {})}
          />
        ))}
      </GroupedList>
    </View>
  );
}

/** "Drive / Reports / 2026" under a folder's title: each step goes back there. */
export function FolderPath({ trail }: { trail: readonly DriveFolder[] }) {
  const { t } = useTranslation();
  const steps = [
    { id: null as string | null, name: t("drive.title") },
    ...trail.map((f) => ({ id: f.id, name: f.name })),
  ];
  return (
    <View style={styles.path} accessibilityRole="toolbar" accessibilityLabel={t("drive.path")}>
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <View key={s.id ?? TOP} style={styles.step}>
            {i > 0 ? (
              <Text variant="footnote" tone="faint">
                {" / "}
              </Text>
            ) : null}
            {last ? (
              <Text variant="footnote">{s.name}</Text>
            ) : (
              // An 18-point line: 13 above and under reach the 44 a finger needs.
              <Pressable
                accessibilityRole="link"
                hitSlop={{ top: 13, bottom: 13, left: 6, right: 6 }}
                onPress={() => goTo(s.id)}
              >
                <Text variant="footnote" tone="muted">
                  {s.name}
                </Text>
              </Pressable>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // 16 under the chips (their own 4 and these 12); under the folders, the next header's own 24.
  rows: { paddingHorizontal: SCREEN_X, paddingTop: 12 },
  path: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: SCREEN_X, paddingBottom: 10 },
  step: { flexDirection: "row", alignItems: "center" },
});
