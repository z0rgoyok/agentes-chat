import type { Agent } from "@agenteschat/client";
import { formatPercent } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import type { ArrowRoute, CanvasShapeKind, DrawTool } from "@agenteschat/live/canvas";
import { Button, Icon, type IconName, Kbd, Menu, MenuItem, useScrollSides } from "@agenteschat/ui";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { CAMERA_MAX, CAMERA_MIN } from "./camera";
import { DARK_INK, isInk } from "./palette";
import {
  ASK_KEY,
  IMAGE_KEY,
  INKS,
  KIND_ICONS,
  keyLabel,
  PEN_SIZES,
  type PenStyle,
  ROUTE_CHOICES,
  SHAPE_CHOICES,
  TOOL_KEYS,
  type Tool,
} from "./tools";

/**
 * The canvas's floating controls (ADR 0196 §2): the tools dock at the bottom (Select and Move around; Frame, the
 * Shapes and Arrow menus, the pen, text, note and image; Comment; and the file's agent, "Pedir ao Atlas"), the pen's
 * own bar above it while drawing, and the zoom island at the top right with the layers' toggle first. Glass, over the
 * plane, out of the way of the shapes.
 */

export type { Tool };

/** Arrow keys move along a toolbar's buttons (one tab stop for the whole bar). */
export function rovingKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])")];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? items.length - 1
        : (at + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

const Divider = () => <span className="cnv-dock__divider" aria-hidden="true" />;

export interface DockProps {
  tool: Tool;
  /** The form the Shapes tool draws (its icon on the dock). */
  shapeKind: CanvasShapeKind;
  /** How the Arrow tool's arrows run. */
  route: ArrowRoute;
  readOnly: boolean;
  /** Comment (a message in the file's conversation) is there: the page asks in it. */
  canComment: boolean;
  /** The file's agent "Pedir ao …" calls (null: none to ask). */
  agent: Agent | null;
  onTool(tool: Tool): void;
  onShape(kind: CanvasShapeKind | "line"): void;
  onRoute(route: ArrowRoute): void;
  onImage(): void;
  onAsk(): void;
}

/** The tools at the bottom of the plane; a read-only canvas keeps Select, Move around, Comment and the agent. */
export function Dock(props: DockProps) {
  const { tool, readOnly } = props;
  const { t } = useTranslation();
  // Narrower than its tools (a phone), it scrolls sideways and fades where more waits, as the editors' toolbars.
  const bar = useRef<HTMLDivElement>(null);
  const sides = useScrollSides(bar);
  const button = (which: Exclude<Tool, "shape" | "line">, icon: IconName, name: string) => {
    const active = tool === which;
    return (
      <Button
        key={which}
        variant="ghost"
        iconOnly
        icon={icon}
        className="cnv-dock__tool"
        aria-label={name}
        title={`${name} (${keyLabel(TOOL_KEYS[which])})`}
        aria-pressed={active}
        data-active={active || undefined}
        tabIndex={active ? 0 : -1}
        onClick={() => props.onTool(which)}
      />
    );
  };
  const ask = props.agent ? t("live.conversation.ask", agentGrammar(props.agent.name)) : "";
  return (
    <div
      ref={bar}
      className="cnv-dock ac-glass"
      role="toolbar"
      aria-label={t("live.canvas.tools.label")}
      data-sides={sides}
      onKeyDown={rovingKeys}
    >
      {button("select", "pointerTool", t("live.canvas.tools.select"))}
      {button("hand", "hand", t("live.canvas.tools.hand"))}
      {!readOnly && (
        <>
          <Divider />
          {button("frame", "frame", t("live.canvas.tools.frame"))}
          <ShapesTool {...props} />
          <ArrowTool {...props} />
          {button("draw", "pen", t("live.canvas.tools.pen"))}
          {button("text", "textTool", t("live.canvas.tools.text"))}
          {button("note", "sticky", t("live.canvas.tools.note"))}
          <Button
            variant="ghost"
            iconOnly
            icon="image"
            className="cnv-dock__tool"
            aria-label={t("live.canvas.tools.image")}
            title={`${t("live.canvas.tools.image")} (${keyLabel(IMAGE_KEY)})`}
            tabIndex={-1}
            onClick={props.onImage}
          />
        </>
      )}
      {props.canComment && (
        <>
          <Divider />
          {button("comment", "comment", t("live.canvas.tools.comment"))}
        </>
      )}
      {props.canComment && props.agent && (
        <>
          <Divider />
          <Button
            variant="ghost"
            className="cnv-dock__agent"
            aria-label={ask}
            title={`${ask} (${keyLabel(ASK_KEY)})`}
            tabIndex={-1}
            onClick={props.onAsk}
          >
            <AgentAvatar agentId={props.agent.id} name={props.agent.name} size="xs" />
            <span className="ac-btn__label">{ask}</span>
          </Button>
        </>
      )}
    </div>
  );
}

/** A dock button that also opens a menu of its kinds: a press takes the tool (as last set) and shows the menu. */
function MenuTool({
  name,
  keyHint,
  icon,
  active,
  onPress,
  children,
}: {
  name: string;
  keyHint: string;
  icon: IconName;
  active: boolean;
  onPress(): void;
  children: ReactNode;
}) {
  return (
    <Menu
      side="top"
      align="start"
      label={name}
      className="cnv-dock__menu"
      trigger={
        <Button
          variant="ghost"
          iconOnly
          className="cnv-dock__tool cnv-dock__tool--menu"
          aria-label={name}
          title={`${name} (${keyHint})`}
          aria-pressed={active}
          data-active={active || undefined}
          tabIndex={active ? 0 : -1}
          onClick={onPress}
        >
          <Icon name={icon} />
          <span className="cnv-dock__caret" aria-hidden="true">
            <Icon name="chevronDown" size={14} />
          </span>
        </Button>
      }
    >
      {children}
    </Menu>
  );
}

function ShapesTool({ tool, shapeKind, onShape }: DockProps) {
  const { t } = useTranslation();
  const line = tool === "line";
  return (
    <MenuTool
      name={t("live.canvas.tools.shapes")}
      keyHint={keyLabel(SHAPE_CHOICES[0]?.key ?? { key: "r" })}
      icon={line ? "line" : KIND_ICONS[shapeKind]}
      active={tool === "shape" || line}
      onPress={() => onShape(line ? "line" : shapeKind)}
    >
      {SHAPE_CHOICES.map((c) => (
        <MenuItem key={c.kind} icon={c.icon} hint={<Kbd>{keyLabel(c.key)}</Kbd>} onSelect={() => onShape(c.kind)}>
          {t(`live.canvas.shapeKinds.${c.kind}` as "live.canvas.shapeKinds.rect")}
        </MenuItem>
      ))}
    </MenuTool>
  );
}

function ArrowTool({ tool, route, onRoute }: DockProps) {
  const { t } = useTranslation();
  const icon = ROUTE_CHOICES.find((r) => r.route === route)?.icon ?? "arrowTool";
  return (
    <MenuTool
      name={t("live.canvas.tools.arrow")}
      keyHint={keyLabel(TOOL_KEYS.arrow)}
      icon={icon}
      active={tool === "arrow"}
      onPress={() => onRoute(route)}
    >
      {ROUTE_CHOICES.map((r) => (
        <MenuItem key={r.route} icon={r.icon} onSelect={() => onRoute(r.route)}>
          {t(`live.canvas.routes.${r.route}` as "live.canvas.routes.straight")}
        </MenuItem>
      ))}
    </MenuTool>
  );
}

/** An ink's look on a swatch: the ink's own color, drawn light on the dark canvas as the strokes are. */
export const inkSwatch = (color: string) =>
  ({ "--swatch": color, "--swatch-dark": isInk(color) ? DARK_INK : color }) as CSSProperties;

/** The pen's bar while drawing: pen or highlighter, five colors, three sizes (ADR 0196 §2). */
export function PenBar({ pen, onPen }: { pen: PenStyle; onPen(next: PenStyle): void }) {
  const { t } = useTranslation();
  const tools: { tool: DrawTool; icon: IconName }[] = [
    { tool: "pen", icon: "pen" },
    { tool: "marker", icon: "marker" },
  ];
  return (
    <div
      className="cnv-bar cnv-penbar ac-glass"
      role="toolbar"
      aria-label={t("live.canvas.pen.label")}
      onKeyDown={rovingKeys}
    >
      {tools.map((d) => (
        <Button
          key={d.tool}
          size="sm"
          variant="ghost"
          iconOnly
          icon={d.icon}
          aria-label={t(`live.canvas.pen.${d.tool}`)}
          title={t(`live.canvas.pen.${d.tool}`)}
          aria-pressed={pen.tool === d.tool}
          onClick={() => onPen({ ...pen, tool: d.tool })}
        />
      ))}
      <span className="cnv-bar__divider" aria-hidden="true" />
      <div className="cnv-bar__swatches" role="radiogroup" aria-label={t("live.canvas.pen.color")}>
        {INKS.map((ink) => (
          // biome-ignore lint/a11y/useSemanticElements: a swatch button in a radio group
          <button
            key={ink.key}
            type="button"
            role="radio"
            className="cnv-bar__swatch"
            aria-checked={pen.color.toLowerCase() === ink.color}
            aria-label={t(`live.canvas.inks.${ink.key}`)}
            title={t(`live.canvas.inks.${ink.key}`)}
            style={inkSwatch(ink.color)}
            onClick={() => onPen({ ...pen, color: ink.color })}
          />
        ))}
      </div>
      <span className="cnv-bar__divider" aria-hidden="true" />
      <div className="cnv-bar__sizes" role="radiogroup" aria-label={t("live.canvas.pen.size")}>
        {PEN_SIZES.map((s) => (
          // biome-ignore lint/a11y/useSemanticElements: a size button in a radio group
          <button
            key={s}
            type="button"
            role="radio"
            className="cnv-bar__size"
            aria-checked={pen.size === s}
            aria-label={t(`live.canvas.pen.sizes.${s}`)}
            title={t(`live.canvas.pen.sizes.${s}`)}
            onClick={() => onPen({ ...pen, size: s })}
          >
            {t(`live.canvas.pen.short.${s}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The zoom island at the top right: Layers, then −, the zoom (a menu: fit everything, the selection, 100%) and +. */
export function ZoomIsland({
  zoom,
  layers,
  onLayers,
  onStep,
  onActual,
  onFit,
  onFitSelection,
  canFit,
  hasSelection,
}: {
  zoom: number;
  /** The layers panel is open. */
  layers: boolean;
  onLayers(): void;
  onStep(dir: 1 | -1): void;
  onActual(): void;
  onFit(): void;
  onFitSelection(): void;
  canFit: boolean;
  hasSelection: boolean;
}) {
  const { t, i18n } = useTranslation();
  const percent = formatPercent(i18n.language, Math.round(zoom * 100));
  return (
    <div className="cnv-zoom ac-glass" role="toolbar" aria-label={t("live.canvas.zoom.label")} onKeyDown={rovingKeys}>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="layers"
        aria-label={t("live.canvas.layers.title")}
        title={t("live.canvas.layers.title")}
        aria-pressed={layers}
        onClick={onLayers}
      />
      <span className="cnv-bar__divider" aria-hidden="true" />
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="dash"
        aria-label={t("live.canvas.zoom.out")}
        title={`${t("live.canvas.zoom.out")} (-)`}
        tabIndex={-1}
        disabled={zoom <= CAMERA_MIN + 1e-3}
        onClick={() => onStep(-1)}
      />
      <Menu
        side="bottom"
        align="center"
        label={t("live.canvas.zoom.label")}
        trigger={
          <Button
            size="sm"
            variant="ghost"
            className="cnv-zoom__level tabular"
            aria-label={t("live.canvas.zoom.menu", { percent })}
            tabIndex={-1}
          >
            {percent}
          </Button>
        }
      >
        <MenuItem disabled={!canFit} hint={<Kbd>⇧1</Kbd>} onSelect={onFit}>
          {t("live.canvas.zoom.fitAll")}
        </MenuItem>
        <MenuItem disabled={!hasSelection} hint={<Kbd>⇧2</Kbd>} onSelect={onFitSelection}>
          {t("live.canvas.zoom.selection")}
        </MenuItem>
        <MenuItem hint={<Kbd>⇧0</Kbd>} onSelect={onActual}>
          {t("live.canvas.zoom.actual")}
        </MenuItem>
      </Menu>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="plus"
        aria-label={t("live.canvas.zoom.in")}
        title={`${t("live.canvas.zoom.in")} (=)`}
        tabIndex={-1}
        disabled={zoom >= CAMERA_MAX - 1e-3}
        onClick={() => onStep(1)}
      />
    </div>
  );
}
