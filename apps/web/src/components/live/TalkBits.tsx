import type {
  Artifact,
  ArtifactAuthor,
  ArtifactDetail,
  FileConversationRoot,
  LiveKind,
  LiveRef,
  LiveSelection,
  ThreadInfo,
} from "@agenteschat/client";
import { fileConversationOf, useArtifact, useThreadMessages } from "@agenteschat/client";
import { KIND_ICON } from "@agenteschat/client/lib/artifacts";
import { artifactPlace } from "@agenteschat/client/lib/drive";
import { joinNames } from "@agenteschat/client/lib/format";
import type { OpenTarget } from "@agenteschat/client/lib/notifications";
import { Icon } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { TYPED_VALUES } from "@/i18n";
import { openLivePage } from "./open";
import { aboutParts, aboutWords, revealOnOpen, useFileTalk } from "./talk";
import "./talk.css";

/*
 * The pieces of a live file's conversation that the chat draws (ADR 0199): the quote over the composer, the line over
 * a message about part of a file, and where the file was made. Light on purpose: every conversation loads them.
 */

/** "Sobre C2:D6 em Custos" over the composer, as "Respondendo a" looks; × drops it. */
export function LiveQuoteBar({
  kind,
  selection,
  onDrop,
}: {
  kind: LiveKind;
  selection: LiveSelection;
  onDrop: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="composer-quote lf-quote" role="note">
      <Icon name={KIND_ICON[kind]} size={16} />
      <span className="composer-quote__who">{aboutWords(t, kind, selection)}</span>
      <button type="button" className="composer-reply__close" aria-label={t("live.conversation.drop")} onClick={onDrop}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/**
 * The line over a message about part of a file (`meta.liveRef`), where "Respondendo a" goes: the kind's icon, what in
 * bold, where quietly. A click selects it in the file open beside the conversation, or opens the file there.
 */
export function LiveRefLine({ liveRef }: { liveRef: LiveRef }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const talk = useFileTalk();
  const { what, where } = aboutParts(t, liveRef);
  const open = () => {
    if (talk?.artifactId === liveRef.artifactId) {
      if (liveRef.selection) talk.reveal(liveRef.selection);
      return;
    }
    if (liveRef.selection) revealOnOpen(liveRef.artifactId, liveRef.selection);
    openLivePage(navigate, org.id, liveRef.artifactId);
  };
  return (
    <button
      type="button"
      className="msg-quote lf-about"
      aria-label={t("live.conversation.aboutLine", { what, where })}
      onClick={open}
    >
      <Icon name={KIND_ICON[liveRef.kind]} size={14} />
      <span className="msg-quote__who" aria-hidden="true">
        {what}
      </span>
      <span className="msg-quote__excerpt" aria-hidden="true">
        {where}
      </span>
    </button>
  );
}

/** Where a file was made: by whom, and the conversation (a link while this person can open it). */
export interface MadeFrom {
  by: ArtifactAuthor;
  name: string;
  /** "conversa com Ana", "conversa no #eng"; null: made in the Drive. */
  place: string | null;
  link: OpenTarget | null;
  /** The uploaded file a document was opened from ("Plano.docx", ADR 0200); null for anything made here. */
  imported: string | null;
}

/** The upload a document came from (its preview says, ADR 0200), when the artifact at hand carries its content. */
function importedFrom(artifact: Artifact): string | null {
  const content = (artifact as Partial<ArtifactDetail>).content;
  return content?.kind === "document" ? (content.preview?.source?.name ?? null) : null;
}

export function useMadeFrom(artifact: Artifact | null | undefined): MadeFrom | null {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  if (!artifact) return null;
  const by = artifact.createdBy;
  const name = dir.authorName(by);
  const aud = artifact.audience;
  let place: string | null = null;
  if (artifact.channelId) {
    if (aud.kind === "channel") place = t("live.shell.meta.inChannel", { channel: aud.name });
    else if (aud.kind === "dm") {
      if (aud.between?.length) {
        place = t("live.shell.meta.between", { names: joinNames(aud.between.map(dir.authorName), t) });
      } else {
        // The DM's other side as its maker sees it: the agent made it in the DM with me, so it's my conversation.
        const other: ArtifactAuthor | null =
          aud.with && (aud.with.type !== by.type || aud.with.id !== by.id)
            ? aud.with
            : { type: "person", id: me.user.id };
        place = t("live.shell.meta.with", { name: dir.authorName(other) });
      }
    } else place = t("live.shell.meta.inConversation");
  }
  return { by, name, place, link: place ? artifactPlace(artifact) : null, imported: importedFrom(artifact) };
}

/** A link to a conversation (`OpenTarget`), in the house link style; its words come from `Trans`. */
function PlaceLink({ target, children }: { target: OpenTarget; children?: ReactNode }) {
  const { org } = useOrg();
  return (
    <Link
      to={target.to as never}
      params={{ orgId: org.id, ...("params" in target ? target.params : {}) } as never}
      search={(("search" in target && target.search) || {}) as never}
      className="ac-link"
    >
      {children}
    </Link>
  );
}

/**
 * "<b>Atlas</b> criou a partir da <a>conversa com Ana</a>", or "<b>Walter</b> imported it from <b>Plano.docx</b>": the
 * meta row's and the origin line's words.
 */
function MadeWords({
  made,
  i18nKey,
  plainKey,
  importedKey,
  what,
}: {
  made: MadeFrom;
  i18nKey: string;
  plainKey: string;
  importedKey: string;
  what?: string;
}) {
  const place: ReactNode = made.link ? <PlaceLink target={made.link} /> : <span />;
  if (made.imported) {
    return (
      <Trans
        i18nKey={importedKey as never}
        values={{ name: made.name, file: made.imported }}
        components={[<b key="name" />, <b key="file" />]}
        {...TYPED_VALUES}
      />
    );
  }
  return made.place ? (
    <Trans
      i18nKey={i18nKey as never}
      values={{ name: made.name, place: made.place, what }}
      components={[<b key="b" />, place]}
      {...TYPED_VALUES}
    />
  ) : (
    <Trans
      i18nKey={plainKey as never}
      values={{ name: made.name, what }}
      components={[<b key="b" />]}
      {...TYPED_VALUES}
    />
  );
}

/** The meta row's maker: "Atlas criou a partir da conversa com Ana". */
export function MadeFromWords({ made }: { made: MadeFrom }) {
  return (
    <MadeWords
      made={made}
      i18nKey="live.shell.meta.madeFrom"
      plainKey="live.shell.meta.made"
      importedKey="live.shell.meta.imported"
    />
  );
}

/**
 * At the top of a file's conversation (`chrome.top`): "Atlas criou este quadro a partir da conversa com Ana", the
 * task's "a partir de uma mensagem no #eng"; a document opened from a Word file: "Imported from Plano.docx by Walter".
 */
export function FileOrigin({ artifactId, kind }: { artifactId: string; kind: LiveKind }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const artifact = useArtifact(org.id, artifactId).data;
  const made = useMadeFrom(artifact);
  if (!made) return null;
  return (
    <p className="lf-origin ac-iconline">
      <Icon name="link" size={14} />
      <span>
        <MadeWords
          made={made}
          i18nKey="live.conversation.origin.from"
          plainKey="live.conversation.origin.made"
          importedKey="live.conversation.origin.imported"
          what={t(`live.conversation.this.${kind}` as "live.conversation.this.canvas")}
        />
      </span>
    </p>
  );
}

/** Whether a thread is a live file's conversation (its own channel, ADR 0199). */
export const isFileThread = (thread: Pick<ThreadInfo, "channelKind"> | null | undefined) =>
  String(thread?.channelKind ?? "") === "file";

/**
 * The file a conversation stands for (ADR 0199): the file open beside it, else what its root says. Null for any
 * other thread, and while a file's root is still on its way.
 */
export function useFileThread(thread: ThreadInfo | undefined): FileConversationRoot | null {
  const { org } = useOrg();
  const talk = useFileTalk();
  const file = isFileThread(thread);
  const own = Boolean(thread && talk?.rootId === thread.id);
  const messages = useThreadMessages(org.id, file && !own ? thread?.channelId : undefined, thread?.id ?? "");
  if (!thread || !file) return null;
  if (talk && own) return { artifactId: talk.artifactId, kind: talk.kind, title: talk.title };
  return fileConversationOf(messages.data?.find((m) => m.id === thread.id)?.meta);
}
