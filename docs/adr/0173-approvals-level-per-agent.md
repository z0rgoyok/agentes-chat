# 0173. An approvals level per agent: always ask, only what is risky, never ask

- Status: Accepted (amended 2026-11-12: `always` and `never` are absolute, see the last section, which replaces
  items 2 to 5 and the Consequences where they differ)
- Date: 2026-11-11
- Extends: ADR 0015 (Tool Gateway and approvals, "Aprovar sempre"), ADR 0053 (who is behind a run, a routine's
  bounds), ADR 0131 (autonomy brakes)
- Code: `packages/db/src/schema/agents.ts` (`approvals_level`, migration `0254_agent_approvals_level`),
  `packages/engine/src/tools/run-policy.ts` (`ApprovalsLevel`, `approvalsLevelOf`, `toolPolicy`'s third argument),
  `packages/engine/src/tools/gateway.ts` (`unaskedAtNever`, the listing and the call), `packages/engine/src/agents.ts`
  (who sets it), `packages/engine/src/agent-audit.ts` (`approvalsLevel: "never"` on a call that ran unasked),
  `packages/engine/src/git/repos.ts` (`mergeReposOfCall`), `apps/server/src/routes/app/schemas.ts`
  (`ApprovalsLevel`), `packages/client/src/lib/approvals-level.ts`, web `pages/agent/ApprovalsLevelCard.tsx`, phone
  `features/agents/ApprovalsLevelRow.tsx`

## Context

Whether a call asks a person was decided per tool: a connector's tool at the level `approval`, a tool the classifier
marks sensitive (deletes, sends, payments), merge, deploy and rollback by name (`ALWAYS_SENSITIVE`), and every write
to a connected app from a routine's run or a run its reading feeds (ADR 0053 §4 and its addendum of 2026-10-31).
"Aprovar sempre" (ADR 0015) removes one card at a time. People asked for one setting per agent: an agent that is
trusted to act alone, and an agent that asks about everything.

## Decision

Each agent has an approvals level, `agents.approvals_level`: `always`, `risky` (the default, and what every agent
did before) or `never`.

1. **`risky`** changes nothing: what is marked sensitive asks.
2. **`always`**: every write to a connected app asks (`toolKind` `external`: a connector's or a custom server's
   tool that isn't a read, a mailbox's send), on a person's run and on the agent's own. The policy answers `approve`
   for it, the answer a routine's run already gets, so the same rules follow: the tool lists as one that asks and
   takes its `why`, "Aprovar sempre" is neither offered nor read, and "Pode fazer merge sem perguntar" is off
   (`mergeReposOfCall` gives no repository), on the connector's merge and on the computer's. Reads, internal changes
   people can undo (issues, memory, Drive, its own branches) and the computer's own command policy are as before:
   they never asked through a card.
3. **`never`**: a connected app's tool that asks only because it is marked sensitive runs without a card
   (`unaskedAtNever`). It still asks for:
   - merge, deploy and rollback, and what starts them under another name or runs whatever its arguments say
     (`customAlwaysAsks`: a release, a build, a workflow, a trigger, a script, a raw request, GraphQL, SQL). This is
     the list "Aprovar sempre" never covers, read on the tool's name, its scope and the actions it runs, so the two
     can't disagree.
   - a call through a tool that runs other actions whose actions it can't read.
   - a tool with its own approvers (someone's mailbox: its owner answers for it, ADR 0038).
   - our own tools that ask (`request_approval`, `request_permission`, `send_feedback`, a workspace where every
     command asks): asking is what they do, or the workspace's own rule.
4. **Routines and outside text are not relaxed.** A routine's run, and a run nobody is behind that a routine's
   report or work woke, ask for every write to a connected app at every level, `never` included. Text nobody checked
   (inbound mail, a webhook, the web) feeds those runs, and a level set once on the agent's page is not a person
   reading that text. A routine keeps its own ways to act alone: the actions its creator allowed for its job, "Sempre
   nesta rotina" and an action approved ahead. `unaskedAtNever` refuses such a run by itself, whatever the policy
   answered for the tool.
5. **It never widens what the agent may use.** Scopes are checked first, then the level. The budget, a connector's
   tools turned off, a mailbox's recipients and From address, the team-action check and the autonomy brakes all apply
   as before. What `never` does lift is asking itself: a tool an admin set to ask, and a shared mailbox set to ask
   before a send or a delete, run without a card (a person's own mailbox still asks its owner).
6. **Who sets it.** Whoever may edit any agent (`manage_agents`), through the agent's `PATCH`, and at creation only
   with that permission. A new agent starts at `risky`. The right hand's level can be changed too.
7. **The audit says so.** A call that ran without its card because of `never` is recorded with
   `details.approvalsLevel = "never"`, and the audit's detail shows "Not asked (Never ask)" where an approval would
   be. Changing the level is an `agent.updated` row with the new value.
8. **The level is read on every listing and every call**, so narrowing it asks from the next call.

In the apps: one row, "Aprovações", on the agent's page under Ferramentas e acesso (web) and on its profile (phone),
showing the level. It opens the three choices, each a title and one line. "Nunca perguntar" says what it still asks
for. A choice saves at once.

## Consequences

- At `never` an agent deletes, sends and pays through its connected apps without a person, within its scopes. The
  audit is where a person sees it afterwards.
- A mission task's call through the bridge has no run: it follows the mission's own Autonomia, and no level moves it.
- `always` does not make internal changes or computer commands ask. A workspace that wants every command to ask has
  its own switch (sandbox settings), which the level leaves alone.
- An approval card doesn't yet say that its agent always asks. The level is on the agent's page, one tap from the
  card's agent.

## Amended 2026-11-12: always and never are absolute

People read "Sempre perguntar" and "Nunca perguntar" as always and never, and the exceptions above made both
untrue: an agent set to never ask still asked for merge, deploy, rollback, tools that run whatever their arguments
say, someone's mailbox and everything a routine wrote, and one set to always ask changed issues, files, messages
and its computer without a word. The levels now mean what they say. This replaces items 2, 3, 4 and the last
sentence of 5 above, and the Consequences where they differ.

1. **`never`: no approval card for anything the agent may already use**, on every run that has one (a person's,
   the agent's own, a routine's, one a routine's reading or outside text feeds). That covers merge, deploy and
   rollback, what starts them under another name or runs whatever its arguments say (`alwaysAsks`), a call
   whose actions can't be read, a tool with its own approvers (someone's mailbox), a connected app's write from a
   routine, our own sensitive tools (`run_code`, `run_skill_script` and `start_task` where every command asks,
   `desktop_do`), and a command the computer held: the computer ran nothing when it held it, so the gateway runs
   the same call again the approved way instead of asking. "Pode fazer merge sem perguntar" is not needed: the
   agent merges in any repository it may use, with the same audit line and receipt, through the connector or by
   command (the runner names the merge of an approved command, protocol 59). The autonomy brakes' go-ahead card
   for costly work the agent started is skipped too. `schedule_action` posts no card either: the action is stored
   as already approved and its run does it at its time, while the agent still never asks. Narrowed before then,
   its run asks.
2. **What `never` does not lift.** It lifts asking and nothing else. The policy's refusals (what a routine may
   not use), scopes, a tool turned off, the budget, a mailbox's recipients and From address, the git proxy's
   never-allowed operations, a secret read, an action a person refused ahead, a cost a person said never to and
   the hourly cap on pull requests all hold: they are limits, not questions. A mission task's call has no run and
   follows the mission's own setting, as before.
3. **What still shows a card at `never`**: only the tools whose job is asking a person, because the agent chose
   to ask: `request_approval`, `request_permission`, `send_feedback`, `request_branch_push`, and the question
   and proposal cards (`ask_user`, `ask_choices`, `propose_*`, `offer_*`, `request_secret`).
4. **One place decides it.** `unaskedAtNever(level, tool, authority)` is read by the call, the listing (the tool
   lists without its `why` and is marked `unasked`, so no directory or prompt line says it asks), the held
   command and the brakes. The policy table still answers `approve` for a routine's write, and the gateway lifts
   the card, so a refusal in the table is never lifted with it.
5. **`always`: every call that changes something asks first, on every kind of run.** `toolPolicy` answers
   `approve` for the kinds `external`, `internal`, `elsewhere` and `unknown` (`asksAtAlways`), on a person's run,
   the agent's own, a routine's and a fed one: issues, memory, Drive, wiki, Vault, dashboards, code on its
   computer, posts and messages elsewhere, routines and reminders, tools the table doesn't know, and a click,
   typing or `browser_do` in its browser (`desktop_do` on its desktop). A routine's own actions
   (`routines.own_actions`) ask too, and its card offers no "Sempre nesta rotina". A computer brain's own tools
   only read (item 10).
6. **What `always` leaves alone**, because asking there would be asking about asking, or would keep the run from
   ending: `pass`, `hand_off`, the run's own bookkeeping (`set_status`, `withdraw_request`, long work's tools,
   `request_approval`), what speaks in the run's own conversation (`ask_user`, `ask_choices`, the `propose_*` and
   `offer_*` cards, reactions, polls), the tools whose own card is the question (`request_secret`,
   `request_permission`, `request_settings_change`, `request_folder_access`, `send_feedback`, `propose_event`,
   `schedule_action`, `propose_member_changes`, `propose_instruction_change`), a mission's tools, `update_widget` on a widget's refresh, a directory's search and
   `run_approved_action` (the tool behind them is judged), and every read: a connected app's, ours, a call of `workspace_action` that only searches (`looksOnly`), and
   looking at a page in the browser (`browser_open`, `browser_read`, `browser_screenshot` and the like), `git_clone`
   included. `update_skill` and `update_skill_from_source` were filed as reads by their scope and are changes now.
   `run_code`, `run_skill_script` and `start_task` list their reason as required, as every call of them asks.
