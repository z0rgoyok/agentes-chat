/**
 * The tools a code session's conversation hides (ADR 0215), for every brain: the person sees the worktree's files and
 * the agent's screen in the session's panel, so nothing goes to the Drive or onto a reply from there; suggesting a
 * session is for a conversation outside one (`code-suggestions.ts`), and a session is already the place of its work,
 * as a mission's thread is, so no mission starts there. The gateway leaves them out of the tools of any
 * run whose tool context says it is in a session (`ToolContext.codeSession`): neither listed nor called. A module of its own, with no imports, so
 * the gateway reads it without pulling the session's module in.
 */
export const CODE_SESSION_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "upload_file",
  "export_file",
  "suggest_code_session",
  "propose_mission",
]);
