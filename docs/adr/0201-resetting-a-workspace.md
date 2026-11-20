# 0201. Resetting a workspace

- Status: Accepted (built)
- Date: 2026-11-18
- Extends: 0088 (workspace and account deletion: the same proof, the same holds)
- Code: `packages/engine/src/workspace-reset.ts` (`requestReset`, `resetWorkspace`, `enqueueWaitingResets`,
  `RESET_KEEPS`, `RESET_TOMBSTONES`, `RESET_ERASES`, `RESET_KEEPS_JOBS`, `RESET_STORED_FILES`); routes
  `POST /api/app/organizations/{id}/reset` and `…/reset/code` (`apps/server/src/routes/app/account.ts`); web
  `DeleteWorkspace.tsx`, phone `DeleteWorkspaceScreen.tsx`

## Context

An owner who tried the product, or whose team went the wrong way, wants to start over. Deleting the workspace and
making a new one loses what should not go: its plan and billing, its people and their roles, the AI accounts and
computers it set up, its connectors and Vault, and its usage history. Asking people to delete things one by one
leaves half of them behind.

## Decision

### 1. A fresh start, not a deletion

An owner resets the workspace with the proof a deletion takes (ADR 0088 §2: an emailed code bound to this reset, or
the password where the server sends no email), at most 3 times a day per workspace. Only a reset that actually
starts counts toward the 3. The workspace keeps its id, name and plan, and opens again like a new one: a new right
hand, `#general` with every member in it (made by the same person as before), and the onboarding from its "context"
step.

### 2. What stays and what goes

Every tenant table is in exactly one list, and a test checks that each table with `org_id` appears once:

- **Kept** (`RESET_KEEPS`): settings, members, roles, invitations, invite links and join codes, join requests, AI
  accounts (`provider_credentials`, `machine_accounts`), computers and their provisioning, connectors, custom tools,
  OAuth and GitHub App installations, mailboxes, the Vault, databases, webhooks, storage and its migrations, app
  grants, usage, the audit log and the operator's events. The outbox keeps only jobs of kept things
  (`RESET_KEEPS_JOBS`: email, the plan, usage limits, join requests, connectors, the Vault, computers, storage,
  feedback).
- **Tombstoned** (`RESET_TOMBSTONES`): agents, each erased as deleting one does (its work stopped, its secrets and
  sign-ins off its computer, its row kept because usage and the audit name it), and the right hand's seats, marked
  removed so the computer drops their files.
- **Erased** (`RESET_ERASES`): everything made in the workspace: conversations and messages, DMs, threads, files and
  their versions, live files, tasks and boards, routines, memory and search, missions, approvals, dashboards, the
  Wiki, skills, browser profiles, notifications. Stored bytes of erased rows (`RESET_STORED_FILES`) leave their store
  after the commit, and a test fails when an erased table that names bytes isn't listed there.

### 3. Re-runnable

`organizations.reset_requested_at` marks a reset under way until the transaction that erases the workspace clears it.
The agents go first, then the messages in batches (`MESSAGE_BATCH`, per channel), then one transaction erases the
rest, drops the workspace's waiting jobs for erased things and makes the right hand and `#general` again. A crash
anywhere before that commit leaves the mark set: the job retries, and the hourly deletions tick queues any reset left
waiting for over 10 minutes. A hold that keeps a deletion waiting keeps a reset waiting too, checked again before
each message batch with the workspace's row held, which also stops a late second job from taking messages posted
after the first one finished.

### 4. No undo, on purpose

There is no trash and no restore window: the confirm dialog says it happens at once and can't be undone, in every
language. A deletion keeps its contents for 7 days because the person may change their mind about leaving; a reset
is asked for by someone who stays and wants the old contents gone, and holding them would keep conversations and
files that the people in the workspace believe are erased.

### 5. The computer is kept

The workspace's computer and its provisioning row stay, so a provisioner never sees a second request, and billing is
untouched, so the onboarding's plan step (shown only while a workspace waits for its first payment) doesn't appear
again.
