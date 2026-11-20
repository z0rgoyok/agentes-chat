import type { LegalDocument } from "./types";

export const privacyEn: LegalDocument = {
  title: "Privacy Policy",
  summary: "What we collect, what agents send where, who can see your workspace, and the rights you have.",
  updated: "2026-11-20",
  sections: [
    {
      id: "overview",
      heading: "1. Overview",
      blocks: [
        'AGENTESCHAT, LLC, a Delaware limited liability company doing business as agentes.chat ("agentes.chat", "we"), operates agentes.chat: a workspace where people and AI agents work together, available on the web, as a Mac app and as a phone app (the "Service"). This policy distinguishes three roles:',
        {
          list: [
            "For **account data**, the information people give us to create and use an account, we are the data controller.",
            "For **Workspace Content**, everything a workspace's people and agents put into or produce in it, we are a data processor acting on the workspace's instructions. The workspace is the controller, meaning the person or entity that created it or on whose behalf it was created.",
            "For the few cases in Section 6 where we act for ourselves (trust and safety, the security of the Service, and what the law requires of us), we are the controller of the personal data in the Workspace Content we read for that.",
          ],
        },
      ],
    },
    {
      id: "data-we-collect",
      heading: "2. Data we collect as controller",
      blocks: [
        {
          list: [
            "**Account data:** name, email address, password hash, profile photo, language and time zone. If you sign in with Google, Apple or GitHub, we receive your name, email address and the account identifier from that provider, never its password.",
            "**Workspace data:** the workspace's name, members, roles and invitations.",
            "**Support requests:** what you send us when you ask for help: your words, the thing you reported and what it says, the screen you were on, and any pictures or video you attach.",
            "**Billing data:** for a workspace with an agentes.chat plan, the name, email address, billing address and tax ID of the person who pays, the plan, and its invoices and payments. Payments are processed by Stripe, which handles the card details: they never reach us.",
            "**Usage and log data:** IP addresses, browser and device, sign-in sessions, security events, API requests, and the record of each model call (model, tokens and cost, with the workspace and agent it belongs to), which we keep to enforce budgets and show usage. When something breaks, we record the error, without message content, to fix it. We also keep a record of each time our team or an AI assistant that works for our team read Workspace Content with the tools or the console that Section 6 describes: who or what read, which item, when and why, never the content itself.",
            "**Devices:** for the phone app, the push notification token of each device you sign in on. For connected computers and the Mac app, the computer's name, operating system and app version.",
            "**Waiting list:** the email address and language you give us on agentes.chat, and whether you confirmed it.",
            "**Site analytics:** on agentes.chat (the public site, not the workspace), the pages viewed, the referring site, the device type and an approximate location derived from the IP address, collected with Himetrica.",
          ],
        },
      ],
    },
    {
      id: "how-we-use",
      heading: "3. How we use account data",
      blocks: [
        "To provide and secure the Service (including detecting and stopping abuse), bill for plans, apply budgets and limits, respond to support requests, meet legal obligations, and send service messages such as email confirmations, invitations, password resets, approval requests and notifications you turned on. We email the waiting list only to confirm the address and to invite you.",
        "To answer support requests and to look into faults and suspected abuse, we use AI assistants that work for our team. They think with Claude models. The provider of those models is Anthropic, which makes Claude: the assistants reach it through its API, under its commercial terms, which do not allow it to train its models on what it receives. They read account and usage records: identifiers, states and times, the text of errors our systems recorded (with credentials and addresses masked), and a name where a case needs one. They may look such an error up on the web. A person on our team may also look into a case with an AI tool they use themselves, which thinks with Claude models as well: that tool receives what the person reads, and that can include a person's email address.",
        "When a workspace is created we check its sign-up for abuse: the email's domain goes to the domain's registry, the network of the first sign-in (never the address) to Team Cymru, and the workspace's name to TypeSafe. On the sign-up and sign-in pages, a bot check run by our network provider reads signals from your browser.",
        "We do not sell personal data, do not use Workspace Content to train machine-learning models, and do not permit our subprocessors to do so.",
      ],
    },
    {
      id: "workspace-content",
      heading: "4. Workspace Content, processed on behalf of workspaces",
      blocks: [
        "Workspace Content includes messages in channels, threads and direct messages, files in the Drive and wiki pages. It also includes tasks, routines, calendar events and approvals, the instructions, settings and memory of agents, what agents write and do, and the data agents read through the connectors, databases and computers the workspace connects. We process it only to run the workspace and its agents as the workspace configures them, to show it to the workspace's members, to send the notifications they ask for, to provide support, to keep the Service working and secure, and in the cases of Section 6 where we act for ourselves.",
        "Workspace Content belongs to the workspace: members see what its channels and permissions allow, and its owners and admins manage it. Workspace owners and administrators can see every channel, task and wiki page, private ones included. They can't read direct messages between other people. Messages you posted stay in the workspace after you leave it or delete your account, unless the workspace deletes them.",
      ],
    },
    {
      id: "agents",
      heading: "5. How agents process Workspace Content",
      blocks: [
        "Agents are AI models that read and act inside the workspace. Workspace Content leaves our servers in the following cases. The companies that process it for us are listed in Section 9.",
        {
          list: [
            "**Between devices and our servers.** Everything sent between our servers and the browsers, apps and computers that connect to them, Workspace Content included, passes through our network provider, which protects the Service from attacks. To do that, the network provider decrypts this traffic at its data center nearest to each device, and handles it on our behalf.",
            "**Answering.** When an agent works, it sends the context it needs (the workspace's context, the agent's instructions, the conversation, relevant memory and the results of its tools) to the model provider chosen for that agent. With an API key the workspace added, the call is made under the workspace's own account and agreement with that provider. Some providers pass the call on to the company that makes or hosts the model, which then also processes it under that provider's terms. With an AI plan, such as Claude or ChatGPT, connected to an agent, the agent works under the account of the person who connected the plan and under the provider's terms.",
            "**Deciding who replies.** A routing model reads a new message, the names and roles of the workspace's agents, and recent conversation to decide which agent, if any, should reply. It runs at TypeSafe or, as a fallback, at the workspace's model provider. Routing never grants an agent any permission.",
            "**Memory.** Agents keep memory from conversations (summaries, facts and lessons) so they improve over time. Some judgments about memory (whether something is worth keeping, or conflicts with what an agent already knows) are made by TypeSafe. Memory can be seen and removed in the agent's page, and it is deleted with the workspace.",
            "**Search.** To find related messages and documents, text may be turned into vectors (embeddings) by DeepInfra, Inc.",
            "**Connectors.** When the workspace connects a service (such as GitHub, Google, Linear, Sentry, an email inbox or any MCP server), we store its access tokens encrypted and read or write that service only within the scopes the workspace gave each agent. The connected service processes that data under its own terms. Connections to Gmail and Outlook inboxes, and to Google Drive, Google Calendar, Google Sheets, Google Docs, Slack, Microsoft Teams, OneDrive, HubSpot, Salesforce, Zendesk, Asana, Figma, Intercom, Dropbox, Square, Instagram, Facebook, LinkedIn, YouTube, Pinterest, Reddit and WhatsApp, go through Composio, which processes what agents read and write there.",
            "**Databases.** Database connections are read-only. Credentials are stored encrypted and each query is checked before it runs.",
            "**Connected computers.** When someone connects a computer, agents can run commands and use a browser there, within the folders and permissions set on that computer. The live view of an agent's browser passes through our network provider and through our servers' memory, and is not recorded. A summary of the steps the agent took (such as addresses visited and actions) is kept with its work so the team can see what it did.",
            "**The workspace's computer.** On agentes.chat Cloud, a workspace's agents work on a computer we run for that workspace, on our servers or a hosting provider's, in the European Union or the United States. We count how much data each agent's browser, AI tools and other programs send and receive there, per day. The traffic of agents' browsers and programs there leaves through addresses we rent from a proxy provider, which carries it. The computer is wiped after the workspace's agentes.chat plan ends, as the Terms of Use describe.",
            "**Support, faults and safety.** When we look into a support request, a fault or suspected abuse (Section 6), an AI assistant that works for our team may read the item in question. That item is then sent to the assistant's model provider, the maker of Claude, which processes it in the United States, and in other countries when it routes a request there, under our business agreement with it: it may not train on it, and it deletes it within 30 days, except what its own abuse checks flag, which it may keep for up to two years. When a person on our team reads the item with an AI tool they use themselves, it goes to the same provider through that tool.",
            "**Storage, email and notifications.** Uploaded files and backups are kept at our storage providers. Emails and phone notifications that quote a message pass through our email provider and through Apple and Google. A support request you send us, with what you attach, reaches our team by email.",
            "**Abuse checks.** An automated judge that runs at TypeSafe reads a sample of what agents did. We keep only its verdict.",
            "**Other AI services we provide.** TypeSafe also judges whether an action of an agent should wait for a person, picks a model or tools for a task, and reads a screen's text or picture to find what to click when an agent uses a computer.",
            "**Web search.** When an agent searches the web, the words it searches for go to a search engine: DuckDuckGo from our servers, or the one the agent opens in its own browser. When it opens a page, the site sees the address it asked for, like any visitor's.",
            "**GIFs.** When an agent or a person searches for a GIF, the search words go to the GIF provider, GIPHY.",
          ],
        },
        "Actions that are hard to undo (such as merging code, deploying or sending on someone's behalf) become an approval request for a person before they happen, unless the workspace set that agent to act without asking. Text that comes from outside the workspace (web pages, emails, files) is marked as untrusted before an agent reads it.",
      ],
    },
    {
      id: "staff-access",
      heading: "6. When agentes.chat staff can see Workspace Content",
      blocks: [
        "We do not browse workspaces. Outside the running of your workspace that Sections 4 and 5 describe, our team and the AI assistants that work for our team read Workspace Content only:",
        {
          list: [
            "**At your request,** to help with a support request a member of your workspace sent us: from the app, from the email address of their account, or another way once we confirmed it is theirs. We read what the request is about and no more than the member who asked can see. When our AI assistant answers, it answers only at the address of that member's account. For this, a direct message is read only when someone in that conversation asked.",
            "**To fix a fault,** when something in the Service failed or got stuck, such as an agent's work that ended in an error or stopped moving. We read what that failure is about, and never a direct message.",
            "**For trust and safety,** to detect and investigate suspected abuse, fraud, unlawful content or a threat to the security of the Service or of other people, or to enforce our Terms of Use. We may do this without telling the workspace at the time. If we restrict a workspace or an account, we say why and how to contest it, unless an authority's order forbids us to say so. For this, in a direct conversation we read only what was said to an agent or by one, never messages between people, unless someone in that conversation reported them or the law requires it.",
            "**When the law requires it.**",
          ],
        },
        "At your request and to fix a fault we act on the workspace's instructions. For trust and safety we rely on our legitimate interest in keeping the Service and other people safe (GDPR Article 6(1)(f) and LGPD Article 7, IX) and, where the law requires it, on that legal obligation. You may object as Sections 11 and 12 describe.",
        "Our team and the AI assistants that work for it read with tools that give one item at a time. Each read made with those tools is made for one of these reasons and is recorded before it happens: who or what read, which item, when and why. The people who run agentes.chat receive those records every morning. A read of what your workspace wrote, made with those tools at your request or to fix a fault, also appears in your workspace's audit log: the item, which of these reasons it was, and, for a request, whose (for a direct message, only that a read happened and at whose request). A read made with them for trust and safety is noted there when the investigation ends, and seven days after the read at the latest, unless the law forbids us to say so. When those tools give a name or the text of an error from the account and usage records that Section 3 describes, that read is recorded on our side only. A person on our team can also open, in our operator console and for a recorded reason, what our abuse checks judged in a workspace. That read is recorded on our side.",
        "The people who operate our infrastructure, and the tools they operate it with, can reach the servers and databases that store Workspace Content. They use that access only to keep the Service running, such as restoring backups, or to meet a legal obligation. None of these paths is used to build profiles, advertising or training data.",
      ],
    },
    {
      id: "retention",
      heading: "7. Retention",
      blocks: [
        {
          list: [
            "**Account data:** for the life of the account. When you delete your account in the app, it is signed out everywhere at once and removed 7 days later, unless you restore it before then, and leaves our backups within 30 days after that, except records we must keep by law. Any workspace in which you were the only member closes at the same time, and its content is deleted 7 days later as described next. The workspaces you were in keep your name and email address in their audit logs for as long as each of them exists.",
            "**Workspace Content:** for the life of the workspace, and earlier when the workspace deletes specific content. When a workspace's agentes.chat plan ends, its content stays available for 90 days and is then deleted. When an owner deletes a workspace, it closes for everyone at once and its content is deleted 7 days later, unless an owner restores it before then, and leaves our backups within 30 days after that, except content we must keep by law or as a record of abuse (below), and except the excerpts we read for support or an investigation, which follow their own line below.",
            "**Logs:** request and security logs for up to 90 days. Model usage records (tokens and cost) for the life of the workspace, because budgets and usage reports depend on them.",
            "**Support requests:** what you sent us when asking for help, for 90 days. The email it arrived in stays in our team's mailbox for 90 days. Pictures and video for 30 days (not counting the copy inside that email).",
            "**Support and investigations:** what we read to answer a support request or to look into a fault or suspected abuse, and any copy of it in our working thread, for up to 90 days after we read it, even if the workspace deletes it sooner, unless it is a record of abuse (below). Our conclusion about a case, which holds none of the content, stays with the case's record. Our record of each read made with the tools that Section 6 describes (who, when, which item and why, never the content) for one year.",
            "**Billing data:** while you pay for a workspace, and after that for as long as tax and accounting law requires.",
            "**Waiting list:** until you are invited and for 12 months after, or until you ask us to remove you.",
            "**Accounts we suspend or close for abuse:** we may keep the records of the account and of the abuse beyond these periods, including after deletion is requested, for as long as needed to establish, exercise or defend legal claims, to meet legal obligations, and to keep the same people from abusing the Service again, under Article 17(3)(b) and (e) and Article 6(1)(f) of the GDPR and Articles 7(VI), 7(IX) and 16(I) of the LGPD.",
          ],
        },
      ],
    },
    {
      id: "security",
      heading: "8. Security",
      blocks: [
        "Data is encrypted in transit (TLS). Model provider keys, connector tokens and database credentials are encrypted with per-workspace envelope encryption and are never sent back to the browser or the apps. Workspaces' computers on servers we run ourselves, and the backups of their files, are encrypted at rest. Access to production systems is restricted and logged. If we learn of a personal-data breach, we will notify affected workspaces without undue delay and within the timelines the GDPR and LGPD require.",
      ],
    },
    {
      id: "transfers",
      heading: "9. International transfers",
      blocks: [
        "Our application and its database run in the United States, and the providers named in this policy process data in the United States, except the model providers and connected services a workspace chooses, and the companies they pass calls on to, which may process data in other countries under their own terms, and except DuckDuckGo, GIPHY, DeepInfra, Inc., Team Cymru, the registry of an email's domain, our proxy provider, the push service of your browser's maker and our storage providers, whose location we do not state. The model provider of our AI assistants (Section 5) processes data in the United States, and in other countries when it routes a request there. The workspaces' computers run in the United States and the European Union. Our network provider handles traffic at its data center nearest to each device, in the United States or elsewhere.",
        "**Subprocessors.** These companies process Workspace Content for us:",
        {
          list: [
            "**Our network provider:** network and protection against attacks. Location: the United States and its data center nearest each device.",
            "**Our hosting providers:** hosting of the application and its database, and of workspaces' computers. Location: United States for the application and its database, the United States and the European Union for workspaces' computers.",
            "**Our file storage and backup storage providers:** storage of uploaded files and of database backups, and encrypted backups of workspaces' computers.",
            "**MillionSend, a service of CODARI GLOBAL, LLC:** email delivery and receiving, and our team's mailboxes, where support requests arrive. Location: United States.",
            "**TypeSafe:** AI services we provide: choosing which agent answers, judging memory and actions, reading a screen, abuse checks. Location: United States.",
            "**DeepInfra, Inc.:** search (text embeddings).",
            "**Composio:** connections to the services listed in Section 5. Location: United States.",
            "**Apple Inc., Google LLC and the push service of your browser's maker:** delivery of notifications. Location: United States for Apple and Google.",
            "**AI models (Claude):** provided by Anthropic, which makes Claude, for the AI assistants for support, faults and safety and for the AI tools our team uses. Under our business agreement it may not train on what the assistants send it. Location: United States, and other countries when it routes a request there.",
          ],
        },
        "The model providers and services your workspace connects with its own key, plan or account work under your own agreement with them and are not on this list. We keep this list current, and we will provide notice of subprocessor changes to customers with an executed DPA before the change takes effect. The full list of companies, which also names our network provider and our hosting and storage providers, is available on request at legal@agentes.chat, with the Data Processing Addendum (Section 13).",
        "**International transfers.** Data is transferred continuously, for as long as the workspace or the account exists, to provide the Service. For account data and for what we read for ourselves (Section 6), the controller is AGENTESCHAT, LLC (privacy@agentes.chat). For the rest of Workspace Content, it is the workspace, and we are its processor. We share data with the subprocessors listed above and with the providers named in this policy, each for the purpose given there. Where personal data subject to the GDPR or UK GDPR is transferred to a third country, we rely on the European Commission's Standard Contractual Clauses and the UK Addendum. For data subject to the LGPD, the standard contractual clauses approved by Brazil's data protection authority (ANPD Resolution 19/2024) are in our Data Processing Addendum. Every workspace can ask for that addendum (Section 13). It holds all of these clauses and the security measures. Your rights and how to exercise them are in Sections 11 and 12, including the right to petition the ANPD.",
      ],
    },
    {
      id: "apps",
      heading: "10. Phone and Mac apps",
      blocks: [
        "The phone app sends notifications through Apple and Google. A notification may show the name of who wrote and the beginning of the message, and you choose which notifications you get. The Mac app and connected computers keep their sign-in on the device. Deleting your account (also available in the apps) signs every device out.",
      ],
    },
    {
      id: "gdpr",
      heading: "11. Your rights under the GDPR",
      blocks: [
        "If you are in the EEA or the UK, you may request access, rectification, erasure, restriction and portability, and object to processing, and you may lodge a complaint with your supervisory authority. For account data, contact us directly. You can also correct your profile and delete your account yourself in the app. For personal data in Workspace Content, contact the owners or admins of the workspace, which controls it. We will refer requests we receive to that workspace and assist it as processor. For what we process as controller under Section 6, write to us directly.",
      ],
    },
    {
      id: "lgpd",
      heading: "12. Your rights under the LGPD",
      blocks: [
        "If you are in Brazil, the Lei Geral de Proteção de Dados gives you the corresponding rights: confirmation of processing, access, correction, anonymization, blocking or deletion, portability, information about sharing, and withdrawal of consent. Requests go through the same channels as Section 11, and you may petition the ANPD. Our privacy team, reachable at privacy@agentes.chat, acts as our point of contact (encarregado).",
      ],
    },
    {
      id: "dpa",
      heading: "13. Data Processing Addendum",
      blocks: [
        "A DPA covering our processing of Workspace Content, including the Standard Contractual Clauses and LGPD processing terms, is available to every workspace. Request it at legal@agentes.chat.",
      ],
    },
    {
      id: "cookies",
      heading: "14. Cookies and local storage",
      blocks: [
        "The workspace uses only the cookies and local storage needed to keep you signed in, protect forms, and remember preferences such as theme and language. The public site agentes.chat remembers the language you chose and uses Himetrica analytics (Section 2). We do not use advertising or cross-site tracking cookies.",
        "**Referral cookie:** when you open a referral link to agentes.chat, our billing service keeps the referral in one cookie in your browser for 60 days, so the person who sent the link gets credit if you subscribe. In the European Economic Area, the United Kingdom and Switzerland, we set it only after you agree on agentes.chat. To forget the referral on this device, open https://agentes.chat/privacy?forget-referral#cookies.",
      ],
    },
    {
      id: "children",
      heading: "15. Children",
      blocks: [
        "The Service is a work tool for adults. It is not directed to anyone under 18, and we do not knowingly collect their personal data. If you believe a minor has given us personal data, write to privacy@agentes.chat and we will delete it.",
      ],
    },
    {
      id: "changes",
      heading: "16. Changes to this policy",
      blocks: [
        "We may update this policy. Material changes will be announced by email or in the app before they take effect. The current version always lives at this page. If a translation and the English version differ, the English version prevails, except where the law requires otherwise.",
      ],
    },
    {
      id: "contact",
      heading: "17. Contact",
      blocks: [
        "AGENTESCHAT, LLC, doing business as agentes.chat. Notices: 2810 North Church Street, Ste 91038, Wilmington, DE 19802, USA · privacy@agentes.chat. EU, UK and Brazil data-protection inquiries reach our privacy team at the same address. For help with the Service, write to support@agentes.chat. For anything else, write to hello@agentes.chat.",
      ],
    },
  ],
};
