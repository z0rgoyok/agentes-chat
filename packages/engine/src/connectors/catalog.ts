import type { OutcomeKind } from "../context/outcomes";

/**
 * Connector catalog: which MCP servers agentes.chat knows, and how each of
 * their tools maps to one of OUR scopes (ADR 0016: MCP has no standard scopes).
 * A tool the server offers but this catalog doesn't list is never exposed.
 * `sensitive` tools always need a person's approval (merge, deploy and
 * rollback are sensitive whatever this says; see `isSensitive`).
 *
 * Tool names follow the public MCP servers of each vendor. Titles are
 * templates for approval cards: `{param}` is replaced by the call's value.
 */
export interface ConnectorScope {
  label: string;
  description: string;
}

export interface ConnectorTool {
  scope: string;
  sensitive?: boolean;
  /** Approval-card title template, e.g. "Merge PR #{pullNumber} in {owner}/{repo}". */
  title?: string;
  /** Outcome recorded when the call succeeds (ground truth for lessons); `subject` is a template. */
  onSuccess?: { kind: OutcomeKind; subject: string };
  /**
   * Served by agentes.chat under this exact name (the git tools), never taken from the vendor's MCP server: access
   * lists and denies it by that name.
   */
  ours?: boolean;
  /**
   * Where the agent's own words go on GitHub (ADR 0156): a `body` gets the agent's signature line when given
   * (`always`: an empty one too), a commit message (`message`, a merge's `commit_message`) the agent's own
   * `Co-Authored-By` and the person's credit when given.
   */
  sign?: { field: "body" | "message" | "commit_message"; always?: true };
  /** A sensitive tool of ours that asks every time: no "Aprovar sempre" (it spends money or lets people in). */
  askAlways?: true;
}

/** Catalog groups (the app translates them, `connectors.category.*`): development, product, docs, data (analytics), payments, sales, support, marketing, automation, social. */
export type ConnectorCategory =
  | "dev"
  | "product"
  | "docs"
  | "data"
  | "payments"
  | "sales"
  | "support"
  | "marketing"
  | "automation"
  | "social";

export interface ConnectorDefinition {
  id: string;
  label: string;
  description: string;
  category: ConnectorCategory;
  /** Its MCP endpoint (streamable HTTP); a `native` connector's vendor API base, stored and never opened. */
  serverUrl: string;
  auth: ("oauth" | "api_key")[];
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string[];
    scopeSeparator?: string;
    /** The client's id and secret go in HTTP Basic, never in the form (X refuses them there). */
    clientAuth?: "basic";
    /** What the vendor calls the client's id in the authorize URL, the token call and the refresh (`client_key`). */
    clientIdParam?: string;
    /** `false`: the vendor's web flow takes no PKCE. */
    pkce?: false;
  };
  /**
   * Served by agentes.chat itself (ADR 0170): no MCP server, every tool `ours`, run by `connectors/native/<id>.ts`
   * through `createNativeConnectorToolSource`.
   */
  native?: true;
  /**
   * A git host (ADR 0227) that runs at an address of one's own: `optional` where the connector's own address is the
   * vendor's site (GitLab), `required` where there is no such site (a git server by address). The connection keeps it
   * as its `server_url`.
   */
  address?: "optional" | "required";
  /** Sent with every request to its MCP server, besides the sign-in. */
  headers?: Record<string, string>;
  scopes: Record<string, ConnectorScope>;
  tools: Record<string, ConnectorTool>;
}

const s = (label: string, description: string): ConnectorScope => ({ label, description });

