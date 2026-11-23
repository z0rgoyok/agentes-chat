import { type LiveRoom, useArtifact } from "@agenteschat/client";
import { LOCAL } from "@agenteschat/live";
import { readShapeById, shapeTextFragment, updateShape } from "@agenteschat/live/canvas";
import { editParagraphTexts, type RichDoc } from "@agenteschat/live/rich";
import { deckTheme, elementTextFragment, readSlide, updateElement } from "@agenteschat/live/slides";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import type * as Y from "yjs";
import { SCREEN_X, Text, useTheme, useToast } from "@/ui";
import { goBack } from "@/ui/navigation";
import { errorHaptic, PushedHeader } from "../../shared/parts";
import { TextArea } from "../../shared/TextArea";
import { liveClosed } from "../logic";
import { LiveUnavailable } from "../shared/LiveBar";
import { useLiveDoc } from "../shared/useLiveDoc";
import { editorText, elementFrame, paragraphTexts, partOf, slideScale } from "./logic";
import { useFilePictures } from "./pictures";
import { SlideView } from "./SlideView";

/** What the screen edits: a slide's text box (or a shape's label), or a canvas's note, text or shape. */
export type TextTarget = { slide: string; el: string } | { shape: string };

/**
 * The words of a text box on the phone (ADR 0196 §9), on a screen of their own: the slide drawn small with the box
 * outlined (a canvas's note has no slide), then the box's words in a field over the keyboard, one paragraph a line.
 * Each change goes into the file as it is typed (`editParagraphTexts`: only the paragraphs that changed, keeping their
 * look, so someone typing in another paragraph of the same box merges), and Desfazer takes it back. What others type
 * shows unless the person is in the middle of typing. A box someone deletes meanwhile closes the screen.
 */
export function SlideTextScreen({
  id,
  slide,
  el,
  shape,
}: {
  id: string;
  slide?: string | undefined;
  el?: string | undefined;
  shape?: string | undefined;
}) {
  const { t } = useTranslation();
  // One target for the screen's life (its effects follow it).
  const target = useMemo<TextTarget | null>(
    () => (slide && el ? { slide, el } : shape ? { shape } : null),
    [slide, el, shape],
  );
  const onSlide = !shape;
  const live = useLiveDoc(id, { kind: onSlide ? "slides" : "canvas" });
  const query = useArtifact(live.orgId, id);
  const closed = liveClosed(live);
  const room = live.room;
  const title = onSlide ? t("mobile.live.text.title") : t("mobile.live.text.noteTitle");
  if (closed)
    return (
      <>
        <PushedHeader title={query.data?.title ?? title} />
        <LiveUnavailable reason={closed} />
      </>
    );
  if (!target) return <LiveUnavailable reason="missing" />;
  if (!room || !live.loaded)
    return (
      <>
        <PushedHeader title={title} />
        <TextBones />
      </>
    );
  return <TextEditor room={room} fileId={id} target={target} readOnly={live.mode !== "edit"} />;
}

/** The box's rich text and its words' name, read again whenever the file changes. */
function readTarget(doc: Y.Doc, target: TextTarget) {
  if ("slide" in target) {
    const slide = readSlide(doc, target.slide);
    const el = slide?.elements.find((e) => e.id === target.el) ?? null;
    return el ? { rich: el.text ?? [], part: partOf(el), slide, el } : null;
  }
  const shape = readShapeById(doc, target.shape);
  return shape && (shape.type === "note" || shape.type === "text" || shape.type === "shape")
    ? { rich: shape.text ?? [], part: shape.type, slide: null, el: null }
    : null;
}

const fragmentOf = (doc: Y.Doc, target: TextTarget): Y.XmlFragment | null =>
  "slide" in target ? elementTextFragment(doc, target.slide, target.el) : shapeTextFragment(doc, target.shape);

/** After this long without a keystroke, others' changes to the box show in the field. */
const TYPING_MS = 1200;

