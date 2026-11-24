/** What `transferFiles` and `pastedFiles` read of a paste's or a drop's data (`DataTransfer`). */
interface Transfer {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null;
  getData?: (kind: string) => string;
}

/**
 * The files a paste or a drop carries. Some engines (WebKit, in the desktop app too) list a pasted or dropped picture
 * only among the items, with `files` empty.
 */
export function transferFiles(data: Transfer | null | undefined): File[] {
  const files = Array.from(data?.files ?? []);
  if (files.length > 0) return files;
  return Array.from(data?.items ?? []).flatMap((item) => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

/**
 * A paste's files, or none when the paste is text that its app also put up as a picture: cells copied from Excel or
 * Numbers, words from Word or PowerPoint carry a rendering of themselves beside the text and the HTML. Text plus HTML
 * with no image in it is that case. A copied image has no text, or HTML that holds the `<img>`.
 */
export function pastedFiles(data: Transfer | null | undefined): File[] {
  const files = transferFiles(data);
  if (files.length === 0 || !data?.getData) return files;
  const text = data.getData("text/plain").trim();
  const html = data.getData("text/html");
  return text && html && !/<img[\s>]/i.test(html) ? [] : files;
}

/** A drag that carries files from the computer (not text or a link dragged inside the page). */
export const dragsFiles = (data: Pick<DataTransfer, "types"> | null | undefined) =>
  Array.from(data?.types ?? []).includes("Files");