7. **Opening a pull request never asks at `risky`**, on any run. Our `open_pull_request` already didn't. The
   GitHub connector's `create_pull_request` (the same tool when the GitHub App answers for the workspace, ADR
   0156) and a connected server's tool whose name ends in `create_pull_request` or `open_pull_request` are filed
   as the agent's own code work (`opensPullRequest`), so a routine's run and a fed one no longer get the card
   that read "vai abrir PR". GitLab's `create_merge_request` counts too, not sensitive by the word "merge", and a
   tool that runs other actions (Composio's executor) is judged by them when every one opens a pull request. A
   tool an admin set to ask still asks. A merge is another tool and follows the level: it asks at `risky` and `always`, not
   at `never`. At `always` opening a pull request asks like any other change.
8. **The audit** marks a call with `details.approvalsLevel = "never"` only when it would have asked: the policy
   said `approve`, the tool is marked sensitive, the call said why, or the computer held its command.
9. **What the agent is told** follows the level: the prompt's line on approvals, a routine's brief and what a
   routine's own actions cover say that nothing waits (`never`) or that every change does (`always`). At `never`
   the rules every agent reads no longer say to ask before a merge or a deploy, and the level's line says not to
   ask for a go in words or with `ask_user` either, unless the decision is the person's.
10. **A computer brain's own tools know the level.** The turn carries it (`BrainTurnRequest.permissions.asks`,
    runner protocol 59; an older runner ignores the field).
    - `always`, Claude Code: the turn starts without accepted edits and with only reads allowed by rule, and the
      runner's prompt lets nothing but a plain read through, a push to the agent's own branch included. Every
      edit and every other command reaches the server, which refuses it with how to ask: the same command through
      `run_code`, or the same change through `write_file`, with its reason. That call opens the card. A delegated
      Claude Code turn does the same in the worker (`allowedHere`).
    - `always`, every other brain (Codex, Cursor, OpenCode, Grok Build, Antigravity) and Claude Code on an older
      runner: no prompt sees each call of their own tools, so the server sends the turn as `plan`
      (`askingPermissions`). Their own tools only read, and every change goes through our tools, which ask.
    - `never`: a command the computer holds (a merge, a deploy, a push to the default branch) is refused by the
      brain's own shell with what it is and where it runs (`run_code`, which runs it without asking), never with a
      wait for a person. A push the git proxy never allows and a secret read keep their own refusals. Codex's
      approvals read the same. Claude Code's own deny rules still refuse a merge or a deploy in its shell with the
      CLI's words, so the level's prompt line says to run the same command with `run_code` then. A background
      task's executor has no `run_code`: there the refusal stays "stop and say so".