function TextEditor({
  room,
  fileId,
  target,
  readOnly,
}: {
  room: LiveRoom;
  fileId: string;
  target: TextTarget;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const { colors: c, shadows } = useTheme();
  const toast = useToast();
  const { width: screen } = useWindowDimensions();
  const doc = room.doc;
  const first = useMemo(() => readTarget(doc, target), [doc, target]);
  const [text, setText] = useState(() => editorText(first?.rich));
  const [shown, setShown] = useState(first);
  const typedAt = useRef(0);
  const gone = useRef(false);

  // Others' changes, and the box going away.
  useEffect(() => {
    const onChange = (_: Uint8Array, origin: unknown) => {
      const now = readTarget(doc, target);
      if (!now) {
        if (gone.current) return;
        gone.current = true;
        errorHaptic();
        toast({ title: t("live.slides.errors.notFound"), icon: "x" });
        goBack();
        return;
      }
      setShown(now);
      if (origin === LOCAL || Date.now() - typedAt.current < TYPING_MS) return;
      setText(editorText(now.rich));
    };
    doc.on("update", onChange);
    return () => doc.off("update", onChange);
  }, [doc, target, toast, t]);

  // Who edits what: this box, while the screen is open.
  useEffect(() => {
    room.setLocal(
      "slide" in target
        ? { mode: "editing", at: { slide: target.slide }, sel: { slide: [target.el] } }
        : { mode: "editing", sel: { canvas: [target.shape] } },
    );
    return () => {
      if (!room.destroyed) room.setLocal({ mode: "viewing", sel: undefined });
    };
  }, [room, target]);

  const write = useCallback(
    (value: string) => {
      const texts = paragraphTexts(value);
      const fragment = fragmentOf(doc, target);
      try {
        if (fragment) editParagraphTexts(fragment, texts, LOCAL);
        else {
          // A box without words yet (a shape never labeled): its text starts here.
          const rich: RichDoc = texts.map((line) => ({ runs: line ? [{ text: line }] : [] }));
          if ("slide" in target) updateElement(doc, target.slide, target.el, { text: rich }, LOCAL);
          else updateShape(doc, target.shape, { text: rich }, LOCAL);
        }
      } catch {
        errorHaptic();
        toast({ title: t("live.slides.errors.tooLarge"), icon: "x" });
      }
    },
    [doc, target, toast, t],
  );

  const part = shown?.part ?? "text";
  const title = t(`mobile.live.slides.part.${part}`);
  const placeholder =
    part === "title" || part === "number" || part === "quote"
      ? t("mobile.live.text.titlePlaceholder")
      : part === "note"
        ? t("live.canvas.placeholders.note")
        : t("mobile.live.text.placeholder");
  const width = screen - SCREEN_X * 2;
  const k = slideScale(width);
  const frame = shown?.el ? elementFrame(shown.el, k) : null;
  const picture = useFilePictures(room.orgId, fileId);
  const theme = useMemo(() => ("slide" in target ? deckTheme(doc) : undefined), [doc, target]);

  return (
    <>
      <PushedHeader title={title} action={{ label: t("mobile.live.text.done"), onPress: () => goBack() }} />
      <KeyboardAvoidingView behavior="padding" automaticOffset style={[styles.fill, { backgroundColor: c.grouped }]}>
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.in}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          {shown?.slide ? (
            <View style={[styles.preview, { width, height: (width * 9) / 16, boxShadow: shadows.e1 }]}>
              <SlideView theme={theme} slide={shown.slide} width={width} picture={picture} mode="edit" radius={8} />
              {frame ? (
                <View
                  pointerEvents="none"
                  style={[
                    styles.box,
                    {
                      left: frame.left - 3,
                      top: frame.top - 3,
                      width: frame.width + 6,
                      height: frame.height + 6,
                      borderColor: c.ink,
                    },
                  ]}
                />
              ) : null}
            </View>
          ) : null}
          {readOnly ? (
            <Text variant="body" tone="ink2" selectable style={styles.readOnly}>
              {text}
            </Text>
          ) : (
            <TextArea
              value={text}
              autoFocus
              minHeight={140}
              placeholder={placeholder}
              accessibilityLabel={title}
              onChangeText={(next) => {
                typedAt.current = Date.now();
                setText(next);
                write(next);
              }}
            />
          )}
          {readOnly ? null : (
            <Text variant="footnote" tone="faint" style={styles.hint}>
              {t("mobile.live.text.hint")}
            </Text>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

/** The field's place while the file opens. */
function TextBones() {
  const { colors: c } = useTheme();
  return (
    <View style={[styles.fill, styles.in, { backgroundColor: c.grouped }]} accessibilityState={{ busy: true }}>
      <View style={[styles.bone, { backgroundColor: c.raised }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  in: { paddingHorizontal: SCREEN_X, paddingTop: 16, paddingBottom: 24, gap: 16 },
  preview: { borderRadius: 8 },
  box: { position: "absolute", borderWidth: 1.5, borderRadius: 3 },
  readOnly: { paddingVertical: 8 },
  hint: { paddingHorizontal: 4 },
  bone: { height: 140, borderRadius: 12 },
});
