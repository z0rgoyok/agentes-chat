import type { Node as PMNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import { N, widthFraction } from "./schema";

/**
 * A picture in a document (ADR 0200, ADR 0196 §8): one of the file's own pictures, by its id, at its width (a share of
 * the page) or its natural size up to the page's, its description read aloud. A picture that won't load (taken away,
 * no connection) keeps its place, quiet, with its description.
 */
export class ImageView implements NodeView {
  dom: HTMLElement;
  private img: HTMLImageElement;
  private node: PMNode;
  private readonly url: (asset: string) => string;
  private readonly missing: string;

  constructor(node: PMNode, url: (asset: string) => string, missing: string) {
    this.node = node;
    this.url = url;
    this.missing = missing;
    this.dom = document.createElement("figure");
    this.dom.className = "lf-doc__img";
    this.img = document.createElement("img");
    this.img.draggable = false;
    this.img.addEventListener("error", () => this.dom.classList.add("is-missing"));
    this.img.addEventListener("load", () => this.dom.classList.remove("is-missing"));
    this.dom.append(this.img);
    this.draw(node, null);
  }

  private draw(node: PMNode, was: PMNode | null) {
    const asset = typeof node.attrs.asset === "string" ? node.attrs.asset : "";
    if (!was || was.attrs.asset !== asset) this.img.src = asset ? this.url(asset) : "";
    const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
    this.img.alt = alt;
    this.dom.title = alt;
    this.dom.dataset.missing = alt || this.missing;
    const width = widthFraction(node.attrs.width);
    this.dom.style.width = width ? `${Math.round(width * 1000) / 10}%` : "";
  }

  update(node: PMNode): boolean {
    if (node.type !== N.image) return false;
    this.draw(node, this.node);
    this.node = node;
    return true;
  }

  selectNode() {
    this.dom.classList.add("is-selected");
  }

  deselectNode() {
    this.dom.classList.remove("is-selected");
  }

  ignoreMutation() {
    return true;
  }
}