11. **"Aprovar sempre" is absolute too** (`rememberKinds`). At `risky` every approval card offers it: merge,
    deploy, rollback, a tool that runs whatever its input says, a call on a routine's run, a call the run policy
    sends to approval, a tool an admin set to ask. A kept rule is the agent's and holds on every kind of run: a
    person's, the agent's own, a routine's and one a routine's reading feeds. What is kept: the tool by the
    server's own name, and each action for a tool that runs others. A command on the computer is kept by its kind
    (`gh pr merge`, a held one too), and one with no kind (a script, a pipeline) by the tool itself, which then
    covers only commands with no kind of their own: a merge or a deploy needs its own rule. SQL proven read-only
    is kept as that project's reads, anything else as the tool. A held command of a kept kind runs again the
    approved way, with the merge receipt when it is one. Not offered: on a mailbox's tools (whether a send asks is
    the mailbox's setting, and a card that names who decides is kept for good by them alone), on the agent's own
    asking tools (`request_approval`, `request_permission`, `send_feedback`; `request_branch_push` keeps its
    one-branch rule, which the git proxy stops reading while the agent always asks), at `always` (no rule is
    offered or read), and where a routine's card offers the narrower "Sempre nesta rotina", which still leaves out
    merge, deploy, payments and deletions. A rule only skips the question: scopes, the run policy's refusals, the
    credential refusal on a fed run and the arguments' checks still come first.

