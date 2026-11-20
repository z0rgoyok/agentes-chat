# 0188. Several assignees on a task

- Status: Accepted
- Date: 2026-11-15
- Code: schema `packages/db/src/schema/work.ts` (`issue_assignees`, migration 0281); engine
  `packages/engine/src/issue-assignees.ts` (`assigneesOf`, `setAssignees`, `assignedSql`, `dropAssignee`),
  `issues.ts` (`IssueView.assignees`, `createIssue`, `updateIssue`, `askAgentToImplement`, `workOf`, `unassignGone`),
  `task-access.ts` (`taskAgentSql`, `admitTaskAgents`), `notification-producers.ts` (`notifyIssueChanged`,
  `issueFollowers`), `issue-tools.ts` (`assignees` on `create_issue` and `update_issue`), `agent-undo.ts`,
  `team-status.ts`, `team-week.ts`, `context/proposals.ts` (`idleAgentSql`), `calendar.ts`, the removal hooks in
  `organizations.ts` (`removeMember`, `deleteAccount`), `agents.ts` (`archiveAgent`) and `agent-deletion.ts`; routes
  `apps/server/src/routes/app/issues.ts`, `calendar.ts`; tests `packages/engine/test/issue-assignees.test.ts`,
  `issues.test.ts`, `apps/server/test/issues.test.ts`

## Context

A task had one assignee: a person or an agent, in two columns of `issues`. Work is often shared: two people own a
launch, a person reviews what an agent builds, two agents split a job. With one slot, the others were named in the
description or in a comment, and got none of what an assignee gets: the notification, the task among an agent's open
tasks, a place in a limited task's audience.

## Decision

A task has any number of assignees, people and agents, in an order.

1. **Where they are kept.** `issue_assignees` holds one row per task and assignee (`assignee_type`, `assignee_id`,
   `position`, lowest first), unique per task and assignee, deleted with the task. The columns `issues.assignee_type`
   and `issues.assignee_id` are read by nothing; they stay one release, since a deploy migrates while the version
   before it still serves, and a later migration drops them. Migration 0281 carries each task's assignee over as the first of its list,
   leaving out an archived agent and a person who is no longer a member.
2. **The API.** `Issue.assignees` is the ordered list, `[]` when nobody has the task; so are a step's
   (`subIssues[].assignees`) and a calendar deadline's. Creating takes `assignees`; changing takes `assignees` as the
   whole new list, so whoever is left out leaves the task. At most 20; one named twice counts once. A person put on a
   task they can't see is refused (`issue.assignee_outside`); whoever is on it already isn't checked again.
3. **The activity.** Each person or agent put on a task is one `assigned` event (`data.assignee`), and each one taken
   off it another (`data.assignee`, `data.removed: true`); the activity entry carries who (`assignee`). A new order
   alone is no event.
4. **People.** Each person put on a task gets `issue_assigned`, and it resolves when they are taken off. Every person
   assigned follows the task, and stays in its audience when someone limits who sees it; so do the people assigned to
   its steps.
5. **Agents.** Every assigned agent reaches the task, reads it among its open tasks, gets "Your task" in the task's
   conversation, joins that conversation, has its runs there linked to the task, and moves it to in progress when it
   starts. The task's work (`IssueView.work`) is the run among its assigned agents that is alive, else their latest,
   named by that run's agent: one agent's finished run never hides another's that is still going.
   Being assigned still starts nothing: only "Pedir ao" and the right hand's hand-off start an agent.
6. **Who answers in the task's conversation.** A message there that names nobody goes to one agent: the first agent
   among the assignees, in their order, that isn't archived; then, as before, the agent that created the task, then the
   last agent that wrote there (amends ADR 0145's addendum). "Pedir ao" puts its agent first among the assignees,
   everyone else staying, so the agent a person asked is the one that goes on answering.
7. **Who is gone.** A person who leaves the workspace or deletes their account, and an agent that is archived or
   deleted, are taken off every task they were on; whoever sees those tasks hears it (`issue.updated`). Nothing is
   written in the tasks' activity: nobody chose it there. Bringing an archived agent back doesn't put it back on them.
8. **Agents' tools.** `create_issue` and `update_issue` take `assignees`, a list of "me" and handles (a person's name
   or email too); an empty list clears it. `list_issues` names everyone on a task. The receipt of an assignment
   (`issue.assigned`) names who was put on it (`assigneeName`, `assigneeIsSelf`) and everyone on it now
   (`assigneeNames`); Undo puts the previous list back.
9. **Reports.** A task counts for each agent assigned to it: the team's status, the week's review, and an agent with
   an open task isn't idle.
10. **The board.** The view's assignee filter and grouping keep their shape (`issues_view`): a task matches a
    filter key when any of its assignees does, and `none` when it has none.

## Consequences

- One path: no single-assignee field is kept beside the list, in the database, the API or the tools.
- Reading a list of tasks costs one more query, for all of them at once (`assigneesOf`).
- A task with several agents still has one agent answering by default, so two agents never answer the same line; the
  others are reached by name.
- An agent's open tasks are found by `issue_assignees (org_id, assignee_type, assignee_id)`, then sorted by the
  tasks' last change; the index on `issues` that did both is gone with the columns.