export const CONNECTOR_CATALOG: Record<string, ConnectorDefinition> = {
  github: {
    id: "github",
    category: "dev",
    label: "GitHub",
    description: "Repositories, pull requests, issues and Actions.",
    serverUrl: "https://api.githubcopilot.com/mcp/",
    auth: ["oauth", "api_key"],
    oauth: {
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "read:org", "workflow", "project"],
      scopeSeparator: " ",
    },
    // The remote server loads only context, repos, issues, pull_requests and users unless asked (its docs/remote-server.md).
    headers: {
      "X-MCP-Toolsets":
        "context,repos,issues,pull_requests,users,actions,projects,discussions,labels,code_security,dependabot,secret_protection,security_advisories,governance",
    },
    scopes: {
      "repo.read": s("Read code", "Read files and commits and search the code."),
      "repo.write": s("Write code", "Create branches and push commits (never to the default branch without a PR)."),
      "git.read": s(
        "Clone repositories (git)",
        "Clone and update repositories on the agent's computer with git, through our proxy; the GitHub token never enters the machine.",
      ),
      "git.write": s(
        "Push branches (git push)",
        "Push commits to agentes/{agent}/… branches: never to the default branch, no force push, no tags. Deleting branches (delete_branches) and pushing to someone else's branch (request_branch_push) ask for approval first.",
      ),
      "pr.read": s("Read pull requests", "List and read pull requests and their checks."),
      "pr.write": s("Open pull requests", "Open pull requests and comment on them."),
      "pr.merge": s(
        "Merge pull requests",
        "Merge a pull request. Asks for approval, except in the repositories chosen on the agent's page.",
      ),
      "issues.read": s("Read issues", "List and read GitHub issues."),
      "issues.write": s("Write issues", "Create issues and comment."),
      "actions.read": s("Read Actions", "List workflows and runs and read their jobs and logs."),
      "actions.run": s("Run workflows", "Start GitHub Actions workflows (they may deploy). Always asks for approval."),
      "projects.read": s("Read Projects", "List and read GitHub Projects, their fields and items."),
      "projects.write": s("Write Projects", "Add items to GitHub Projects and move or edit them."),
      "repo.admin": s(
        "Manage repositories",
        "Create repositories and protect their branches with rulesets. Deleting a repository and adding a ruleset always ask for approval.",
      ),
      "discussions.read": s("Read discussions", "List and read GitHub Discussions and their comments."),
      "discussions.write": s("Write in discussions", "Comment and reply in GitHub Discussions and mark answers."),
      "security.read": s(
        "Read security alerts",
        "Read code scanning, Dependabot and secret scanning alerts and security advisories. Secret alerts show the leaked secret.",
      ),
      "org.read": s("Read teams", "List the members of an organization's teams."),
    },
    tools: {
      git_clone: { scope: "git.read", ours: true },
      open_pull_request: { scope: "pr.write", ours: true },
      delete_branches: { scope: "git.write", ours: true },
      request_branch_push: { scope: "git.write", ours: true },
      get_file_contents: { scope: "repo.read" },
      search_code: { scope: "repo.read" },
      search_commits: { scope: "repo.read" },
      search_repositories: { scope: "repo.read" },
      list_commits: { scope: "repo.read" },
      get_commit: { scope: "repo.read" },
      list_branches: { scope: "repo.read" },
      list_tags: { scope: "repo.read" },
      list_releases: { scope: "repo.read" },
      get_latest_release: { scope: "repo.read" },
      repository_ruleset_read: { scope: "repo.read" },
      create_branch: { scope: "repo.write" },
      push_files: { scope: "repo.write", sign: { field: "message" } },
      create_or_update_file: { scope: "repo.write", sign: { field: "message" } },
      create_repository: { scope: "repo.admin" },
      delete_repository: { scope: "repo.admin", sensitive: true, title: "Delete {owner}/{repo}" },
      // A ruleset is branch protection: who may push or merge from then on.
      create_repository_ruleset: { scope: "repo.admin", sensitive: true, title: "Create ruleset {name}" },
      pull_request_read: { scope: "pr.read" },
      list_pull_requests: { scope: "pr.read" },
      search_pull_requests: { scope: "pr.read" },
      create_pull_request: { scope: "pr.write", sign: { field: "body", always: true } },
      update_pull_request: { scope: "pr.write", sign: { field: "body" } },
      update_pull_request_branch: { scope: "pr.write" },
      add_comment_to_pending_review: { scope: "pr.write" },
      add_reply_to_pull_request_comment: { scope: "pr.write", sign: { field: "body" } },
      // Its `submit_pending` and `create` methods can approve a pull request: never approved for good.
      pull_request_review_write: {
        scope: "pr.write",
        sensitive: true,
        sign: { field: "body" },
        title: "Review PR #{pullNumber} in {owner}/{repo}",
      },
      merge_pull_request: {
        scope: "pr.merge",
        sensitive: true,
        title: "Merge PR #{pullNumber} in {owner}/{repo}",
        onSuccess: { kind: "pr_merged", subject: "{owner}/{repo}#{pullNumber}" },
        // Without one, GitHub's own message (a squash's lists the merged commits, their lines included).
        sign: { field: "commit_message" },
      },
      issue_read: { scope: "issues.read" },
      list_issues: { scope: "issues.read" },
      search_issues: { scope: "issues.read" },
      list_issue_types: { scope: "issues.read" },
      get_label: { scope: "issues.read" },
      list_label: { scope: "issues.read" },
      issue_write: { scope: "issues.write", sign: { field: "body" } },
      sub_issue_write: { scope: "issues.write" },
      add_issue_comment: { scope: "issues.write", sign: { field: "body" } },
      update_issue_comment: { scope: "issues.write", sign: { field: "body" } },
      label_write: { scope: "issues.write" },
      list_discussions: { scope: "discussions.read" },
      get_discussion: { scope: "discussions.read" },
      get_discussion_comments: { scope: "discussions.read" },
      list_discussion_categories: { scope: "discussions.read" },
      discussion_comment_write: { scope: "discussions.write", sign: { field: "body" } },
      actions_list: { scope: "actions.read" },
      actions_get: { scope: "actions.read" },
      get_job_logs: { scope: "actions.read" },
      actions_run_trigger: {
        scope: "actions.run",
        sensitive: true,
        title: "Run {method} in {owner}/{repo}",
      },
      list_code_scanning_alerts: { scope: "security.read" },
      get_code_scanning_alert: { scope: "security.read" },
      list_dependabot_alerts: { scope: "security.read" },
      get_dependabot_alert: { scope: "security.read" },
      list_secret_scanning_alerts: { scope: "security.read" },
      get_secret_scanning_alert: { scope: "security.read" },
      list_repository_security_advisories: { scope: "security.read" },
      list_org_repository_security_advisories: { scope: "security.read" },
      projects_list: { scope: "projects.read" },
      projects_get: { scope: "projects.read" },
      projects_write: { scope: "projects.write" },
      get_team_members: { scope: "org.read" },
    },
  },
  sentry: {
    id: "sentry",
    category: "dev",
    label: "Sentry",
    description: "Errors, issues and events.",
    serverUrl: "https://mcp.sentry.dev/mcp",
    auth: ["oauth", "api_key"],
    oauth: {
      authorizeUrl: "https://sentry.io/oauth/authorize/",
      tokenUrl: "https://sentry.io/oauth/token/",
      scopes: ["org:read", "project:read", "event:read", "event:write"],
      scopeSeparator: " ",
    },
    scopes: {
      "issues.read": s("Read errors", "Search issues and events and read their details."),
      "issues.write": s("Triage errors", "Resolve, assign or ignore Sentry issues."),
    },
    tools: {
      find_projects: { scope: "issues.read" },
      search_issues: { scope: "issues.read" },
      search_events: { scope: "issues.read" },
      get_issue_details: { scope: "issues.read" },
      update_issue: { scope: "issues.write" },
    },
  },
  linear: {
    id: "linear",
    category: "product",
    label: "Linear",
    description: "Issues, projects and comments.",
    serverUrl: "https://mcp.linear.app/mcp",
    auth: ["oauth", "api_key"],
    oauth: {
      authorizeUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      scopes: ["read", "write"],
      scopeSeparator: ",",
    },
    scopes: {
      "issues.read": s("Read issues", "List and read Linear issues and projects."),
      "issues.write": s("Write issues", "Create and update issues and comments."),
    },
    tools: {
      list_issues: { scope: "issues.read" },
      get_issue: { scope: "issues.read" },
      list_projects: { scope: "issues.read" },
      create_issue: { scope: "issues.write" },
      update_issue: { scope: "issues.write" },
      create_comment: { scope: "issues.write" },
    },
  },
  x: {
    id: "x",
    category: "social",
    label: "X",
    description: "Posts on your X account: write, read mentions and search.",
    serverUrl: "https://api.x.com",
    auth: ["oauth"],
    native: true,
    oauth: {
      authorizeUrl: "https://x.com/i/oauth2/authorize",
      tokenUrl: "https://api.x.com/2/oauth2/token",
      scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
      scopeSeparator: " ",
      clientAuth: "basic",
    },
    scopes: {
      "posts.read": s("Read posts", "Read the account's posts and mentions, posts by id and recent posts by search."),
      "posts.write": s(
        "Post",
        "Post on the account, with pictures or a video from the Drive. Deleting a post asks for approval.",
      ),
    },
    tools: {
      get_my_posts: { scope: "posts.read", ours: true },
      get_mentions: { scope: "posts.read", ours: true },
      get_post: { scope: "posts.read", ours: true },
      search_recent: { scope: "posts.read", ours: true },
      get_user: { scope: "posts.read", ours: true },
      create_post: { scope: "posts.write", ours: true },
      delete_post: { scope: "posts.write", ours: true, sensitive: true, title: "Delete X post {id}" },
    },
  },
  threads: {
    id: "threads",
    category: "social",
    label: "Threads",
    description: "Posts and replies on your Threads account.",
    serverUrl: "https://graph.threads.com",
    auth: ["oauth"],
    native: true,
    oauth: {
      authorizeUrl: "https://threads.com/oauth/authorize",
      tokenUrl: "https://graph.threads.com/oauth/access_token",
      scopes: [
        "threads_basic",
        "threads_content_publish",
        "threads_read_replies",
        "threads_manage_replies",
        "threads_manage_mentions",
        "threads_manage_insights",
        "threads_delete",
      ],
      scopeSeparator: ",",
      pkce: false,
    },
    scopes: {
      "posts.read": s("Read posts", "Read the account's posts, their replies, mentions and results."),
      "posts.write": s(
        "Post and reply",
        "Post with pictures or videos from the Drive, reply and hide replies. Deleting a post asks for approval.",
      ),
    },
    tools: {
      get_my_posts: { scope: "posts.read", ours: true },
      get_replies: { scope: "posts.read", ours: true },
      get_mentions: { scope: "posts.read", ours: true },
      get_insights: { scope: "posts.read", ours: true },
      create_post: { scope: "posts.write", ours: true },
      reply: { scope: "posts.write", ours: true },
      hide_reply: { scope: "posts.write", ours: true },
      delete_post: { scope: "posts.write", ours: true, sensitive: true, title: "Delete Threads post {id}" },
    },
  },
  "meta-ads": {
    id: "meta-ads",
    category: "marketing",
    label: "Meta Ads",
    description: "Meta (Facebook and Instagram) ad campaigns and results.",
    serverUrl: "https://graph.facebook.com",
    auth: ["oauth"],
    native: true,
    oauth: {
      authorizeUrl: "https://www.facebook.com/v27.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v27.0/oauth/access_token",
      scopes: ["ads_read", "ads_management", "business_management", "pages_show_list", "pages_read_engagement"],
      scopeSeparator: ",",
      pkce: false,
    },
    scopes: {
      "ads.read": s("Read ads", "List ad accounts, campaigns, ad sets and ads, and read their results."),
      "ads.write": s(
        "Manage ads",
        "Create campaigns, ad sets and ads (always paused), edit and pause them. Turning one on and changing a budget always ask; archiving and deleting ask.",
      ),
    },
    tools: {
      list_ad_accounts: { scope: "ads.read", ours: true },
      list_campaigns: { scope: "ads.read", ours: true },
      list_ad_sets: { scope: "ads.read", ours: true },
      list_ads: { scope: "ads.read", ours: true },
      get_insights: { scope: "ads.read", ours: true },
      create_campaign: { scope: "ads.write", ours: true },
      create_ad_set: { scope: "ads.write", ours: true },
      create_ad: { scope: "ads.write", ours: true },
      update: { scope: "ads.write", ours: true },
      pause: { scope: "ads.write", ours: true },
      activate: {
        scope: "ads.write",
        ours: true,
        sensitive: true,
        askAlways: true,
        title: "Turn on Meta ad object {id} (it spends)",
      },
      set_budget: {
        scope: "ads.write",
        ours: true,
        sensitive: true,
        askAlways: true,
        title: "Set the budget of Meta ad object {id}",
      },
      archive: { scope: "ads.write", ours: true, sensitive: true, title: "Archive Meta ad object {id}" },
      delete: { scope: "ads.write", ours: true, sensitive: true, title: "Delete Meta ad object {id}" },
    },
  },
  tiktok: {
    id: "tiktok",
    category: "social",
    label: "TikTok",
    description: "Your TikTok profile and videos, and videos sent to your drafts.",
    serverUrl: "https://open.tiktokapis.com",
    auth: ["oauth"],
    native: true,
    oauth: {
      authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
      tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
      scopes: ["user.info.basic", "user.info.profile", "user.info.stats", "video.list", "video.upload"],
      scopeSeparator: ",",
      clientIdParam: "client_key",
      pkce: false,
    },
    scopes: {
      "videos.read": s("Read videos", "Read the creator's profile, public videos and what they may post."),
      "videos.write": s(
        "Send videos to drafts",
        "Send a Drive video to the creator's TikTok drafts, where they finish the post. Each upload asks for approval.",
      ),
    },
    tools: {
      get_profile: { scope: "videos.read", ours: true },
      list_videos: { scope: "videos.read", ours: true },
      get_creator_info: { scope: "videos.read", ours: true },
      get_post_status: { scope: "videos.read", ours: true },
      upload_draft: {
        scope: "videos.write",
        ours: true,
        sensitive: true,
        askAlways: true,
        title: "Send a video to the TikTok drafts",
      },
    },
  },
  // The other git hosts (ADR 0227): served by the same git tools and proxy as GitHub's, through `git/hosts`.
  gitlab: {
    id: "gitlab",
    category: "dev",
    label: "GitLab",
    description: "Repositories and merge requests on GitLab.com or a GitLab of your own.",
    serverUrl: "https://gitlab.com",
    // Sign-in on gitlab.com where this server has its application there; a token always, and for a GitLab of one's
    // own (each one would need an application of its own).
    auth: ["oauth", "api_key"],
    oauth: {
      authorizeUrl: "https://gitlab.com/oauth/authorize",
      tokenUrl: "https://gitlab.com/oauth/token",
      // `api` for the questions and merge requests, `write_repository` for git over HTTPS.
      scopes: ["api", "write_repository"],
      scopeSeparator: " ",
    },
    native: true,
    address: "optional",
    scopes: {
      "git.read": s(
        "Clone repositories (git)",
        "Clone and update repositories on the agent's computer with git, through our proxy; the token never enters the machine.",
      ),
      "git.write": s(
        "Push branches (git push)",
        "Push commits to agentes/{agent}/… branches: never to the default branch, no force push, no tags. Deleting branches and pushing to someone else's branch ask for approval first.",
      ),
      "pr.write": s("Open merge requests", "Open merge requests from a pushed branch. Merging stays with people."),
    },
    tools: {
      gitlab_git_clone: { scope: "git.read", ours: true },
      gitlab_open_pull_request: { scope: "pr.write", ours: true },
      gitlab_delete_branches: { scope: "git.write", ours: true },
      gitlab_request_branch_push: { scope: "git.write", ours: true },
    },
  },
  bitbucket: {
    id: "bitbucket",
    category: "dev",
    label: "Bitbucket",
    description: "Repositories and pull requests on Bitbucket Cloud.",
    serverUrl: "https://bitbucket.org",
    auth: ["oauth", "api_key"],
    oauth: {
      authorizeUrl: "https://bitbucket.org/site/oauth2/authorize",
      tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
      // The consumer registered with Bitbucket carries the scopes (account, repositories and pull requests, write):
      // none goes on the request, and the client signs in with HTTP Basic.
      scopes: [],
      clientAuth: "basic",
      pkce: false,
    },
    native: true,
    scopes: {
      "git.read": s(
        "Clone repositories (git)",
        "Clone and update repositories on the agent's computer with git, through our proxy; the token never enters the machine.",
      ),
      "git.write": s(
        "Push branches (git push)",
        "Push commits to agentes/{agent}/… branches: never to the default branch, no force push, no tags. Deleting branches and pushing to someone else's branch ask for approval first.",
      ),
      "pr.write": s("Open pull requests", "Open pull requests from a pushed branch. Merging stays with people."),
    },
    tools: {
      bitbucket_git_clone: { scope: "git.read", ours: true },
      bitbucket_open_pull_request: { scope: "pr.write", ours: true },
      bitbucket_delete_branches: { scope: "git.write", ours: true },
      bitbucket_request_branch_push: { scope: "git.write", ours: true },
    },
  },
  git: {
    id: "git",
    category: "dev",
    label: "Git server",
    description: "Repositories on a git server by its address: Gitea, Forgejo, a company's own.",
    // Never opened: every connection carries its own address.
    serverUrl: "https://git.invalid",
    auth: ["api_key"],
    native: true,
    address: "required",
    scopes: {
      "git.read": s(
        "Clone repositories (git)",
        "Clone and update repositories on the agent's computer with git, through our proxy; the token never enters the machine.",
      ),
      "git.write": s(
        "Push branches (git push)",
        "Push commits to agentes/{agent}/… branches: never to the default branch, no force push, no tags. Pushing to someone else's branch asks for approval first.",
      ),
    },
    tools: {
      gitserver_git_clone: { scope: "git.read", ours: true },
      gitserver_request_branch_push: { scope: "git.write", ours: true },
    },
  },
  telegram: {
    id: "telegram",
    category: "social",
    label: "Telegram",
    description: "A Telegram bot of yours: its chats, groups and channels.",
    serverUrl: "https://api.telegram.org",
    auth: ["api_key"],
    native: true,
    scopes: {
      "messages.read": s("Read messages", "List the bot's chats and read what people wrote to it or where it is."),
      "messages.write": s(
        "Send messages",
        "Send, edit and pin messages and files as the bot. Deleting messages, banning people and invite links ask for approval.",
      ),
    },
    tools: {
      list_chats: { scope: "messages.read", ours: true },
      read_messages: { scope: "messages.read", ours: true },
      get_chat: { scope: "messages.read", ours: true },
      send_message: { scope: "messages.write", ours: true },
      send_file: { scope: "messages.write", ours: true },
      edit_message: { scope: "messages.write", ours: true },
      pin_message: { scope: "messages.write", ours: true },
      delete_message: {
        scope: "messages.write",
        ours: true,
        sensitive: true,
        title: "Delete message {message_id} in Telegram chat {chat_id}",
      },
      ban_member: {
        scope: "messages.write",
        ours: true,
        sensitive: true,
        title: "Ban {user_id} from Telegram chat {chat_id}",
      },
      create_invite_link: {
        scope: "messages.write",
        ours: true,
        sensitive: true,
        askAlways: true,
        title: "Create an invite link to Telegram chat {chat_id}",
      },
    },
  },
};

/** Our scope string for a connector scope, as stored in `agent_scopes`: `github:pr.merge`. */
export const connectorScope = (connector: string, scope: string) => `${connector}:${scope}`;

/** Fills an approval title template with the call's parameters. */
export function fillTitle(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = input[key];
    return v === undefined || v === null ? "?" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}