Consequences of the amendment:

- At `never` a routine acts on text nobody checked (inbound mail, a webhook, the web) without a person. That is
  the choice the level's line states: "Never asks, merge, deploy, payments and routines included."
- At `always` an agent that works on its computer opens a card per command that changes something. Plain reads
  run. A workspace's "every command asks" switch (sandbox settings) is no longer the only way to get that.
- Still unasked at `always`, each stated because it is not closed: a mission's turns and tasks, which follow the
  mission's own command setting. A Claude Code turn that loads the computer owner's own settings and MCP servers
  (`personalMcp`), where a rule in the owner's settings can allow a command before our prompt sees it. A
  background task started with `start_task` runs under its own rules once its start was approved. What speaks in
  the run's own conversation and the run's own bookkeeping (item 6).
- A kept "Aprovar sempre" rule now covers runs that outside text feeds (a routine reading mail, a webhook, and
  the run its report wakes). Text nobody checked can then trigger an action of a kept kind with values of its
  choosing, with no person in between. Before, such runs always asked.
- A rule kept for a whole tool that runs anything (`run_code` for a script, an executor call of unknown shape) is
  as wide as the tool, short of a command with a kind of its own. The card's line says what it covers.
- Screens that named merge, deploy and rollback as always asking now say "by default" or "unless the agent never
  asks". Lines about other sensitive actions (a send, a share, a delete "always asks for approval") are unchanged
  and are untrue for an agent set to never ask.

## Addendum 2026-11-15: a workspace level, and changing it from the card

People were asked again and again and could not find where to stop it: the level lived only on each agent's page,
and no approval card pointed to it. What each level means is unchanged (the amendment above still holds).

1. **The workspace has a level**, `organization_settings.approvals_level` (`risky` without a row). An agent follows
   it until someone sets the agent's own choice. `agents.approvals_level_own` says which: false while it follows.
   The workspace's level is copied onto each following agent (`setWorkspaceApprovalsLevel`, and at creation through
   `createAgent` and the right hand's provisioning), so every reader keeps reading `agents.approvals_level` alone and
   the policy, the prompt lines and the git proxy needed no change.
