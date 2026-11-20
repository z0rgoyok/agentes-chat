/**
 * The presentation's own screens on the phone (ADR 0196 §9), each a push with the system's back: a slide opened large
 * (`/slides/<id>?slide=`), presenting (`/slides-show/<id>`, from a slide or following whoever presents), a text box's
 * words (`/slide-text/<id>`, also a canvas note's) and the layouts for a new slide or a slide's new look
 * (`/slide-layout/<id>`).
 */

/** A slide of the file, large. */
export const slideRoute = (id: string, slide: string) => ({
  pathname: "/slides/[id]" as const,
  params: { id, slide },
});

/** Presenting: from a slide (`at`), or following the person presenting (`follow`: their client id). */
export const slideShowRoute = (id: string, from: { at?: string; follow?: number } = {}) => ({
  pathname: "/slides-show/[id]" as const,
  params: {
    id,
    ...(from.at ? { at: from.at } : {}),
    ...(from.follow !== undefined ? { follow: String(from.follow) } : {}),
  },
});

/** The words of a slide's text box (`slide` + `el`), or of a canvas's note, text or shape (`shape`). */
export const textRoute = (id: string, at: { slide: string; el: string } | { shape: string }) => ({
  pathname: "/slide-text/[id]" as const,
  params: { id, ...at },
});

/** The layouts: for a new slide at a place (`at`), or for a slide's new look (`slide`). */
export const slideLayoutRoute = (id: string, what: { at: number } | { slide: string }) => ({
  pathname: "/slide-layout/[id]" as const,
  params: "at" in what ? { id, at: String(what.at) } : { id, slide: what.slide },
});
