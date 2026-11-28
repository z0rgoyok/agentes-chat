# 0227. One git engine for any host

- Status: Accepted
- Date: 2026-11-24
- Amends: ADR 0024 (the git proxy: the host is the connection's), ADR 0099 (personal connections: a git host may be
  one's own), ADR 0156 (who commits: the person in their code session), ADR 0215 (code sessions: §13, any host)
- Code: engine `git/hosts/types.ts` (`GitHost`, `HostAt`, `BranchFacts`, `branchBlock`), `git/hosts/refs.ts`
  (`parseRepoRef`, `repoRefName`, `repoEntry`, `refInList`, `checkoutDirOf`, `gitToolName`, `gitVerbOf`),
  `git/hosts/github.ts`, `gitlab.ts`, `bitbucket.ts`, `plain.ts` (`readAdvertisement`), `git/hosts/index.ts`
  (`GIT_HOSTS`, `teamGitConnection`, `repoRefFrom`), `git/hosts/reach.ts` (`hostAt`), `git/proxy.ts`, `git/tools.ts`,
  `git/machine.ts`, `git/branches.ts` (`pushGrants`, `hostConnectionToken`), `git/repos.ts`, `git/repo-listing.ts`
  (`elsewhere`), `git/person-account.ts`, `code-sessions.ts`, `connectors/catalog.ts` (`gitlab`, `bitbucket`, `git`,
  `address`), `connectors/connections.ts` (`gitAccount`, `gitServerUrl`), `connectors/own-github.ts`; adapters
  `machine-protocol.ts` (protocol 79, `isGitRepoPath`, `AgentScope.author`); runner `git.ts`, `co-authors.ts`
  (`commitAuthorEnv`); server `routes/app/connectors.ts` (`serverUrl`), `routes/github-app.ts` (`elsewhere`); client
  `lib/repos.ts`, `code/place.ts`, `lib/approval-words.ts`; web `ConnectFlow.tsx`, `code/CodeHome.tsx`; phone
  `ConnectSheet.tsx`, `coding/CodingWhereScreen.tsx`

## Context

Git worked on GitHub alone. The proxy forwarded to github.com, the branch questions went to GitHub's API, a
repository was `owner/name` everywhere, and the tools, the agents' repositories and the code sessions all read "the
workspace's GitHub connection". A team whose code lives on GitLab, on Bitbucket or on a server of its own could
connect those only as a set of tools from the vendor's own server, with no clone, no push and no code session.

At the same time a code session's work always went out as the workspace: commits authored as the agent, pushed and
opened as the app or the team's account. A person who asks for a change in a session wants it to be theirs, on any
host, on the Cloud as much as on a computer of their own.

## Decision

### 1. A git host is a contract

`GitHost` (`git/hosts/types.ts`) is everything the rest of the server needs to know about where repositories live:

- where it is reached for a connection (`at`: its API, its git address, its site) and a repository's address there;
- how a token signs in, for git (`gitLogin`, HTTP Basic) and for its API (`apiHeaders`);
- whose a token is (`account`) and the address its commits are authored with (`commitEmail`);
- which repositories a token reaches (`repositories`);
- what guards a branch (`branchFacts`: the default branch, protection, missing) and whether a commit descends from
  another (`descends`);
- opening a pull request (`openPullRequest`) and deleting a branch (`deleteBranch`).

What agents may do is decided once, above the contract, the same on every host: their own branch
(`agentes/<handle>/…`), fast-forward only, no tags, no deletes by push, a person's approval for someone else's branch,
never the default branch or a protected one. A host only answers questions and carries out what was already allowed.

A host that has no answer for a question leaves the method out, and whoever asks takes the careful way: no repository
list means the person types the name; no ancestry answer means a push must carry the history that makes it a
fast-forward; no pull request call means no such tool, and the agent hands over the link the server prints.

### 2. The hosts

| Host | Connector | Token | Notes |
|---|---|---|---|
| GitHub | `github` | the GitHub App's installation token, else the connection's | Unchanged (ADR 0024, 0116, 0156). |
| GitLab | `gitlab` | a sign-in on gitlab.com, or a personal, group or project access token (`api`, `write_repository`) | gitlab.com or a server of one's own (the connection's address). Merge requests; a draft is its title. |
| Bitbucket Cloud | `bitbucket` | a sign-in, a workspace, project or repository access token, or a person's API token after their Atlassian email (`email:token`) | Branch permissions by pattern and by branching model. |
| A git server by address | `git` | whatever the server takes as git's password (`user:token` when it wants a user) | Gitea, Forgejo, a company's own. No API: branches and the default branch come from its ref advertisement; a push must carry its own history; no pull request or delete tool. |