2. **The migration changes nothing on deploy.** Migration `0278_workspace_approvals_level` marks an agent at any
   level but `risky` as its own choice, and the rest follow the workspace, which starts at `risky`. An agent someone
   set back to `risky` by hand reads as following, which behaves the same.
3. **Who sets it.** Whoever may set any agent's level (`manage_agents`), through `PUT …/approvals-level`. Setting it
   changes every agent that follows it and leaves own choices alone. The answer and Settings say how many agents keep
   their own. With `everyAgent` it also clears every agent's own choice, so all of them follow it. An agent's `PATCH`
   with `approvalsLevel: null` makes it follow the workspace again. A level given in a `PATCH` or at creation is the
   agent's own choice. Both are audited (`organization.approvals_level`, `agent.updated`).
4. **The apps.** Settings → Aprovações (admins) shows the workspace's level with the same three choices, titles and
   lines as an agent's row, and an ⓘ. An agent's row says "Segue o workspace" while it follows. Every waiting
   approval (the conversation's card, the approvals page, the notifications, the right hand's cards, the phone's
   approval sheet, its conversation cards and its notifications) has "Mudar quando perguntar" for who decides it and may set the agent's
   level (`changesWhenAsks`: `canDecide` and `manage_agents`). It opens the agent's three choices in place, approves
   nothing, and a toast says the new choice with Desfazer, which puts back the levels before it. Who may set the
   workspace's level also gets "Para todos os agentes do workspace" there, which is `everyAgent`. Ticked, no level
   shows as chosen, so the agent's current level can be given to every agent too.

Consequences:

- An agent's owner who decides its approvals but doesn't manage agents doesn't see the link: they couldn't save the
  choice. Widening who sets an agent's level is a separate decision.
- Desfazer after "Para todos os agentes" sets the workspace's level back and saves each cleared own choice again,
  one request per agent that had one.

## Addendum 2026-11-26: changing it from the chat

People say it in words ("pode aprovar tudo daqui pra frente", "always ask me first") and were sent to Settings. An
agent now proposes the change where it was asked, as a card a person confirms. What each level means is unchanged.

1. **Two catalog actions** (`workspace-actions.ts`), both `mode: "card"`: nothing applies at once, even for an owner
   asking in their own words, because the level decides how much every agent acts unasked.
   - `set_approvals_level`: the workspace's level (`setWorkspaceApprovalsLevel`), `every_agent` for "Para todos os
     agentes do workspace". Needs `administrator`, as the screen. Desfazer puts back the workspace's level and each
     own choice "every agent" cleared.
   - `set_agent_approvals_level`: one agent's own choice, or `workspace` to follow the workspace again (`updateAgent`).
     Needs `manage_agents`, as the agent's page.
2. **Who proposes it.** The right hand through `workspace_action`. Every agent through `request_settings_change`
   (its own level) and an agent that may set the team up through `propose_settings_change` (a teammate's), with the
   field `approvals`: that field never becomes a settings row (ADR 0219 would review and apply it with nobody asked),
   it posts the same confirm card beside the settings card.
3. **Only the person's own words** (ADR 0250). The card is posted only when the run answers the person's own typed
   message and read nothing anyone else wrote (`ownWords`). A relayed request (a token, an AI app, a bridged chat)
   gets `relayedRefusal`. Text an agent read can't put this card in front of a person.
4. **Who confirms it** is the person's role: who holds the key sees Aplicar; anyone else sends it to whoever does
   ("Pedir a quem pode"), whose click applies it as them.
5. **The card** names the level by its title on the agent's page ("Nunca perguntar") and says under it what the level
   means, in the same line as its choice there (`approvalsLevel.{level}.text`). Web and phone render it as every
   catalog card.

The other settings people ask for in words already had a way: who may use a computer (`set_permission_holders`, the
computers row), an agent's model and AI account (`propose_settings_change`), a routine on or off (`update_routine`
`active`), their own notifications (`set_notifications`).
