const PART = /^[\w.-]+$/;
const parts = (path: string) => path.split("/");

/**
 * Whether what a person typed names a repository on a git host, as the server takes it for a code session:
 * `owner/name` (GitHub), a repository with its host first (`gitlab:group/project`), or its address.
 */
export function looksLikeRepo(typed: string) {
  if (typed.length > 500) return false;
  if (typed.startsWith("https://")) {
    const rest = typed.slice("https://".length);
    const slash = rest.indexOf("/");
    return slash > 0 && slash < rest.length - 1 && !/\s/.test(rest);
  }
  const colon = typed.indexOf(":");
  const host = colon > 0 ? typed.slice(0, colon) : "github";
  const path = parts(colon > 0 ? typed.slice(colon + 1) : typed);
  if (!path.every((p) => PART.test(p))) return false;
  if (host === "github" || host === "bitbucket") return path.length === 2;
  if (host === "gitlab") return path.length >= 2;
  return host === "git";
}

/** Whether a session's place is a project only on the agent's computer: a plain name, on no host. */
export const isLocalPlace = (repo: string) => !repo.includes("/") && !repo.includes(":");