GitLab's one-click server of tools (issues, pipelines) stays a separate connector, renamed `gitlab-mcp`: its sign-in
can't push.

An address a person types (a GitLab of their own, a git server) is checked as every typed address is
(`assertPublicHttpsUrl`) and fetched through the guard that keeps private networks out (`outboundFetch`), unless the
operator allowed them (ADR 0210).

### 3. How a repository is named

GitHub's keep the name they always had, `owner/name`. A repository anywhere else carries its host first:
`gitlab:group/sub/project`, `bitbucket:workspace/repo`, `git:team/project.git`. That one string is what a code session
keeps (`code_sessions.repo`), what an agent's repositories list (`agent_repositories.repo`, with `gitlab:group/*` for
everything under a group) and what a push grant is kept by. Nothing stored before changes meaning, and no table
changes.

An agent's list counts per host: an empty list reaches every host, and a list of GitHub names opens nothing on GitLab.

Checkouts of another host live under `repos/_<host>/<path>` on the agent's computer; GitHub's stay at
`repos/<owner>/<name>`. No GitHub account starts with `_`, so the two never meet.

### 4. One connection per host for the workspace, and the same tools

The workspace has one connection to each host, the team's. The proxy's address already named the connection
(`/api/git/{org}/{connection}/…`): the host is that connection's, so each host has its own address there, and one
credential on the agent's computer serves them all.

Each connected host gives agents the same git tools on its own connection and scopes (`gitlab:git.read`,
`gitlab:git.write`, `gitlab:pr.write`). GitHub's keep their names (`git_clone`, `open_pull_request`, `delete_branches`,
`request_branch_push`); another host's carry it first (`gitlab_git_clone`, `gitserver_git_clone` for a git server by
address), so two hosts' tools never share a name and an approval, a rule or a denial stays with the host it was given
on.

The runner takes a repository's path as its host spells it (protocol 79, `isGitRepoPath`): deeper than `owner/name`
for a GitLab subgroup. An older runner is asked only for two-part paths, and is told to update for a deeper one.

### 5. In a code session, the work goes out as the person who asked

A member may connect a git host as their own (`connector_connections.owner_user_id`, ADR 0099). That connection has no
tools and no grants, is on no agent, and is never read as the workspace's. It is who the work goes as when its person
asks in a code session, on that session's repository alone:

- the commits the agent makes are authored as them: their name and the host's no-reply address for the account
  (GitHub's `<id>+<login>@users.noreply.github.com`, GitLab's `<id>-<username>@users.noreply.<site>`), never their own
  email. The runner sets it in the agent's own processes for that turn (`AgentScope.author`), never in the checkout's
  config, which sessions share. The agent still ends each commit with its own `Co-Authored-By` line;
- the push of the session's branch reaches the host with their token. The proxy's credential names the agent and its
  computer, never a run, so the session is found by its branch and the person by the run working in it now;
- the pull request is opened with their token, and on GitHub what the agent writes to that repository through
  GitHub's own tools too.

Their token stays on the server, as the workspace's does. A host refusing it (no access to that repository, a token
that ended) sends the work as the workspace, as before. So does everything else: a routine, a run nobody asked for,
another conversation, another repository, a person who left. In a session with several people it follows who asked
that turn, so nobody acts as someone else.

Where a host has no no-reply address (Bitbucket, a git server), commits stay authored as the agent; the push and the
pull request still go as the person.

## Consequences

- The workspace still needs the team's connection to a host: it is what clones, reads and serves every run a person
  isn't behind.
- GitHub's events, its own tools (issues, reviews, merging), skills from a repository and "merge without asking" stay
  GitHub's. On the other hosts agents clone, push, open a pull or merge request and ask to push or delete branches;
  merging stays with people.
- A push from a session's terminal with no turn running goes as the workspace.
- GitLab and Bitbucket connect by signing in where this server has an application registered with each
  (`CONNECTOR_GITLAB_CLIENT_ID`/`_SECRET`, `CONNECTOR_BITBUCKET_CLIENT_ID`/`_SECRET`), and with a token always. A
  sign-in is a person's account: for the workspace to act as a bot of its own, the team connects a group or workspace
  access token. A GitLab of one's own and a git server connect with a token only.
- A fifth host is a file in `git/hosts` and an entry in the catalog.
