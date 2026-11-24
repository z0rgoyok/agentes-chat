//! Workspaces across servers (ADR 0154): every server of the list, read with that server's own session (the
//! cookies the main window keeps for it, `sent_to`), the way the phone app asks (no `Origin`,
//! `X-Agentes-Client: mobile`), in one request: every account signed in on the window with its workspaces and their
//! unread counts (`GET /api/app/device-accounts`, ADR 0183; a server from before it answers `GET /api/app/me` and
//! `GET /api/app/me/unread`). Each server is asked every minute while the main window shows and every five minutes
//! while it is hidden, each wait a little off so apps opened together don't ask together; the server open in the
//! window every five minutes either way, since its page keeps its own counts live. The site's workspace menu lists
//! them by server (`this_mac` `workspaces`), Preferences › Servers shows them under each server, and a server not open
//! in the window that has new unread notifications says so with the system's notification, named after the workspace
//! and server. An account the window isn't on tells its new notifications the same way.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Url};

use crate::{main_window, servers};

/// How often a server is asked while the main window shows.
const EVERY: Duration = Duration::from_secs(60);
/// How often while it is hidden, and for the server open in it.
const EVERY_HIDDEN: Duration = Duration::from_secs(5 * 60);
/// Each wait is this share longer or shorter, at random.
const JITTER: f64 = 0.15;
/// Preferences and the welcome window ask for a fresh list when a server's answer is older than this.
const STALE: Duration = Duration::from_secs(30);
const TIMEOUT: Duration = Duration::from_secs(10);
/// Workspaces kept per server.
const MAX_ORGS: usize = 50;
/// A workspace's logo, as a data URL (larger ones show the workspace's mark instead).
const LOGO_MAX: u64 = 256 * 1024;
/// A JSON answer's size.
const BODY_MAX: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Org {
    pub id: String,
    pub name: String,
    /// A data URL; None shows the workspace's mark.
    pub logo: Option<String>,
    pub unread: u64,
    pub waiting: u64,
    /// The person may pair a computer with it (`pair_computers`): Preferences and the sign-in's card offer this one.
    pub pair: bool,
}

/// One of a server's accounts signed in on the window (ADR 0183), with its workspaces.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub user_id: String,
    pub name: String,
    pub email: String,
    /// The account the window is on at that server.
    pub current: bool,
    pub orgs: Vec<Org>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerWorkspaces {
    pub server: String,
    /// Its session in the window's cookies still answers; false lists no workspace (sign in there again).
    pub signed_in: bool,
    pub orgs: Vec<Org>,
    /// Every account signed in there, the window's own first (ADR 0183); empty from a server that names none.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub accounts: Vec<Account>,
    /// It didn't answer (offline, an error) since this time (Unix milliseconds): what it said last stays, marked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offline_since: Option<u64>,
    /// The server the app runs on this computer (at its local or its Tailscale address): named as such, never by it.
    pub here: bool,
    /// Agents of its workspaces may work on this computer (`main_window::agents_here`, and no server here answers as it).
    pub agents_here: bool,
}

#[derive(Default)]
pub struct Workspaces(Mutex<State>);

#[derive(Default)]
struct State {
    /// The last answer of each server, in the list's order.
    list: Vec<ServerWorkspaces>,
    /// Logos already read, by their address (None: none to show).
    logos: HashMap<String, Option<String>>,
    /// When each server was last asked, answered or not.
    asked: HashMap<String, Instant>,
    /// Servers open in the window since their last answer: what came meanwhile was the page's to tell.
    open_since: HashSet<String>,
    /// Wakes the loop; `true` asks every server now, `false` the ones due.
    wake: Option<mpsc::Sender<bool>>,
}

fn lock(app: &AppHandle) -> std::sync::MutexGuard<'_, State> {
    app.state::<Workspaces>().inner().0.lock().unwrap_or_else(|e| e.into_inner())
}

/// The workspaces of every server, as last read (the site's own server included).
pub fn list(app: &AppHandle) -> Vec<ServerWorkspaces> {
    lock(app).list.clone()
}

/// Some server's answer is older than `STALE`, or it was never asked.
pub fn stale(app: &AppHandle) -> bool {
    let servers = servers::get(app).servers;
    let state = lock(app);
    servers.iter().any(|s| state.asked.get(s).map_or(true, |at| at.elapsed() > STALE))
}

/// No server read yet: the loop's first pass ran before the main window existed (there were no cookies to read).
pub fn never_read(app: &AppHandle) -> bool {
    lock(app).asked.is_empty()
}

/// Every server read now, on the caller's thread (never a command's or an event handler's: Windows deadlocks).
pub fn refresh_now(app: &AppHandle) {
    refresh(app, true);
}

/// Asks every server again now (the loop does it on its own thread).
pub fn trigger(app: &AppHandle) {
    wake(app, true);
}

fn wake(app: &AppHandle, all: bool) {
    if let Some(wake) = lock(app).wake.as_ref() {
        let _ = wake.send(all);
    }
}

/// The window came to the front: the servers whose answer is older than the cadence of a shown window are asked.
pub fn on_focus(app: &AppHandle) {
    wake(app, false);
}

/// The windows hear that the list changed (the popover offers this computer to a workspace it doesn't work for yet).
pub const CHANGED_EVENT: &str = "workspaces://changed";

/// The loop: a pass about every minute, asking the servers that are due (`due`), or when woken. Reading cookies needs
/// a thread of its own (it waits for the web view, and deadlocks on Windows from a command or an event handler).
pub fn start(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<bool>();
    lock(app).wake = Some(tx);
    let app = app.clone();
    std::thread::spawn(move || {
        let mut all = true;
        loop {
            refresh(&app, all);
            all = match rx.recv_timeout(jittered(EVERY, random())) {
                Ok(all) => all,
                Err(mpsc::RecvTimeoutError::Timeout) => false,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            };
            // Several wakes at once ask once.
            while let Ok(more) = rx.try_recv() {
                all |= more;
            }
        }
    });
}

/// `every`, up to `JITTER` longer or shorter: `unit` (0 to 1) picks where.
fn jittered(every: Duration, unit: f64) -> Duration {
    every.mul_f64(1.0 - JITTER + 2.0 * JITTER * unit.clamp(0.0, 1.0))
}

/// A number from 0 to 1 from the system's random source; the middle when it has none.
fn random() -> f64 {
    let mut bytes = [0u8; 4];
    match getrandom::fill(&mut bytes) {
        Ok(()) => f64::from(u32::from_le_bytes(bytes)) / f64::from(u32::MAX),
        Err(_) => 0.5,
    }
}

/// Whether a pass asks a server whose last answer is `age` old (None: never asked): once it is about as old as its
/// cadence (`EVERY` while the window shows, `EVERY_HIDDEN` while it doesn't, and for the server open in it). Half a
/// pass early counts: passes come about every `EVERY`, never exactly on time.
pub fn due(age: Option<Duration>, shown: bool, open: bool) -> bool {
    let every = if shown && !open { EVERY } else { EVERY_HIDDEN };
    age.is_none_or(|age| age + EVERY / 2 >= every)
}

/// The servers due now (`due`), or every one (`all`); new unread notifications on a server not open in the window
/// are told.
fn refresh(app: &AppHandle, all: bool) {
    // The cookies are the main window's: before it was ever opened (started at login) there is nothing to read.
    let Some(page) = app.get_webview(main_window::LABEL) else { return };
    let open = page.url().ok().map(|u| u.origin().ascii_serialization());
    let shown = app
        .get_window(main_window::LABEL)
        .is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false));
    let file = servers::get(app);
    let (mut logos, asked, open_since) = {
        let state = lock(app);
        (state.logos.clone(), state.asked.clone(), state.open_since.clone())
    };
    let asking: Vec<&String> = file
        .servers
        .iter()
        .filter(|s| all || due(asked.get(*s).map(Instant::elapsed), shown, open.as_deref() == Some(s.as_str())))
        .collect();
    if asking.is_empty() {
        return;
    }
    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).redirects(0).build();
    let home = app.path().home_dir().ok();
    let before = list(app);
    let mut next = Vec::with_capacity(file.servers.len());
    // Read once for every server, and never with Tauri's own read (cookies.rs: it stops the app on macOS).
    let window_cookies = crate::cookies::read(&page);
    for server in &file.servers {
        let old = before.iter().find(|s| &s.server == server);
        if !asking.contains(&server) {
            next.extend(old.cloned());
            continue;
        }
        let Ok(url) = server.parse::<Url>() else { continue };
        let cookie = cookie_header(window_cookies.iter().filter(|c| sent_to(*c, &url)).map(|c| (c.name(), c.value())));
        let here = crate::local_server::is_here(app, server);
        let agents_here = main_window::agents_here(server, here)
            && home.as_ref().is_some_and(|h| !crate::discover::served_here(h, server));
        match ask(&agent, server, &cookie, &mut logos) {
            Some(answer) => next.push(ServerWorkspaces { here, agents_here, ..answer }),
            // Not reached (offline, an error): what it said last stays, marked since when.
            None => {
                if let Some(old) = old {
                    next.push(ServerWorkspaces { here, agents_here, ..unreachable(old, now_ms()) });
                }
            }
        }
    }
    let changed = next != before;
    // With no page, nothing is told.
    let quiet: Vec<&str> = match open.as_deref() {
        Some(now) => std::iter::once(now).chain(open_since.iter().map(String::as_str)).collect(),
        None => Vec::new(),
    };
    let told = news(&before, &next, &quiet);
    let told_accounts = account_news(&before, &next);
    {
        let mut state = lock(app);
        state.list = next;
        state.logos = logos;
        let now = Instant::now();
        for server in asking {
            state.asked.insert(server.clone(), now);
            if open.as_ref() != Some(server) {
                state.open_since.remove(server);
            }
        }
        state.asked.retain(|s, _| file.servers.contains(s));
        state.open_since.extend(open);
    }
    for (server, org, count) in told {
        tell(app, &server, &org, count, None);
    }
    for (server, account, org, count) in told_accounts {
        tell(app, &server, &org, count, Some(&account));
    }
    if changed {
        let _ = app.emit(CHANGED_EVENT, ());
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A server that didn't answer: its last answer, offline since the first time it didn't.
pub fn unreachable(last: &ServerWorkspaces, now: u64) -> ServerWorkspaces {
    ServerWorkspaces { offline_since: last.offline_since.or(Some(now)), ..last.clone() }
}

/// One server: signed out (no session, or it refused it) lists nothing; None when it couldn't be reached.
fn ask(agent: &ureq::Agent, server: &str, cookie: &str, logos: &mut HashMap<String, Option<String>>) -> Option<ServerWorkspaces> {
    let signed_out = ServerWorkspaces { server: server.to_string(), signed_in: false, ..Default::default() };
    if cookie.is_empty() {
        return Some(signed_out);
    }
    // Every account signed in on the window, its own first with its workspaces and their counts: one request.
    if let Ok(Some(listed)) = get_json(agent, &format!("{server}/api/app/device-accounts"), cookie) {
        if listed.get("accounts").is_some_and(Value::is_array) {
            let accounts = parse_accounts(&listed);
            let Some(own) = accounts.iter().find(|a| a.current) else { return Some(signed_out) };
            let orgs = with_logos(agent, server, cookie, logos, own.orgs.clone(), &own.counts);
            return Some(signed_in(server, orgs, accounts));
        }
    }
    // A server from before ADR 0183 (no `/device-accounts`): the window's own account only.
    let me = match get_json(agent, &format!("{server}/api/app/me"), cookie) {
        Ok(Some(me)) => me,
        Ok(None) => return Some(signed_out),
        Err(()) => return None,
    };
    // A server from before ADR 0154 has no `/me/unread`: its workspaces show without counts.
    let unread = get_json(agent, &format!("{server}/api/app/me/unread"), cookie).ok().flatten();
    let counts = unread.as_ref().map(parse_unread).unwrap_or_default();
    let orgs = with_logos(agent, server, cookie, logos, parse_me(&me), &counts);
    Some(signed_in(server, orgs, Vec::new()))
}

/// A server's workspaces with their counts and logos (read from that server once per address).
fn with_logos(
    agent: &ureq::Agent,
    server: &str,
    cookie: &str,
    logos: &mut HashMap<String, Option<String>>,
    parsed: Vec<(String, String, Option<String>, bool)>,
    counts: &HashMap<String, (u64, u64)>,
) -> Vec<Org> {
    parsed
        .into_iter()
        .map(|(id, name, logo, pair)| {
            let (unread, waiting) = counts.get(&id).copied().unwrap_or((0, 0));
            let logo = logo.and_then(|path| logo_data(agent, server, &path, cookie, logos));
            Org { id, name, logo, unread, waiting, pair }
        })
        .collect()
}

/// A signed-in server: the window's own workspaces (`orgs`), and every account signed in there.
fn signed_in(server: &str, orgs: Vec<Org>, listed: Vec<ListedAccount>) -> ServerWorkspaces {
    let accounts = listed
        .into_iter()
        .map(|a| {
            // The window's own account: its workspaces as read above, logos included. Another one's logos are its
            // own session's to read, so they show the workspace's mark.
            let theirs = if a.current {
                orgs.clone()
            } else {
                a.orgs
                    .into_iter()
                    .map(|(id, name, _, pair)| {
                        let (unread, waiting) = a.counts.get(&id).copied().unwrap_or((0, 0));
                        Org { id, name, logo: None, unread, waiting, pair }
                    })
                    .collect()
            };
            Account { user_id: a.user_id, name: a.name, email: a.email, current: a.current, orgs: theirs }
        })
        .collect();
    ServerWorkspaces { server: server.to_string(), signed_in: true, orgs, accounts, ..Default::default() }
}

/// Who the main window is signed in as on `server` (the account's id), read with its cookies there as the minute's
/// check does; None when signed out there or it didn't answer. Not from a command or an event handler (Windows).
pub fn window_user(app: &AppHandle, server: &str) -> Option<String> {
    let page = app.get_webview(main_window::LABEL)?;
    let url = server.parse::<Url>().ok()?;
    let cookies: Vec<_> = crate::cookies::read(&page).into_iter().filter(|c| sent_to(c, &url)).collect();
    let cookie = cookie_header(cookies.iter().map(|c| (c.name(), c.value())));
    if cookie.is_empty() {
        return None;
    }
    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).redirects(0).build();
    let me = get_json(&agent, &format!("{server}/api/app/me"), &cookie).ok()??;
    me.pointer("/user/id").and_then(Value::as_str).map(str::to_string)
}

/// The answer as JSON; Ok(None) when the session isn't (any longer) signed in there.
fn get_json(agent: &ureq::Agent, url: &str, cookie: &str) -> Result<Option<Value>, ()> {
    match agent.get(url).set("Cookie", cookie).set("X-Agentes-Client", "mobile").set("Accept", "application/json").call() {
        Ok(response) => {
            let mut text = String::new();
            response.into_reader().take(BODY_MAX).read_to_string(&mut text).map_err(|_| ())?;
            serde_json::from_str(&text).map(Some).map_err(|_| ())
        }
        Err(ureq::Error::Status(401 | 403, _)) => Ok(None),
        Err(_) => Err(()),
    }
}

/// A workspace's logo from its own server, as a data URL, read once per address.
fn logo_data(
    agent: &ureq::Agent,
    server: &str,
    path: &str,
    cookie: &str,
    logos: &mut HashMap<String, Option<String>>,
) -> Option<String> {
    let base: Url = server.parse().ok()?;
    let url = base.join(path).ok()?;
    // Only from that server: a logo address never sends its cookies anywhere else.
    if url.origin() != base.origin() {
        return None;
    }
    if let Some(known) = logos.get(url.as_str()) {
        return known.clone();
    }
    let read = || -> Option<String> {
        let response = agent.get(url.as_str()).set("Cookie", cookie).set("X-Agentes-Client", "mobile").call().ok()?;
        let kind = response.content_type().to_string();
        if !kind.starts_with("image/") || kind.contains(';') || kind.contains('"') {
            return None;
        }
        let mut bytes = Vec::new();
        response.into_reader().take(LOGO_MAX + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() as u64 > LOGO_MAX {
            return None;
        }
        Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    };
    let logo = read();
    logos.insert(url.to_string(), logo.clone());
    logo
}

/// Whether the window's cookie goes with a request to `url`. Not wry's `cookies_for_url`: it compares the cookie's
/// domain with `Url::domain`, which is None for an IP address, so the server on this computer
/// (`http://127.0.0.1:4310`) got no cookie, read as signed out and left the site's workspace menu.
pub fn sent_to<C: CookieLike>(cookie: &C, url: &Url) -> bool {
    cookie_for(cookie.domain_of(), cookie.secure_of(), cookie.path_of(), url)
}

/// The cookie crate's `Cookie`, as `sent_to` reads it (a trait so the rule is tested without a web view).
pub trait CookieLike {
    fn domain_of(&self) -> Option<&str>;
    fn secure_of(&self) -> bool;
    fn path_of(&self) -> Option<&str>;
}

impl CookieLike for tauri::webview::Cookie<'_> {
    fn domain_of(&self) -> Option<&str> {
        self.domain()
    }
    fn secure_of(&self) -> bool {
        self.secure().unwrap_or(false)
    }
    fn path_of(&self) -> Option<&str> {
        self.path()
    }
}

/// The browser's rule, enough for our servers: the same host (an IP address too) or a parent domain the cookie names
/// (".example.com"), a path the request's starts with, and a secure cookie only over https or on this computer.
pub fn cookie_for(domain: Option<&str>, secure: bool, path: Option<&str>, url: &Url) -> bool {
    let (Some(host), Some(domain)) = (url.host_str(), domain) else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    let host_ok = host == domain || (url.domain().is_some() && host.ends_with(&format!(".{domain}")));
    let here = host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    let secure_ok = !secure || url.scheme() == "https" || here;
    let path_ok = path.is_none_or(|p| p.is_empty() || url.path().starts_with(p));
    host_ok && secure_ok && path_ok
}

/// The `Cookie` header for a server from the window's cookies for it.
pub fn cookie_header<'a>(cookies: impl Iterator<Item = (&'a str, &'a str)>) -> String {
    cookies
        .filter(|(name, value)| !name.is_empty() && !format!("{name}{value}").chars().any(|c| c.is_control() || c == ';'))
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// An id the app passes on (`orgId` in main_window.rs): letters, digits, `-` and `_`.
pub(crate) fn good_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The workspaces of `GET /api/app/me`: id, name, logo address and whether the person may pair a computer with it,
/// those still being set up left out.
pub fn parse_me(me: &Value) -> Vec<(String, String, Option<String>, bool)> {
    let Some(orgs) = me.get("organizations").and_then(Value::as_array) else { return vec![] };
    orgs.iter()
        .filter(|o| o.get("onboarding").map_or(true, Value::is_null))
        .filter_map(|o| {
            let id = o.get("id")?.as_str()?;
            let name: String = o.get("name")?.as_str()?.trim().chars().take(80).collect();
            if !good_id(id) || name.is_empty() || name.chars().any(char::is_control) {
                return None;
            }
            let logo = o.get("logo").and_then(Value::as_str).filter(|l| l.len() <= 1024).map(str::to_string);
            let pair = o
                .get("permissions")
                .and_then(Value::as_array)
                .is_some_and(|keys| keys.iter().any(|k| k == "pair_computers"));
            Some((id.to_string(), name, logo, pair))
        })
        .take(MAX_ORGS)
        .collect()
}

/// An account of `GET /api/app/device-accounts` (ADR 0183), as read: who it is, whether the window is on it, its
/// workspaces (as `parse_me` reads them) and their counts.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ListedAccount {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub current: bool,
    pub orgs: Vec<(String, String, Option<String>, bool)>,
    pub counts: HashMap<String, (u64, u64)>,
}

/// Accounts kept per server (a browser keeps five signed in).
const MAX_ACCOUNTS: usize = 8;

/// The accounts of `GET /api/app/device-accounts`: one with a bad id, no name or no address is left out.
pub fn parse_accounts(body: &Value) -> Vec<ListedAccount> {
    let Some(accounts) = body.get("accounts").and_then(Value::as_array) else { return vec![] };
    accounts
        .iter()
        .filter_map(|a| {
            let user = a.get("user")?;
            let user_id = user.get("id")?.as_str()?;
            let name: String = user.get("name")?.as_str()?.trim().chars().take(80).collect();
            let email: String = user.get("email")?.as_str()?.trim().chars().take(254).collect();
            let clean = |text: &str| !text.is_empty() && !text.chars().any(char::is_control);
            if !good_id(user_id) || !clean(&name) || !clean(&email) || email.contains(char::is_whitespace) {
                return None;
            }
            Some(ListedAccount {
                user_id: user_id.to_string(),
                name,
                email,
                current: a.get("current").and_then(Value::as_bool).unwrap_or(false),
                orgs: parse_me(a),
                counts: counts_of(a.get("unread")),
            })
        })
        .take(MAX_ACCOUNTS)
        .collect()
}

/// `GET /api/app/me/unread`: unread and waiting by workspace.
pub fn parse_unread(body: &Value) -> HashMap<String, (u64, u64)> {
    counts_of(body.get("organizations"))
}

/// A list of `{ orgId, unread, waiting }` as counts by workspace.
fn counts_of(list: Option<&Value>) -> HashMap<String, (u64, u64)> {
    list.and_then(Value::as_array)
        .map(|orgs| {
            orgs.iter()
                .filter_map(|o| {
                    let id = o.get("orgId")?.as_str()?;
                    let count = |key: &str| o.get(key).and_then(Value::as_u64).unwrap_or(0).min(100_000);
                    good_id(id).then(|| (id.to_string(), (count("unread"), count("waiting"))))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// What's new since the last check, to tell: on a server other than the ones open in the window since their last
/// answer (`quiet`: their counts were the page's to tell; empty, with no page, none is told), each workspace whose
/// unread count grew, with how many more. A workspace or server seen for the first time tells nothing (its count
/// isn't news).
pub fn news(before: &[ServerWorkspaces], after: &[ServerWorkspaces], quiet: &[&str]) -> Vec<(String, Org, u64)> {
    if quiet.is_empty() {
        return vec![];
    }
    let mut told = Vec::new();
    // The account the window is on at a server (ADR 0183); None from a server that names none.
    let on = |s: &ServerWorkspaces| s.accounts.iter().find(|a| a.current).map(|a| a.user_id.clone());
    for now in after.iter().filter(|s| !quiet.contains(&s.server.as_str()) && s.signed_in) {
        let Some(then) = before.iter().find(|s| s.server == now.server && s.signed_in) else { continue };
        // The window moved to another account there: its workspaces are another person's, not news.
        if on(now) != on(then) {
            continue;
        }
        for org in &now.orgs {
            if let Some(old) = then.orgs.iter().find(|o| o.id == org.id) {
                if org.unread > old.unread {
                    told.push((now.server.clone(), org.clone(), org.unread - old.unread));
                }
            }
        }
    }
    told
}

/// What's new on the accounts the window isn't on (ADR 0183), on any server, the one open included: each workspace
/// whose unread count grew, with whose account it is and how many more. An account or workspace seen for the first
/// time tells nothing. The account the window is on at a server is `news`'s (or the page's own, on the one open).
pub fn account_news(before: &[ServerWorkspaces], after: &[ServerWorkspaces]) -> Vec<(String, String, Org, u64)> {
    let mut told = Vec::new();
    for now in after.iter().filter(|s| s.signed_in) {
        let Some(then) = before.iter().find(|s| s.server == now.server && s.signed_in) else { continue };
        for account in now.accounts.iter().filter(|a| !a.current) {
            let Some(old_account) = then.accounts.iter().find(|a| a.user_id == account.user_id) else { continue };
            for org in &account.orgs {
                if let Some(old) = old_account.orgs.iter().find(|o| o.id == org.id) {
                    if org.unread > old.unread {
                        told.push((now.server.clone(), account.user_id.clone(), org.clone(), org.unread - old.unread));
                    }
                }
            }
        }
    }
    told
}

/// How a server is named to people: agentes.chat for the Cloud, the app's own server by what it is (never its
/// local or Tailscale address), its host otherwise.
pub fn server_name(server: &str, cloud_name: &str, here_name: Option<&str>) -> String {
    if server == servers::CLOUD {
        return cloud_name.to_string();
    }
    if let Some(name) = here_name {
        return name.to_string();
    }
    // Host and port, as the site names it (`serverHost`): two servers on one computer stay apart.
    let named = |u: Url| u.host_str().map(|h| u.port().map_or_else(|| h.to_string(), |p| format!("{h}:{p}")));
    server.parse::<Url>().ok().and_then(named).unwrap_or_else(|| server.to_string())
}

/// The notification's words: "Workspace · server" and "1 new notification" / "3 new notifications" (the
/// popover's labels, in the app's language; nothing is told before they arrived). `here`: the app's own server.
pub fn notice_text(
    labels: &HashMap<String, String>,
    server: &str,
    here: bool,
    org: &str,
    count: u64,
) -> Option<(String, String)> {
    let cloud = labels.get("serversCloud")?;
    let body = if count == 1 { labels.get("workspaceNewsOne")? } else { labels.get("workspaceNewsMany")? };
    let here_name = if here { Some(labels.get("serverTitle")?.as_str()) } else { None };
    let title: String = format!("{org} · {}", server_name(server, cloud, here_name)).chars().take(80).collect();
    Some((title, body.replace("{count}", &count.to_string())))
}

/// `account`: the account it belongs to, when the window isn't on it (the address says which, `?as=`).
fn tell(app: &AppHandle, server: &str, org: &Org, count: u64, account: Option<&str>) {
    let labels = crate::menus::labels(app);
    let here = crate::local_server::is_here(app, server);
    let Some((title, body)) = notice_text(&labels, server, here, &org.name, count) else { return };
    let query = account.map(|id| format!("?as={id}")).unwrap_or_default();
    let Ok(url) = format!("{server}/org/{}/notifications{query}", org.id).parse::<Url>() else { return };
    main_window::notice(app, &title, &body, url);
}

/// Preferences › Servers, the popover and the welcome window's "Add a workspace": every server's workspaces (the
/// app's own windows only). Preferences and the welcome window, opened by a person, have them read again when some
/// answer is stale; the popover reads them when they changed, and asking again from there would read the server
/// open in the window at every change of another's.
#[tauri::command]
pub fn workspaces_get(app: AppHandle, window: tauri::Window) -> Result<Vec<ServerWorkspaces>, String> {
    if !matches!(window.label(), "prefs" | "popover" | "welcome") {
        return Err("only the app's own windows ask this".into());
    }
    if window.label() != "popover" && stale(&app) {
        trigger(&app);
    }
    Ok(list(&app))
}

/// What the app's own windows may ask a server with its session (`site_fetch`): this computer's devices and who can
/// use them, a phone's Stop, the workspace's people and roles for the rule's picker, and confirming the code of this
/// computer's own runner (the person allowed it in the app's card or the system's dialog). Nothing else.
pub fn site_path_allowed(method: &str, path: &str) -> bool {
    if path.len() > 512 || path.contains(['?', '#', '%', '\\']) {
        return false;
    }
    // Whether the person has a password (Preferences' "Add a password" note on the server here).
    if method == "GET" && path == "/api/app/me" {
        return true;
    }
    let parts: Vec<&str> = path.split('/').collect();
    let ["", "api", "app", "organizations", org, rest @ ..] = parts.as_slice() else { return false };
    good_id(org)
        && match (method, rest) {
            ("GET", ["devices" | "members" | "roles"]) => true,
            ("PATCH", ["devices", "computers" | "phones", id]) => good_id(id),
            ("POST", ["devices", "phones", id, "stop"]) => good_id(id),
            ("POST", ["machines", "device", code, "confirm"]) => {
                (4..=16).contains(&code.len()) && code.chars().all(|c| c.is_ascii_alphanumeric())
            }
            _ => false,
        }
}

/// A request body's size (a device's rule with its people).
const SITE_BODY_MAX: usize = 64 * 1024;

#[derive(Debug, Serialize)]
pub struct SiteAnswer {
    pub status: u16,
    pub body: String,
}

/// One request to `server` (a server of the app's list) with the main window's session for it, the way the phone
/// app asks. Blocking: reading the cookies waits for the web view, so never from a command's or an event's own thread.
pub fn with_session(
    app: &AppHandle,
    server: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<SiteAnswer, String> {
    if !servers::get(app).servers.iter().any(|s| s == server) {
        return Err("not a server of this app".into());
    }
    if !site_path_allowed(method, path) || body.is_some_and(|b| b.len() > SITE_BODY_MAX) {
        return Err("not allowed".into());
    }
    let url: Url = format!("{server}{path}").parse().map_err(|_| "bad address")?;
    let page = app.get_webview(main_window::LABEL).ok_or("signed_out")?;
    let cookies: Vec<_> = crate::cookies::read(&page).into_iter().filter(|c| sent_to(c, &url)).collect();
    let cookie = cookie_header(cookies.iter().map(|c| (c.name(), c.value())));
    if cookie.is_empty() {
        return Err("signed_out".into());
    }
    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).redirects(0).build();
    let request = agent
        .request(method, url.as_str())
        .set("Cookie", &cookie)
        .set("X-Agentes-Client", "mobile")
        .set("Accept", "application/json");
    let sent = match body {
        Some(body) => request.set("Content-Type", "application/json").send_string(body),
        None => request.call(),
    };
    let response = match sent {
        Ok(response) | Err(ureq::Error::Status(_, response)) => response,
        Err(e) => return Err(e.to_string()),
    };
    let status = response.status();
    let mut text = String::new();
    response.into_reader().take(BODY_MAX).read_to_string(&mut text).map_err(|e| e.to_string())?;
    Ok(SiteAnswer { status, body: text })
}

/// Preferences › This Mac and the welcome window's pairing card read and set this computer's devices on its server
/// (`with_session`).
#[tauri::command]
pub async fn site_fetch(
    app: AppHandle,
    window: tauri::Window,
    server: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<SiteAnswer, String> {
    if !matches!(window.label(), "prefs" | "welcome") {
        return Err("only Preferences and the welcome window ask this".into());
    }
    tauri::async_runtime::spawn_blocking(move || with_session(&app, &server, &method, &path, body.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// How the welcome window opens next, taken once: `add` when the site's "Add a workspace" opened it.
#[derive(Default)]
pub struct WelcomeMode(pub Mutex<Option<&'static str>>);

#[tauri::command]
pub fn welcome_mode_take(app: AppHandle, window: tauri::Window) -> Result<Option<String>, String> {
    if window.label() != "welcome" {
        return Err("only the welcome window asks this".into());
    }
    Ok(app.state::<WelcomeMode>().0.lock().unwrap_or_else(|e| e.into_inner()).take().map(str::to_string))
}

/// "Add a workspace…" and "Add a server…" in Preferences: the welcome window, in its adding mode.
/// Async, as `show_window`: the welcome window may be made here.
#[tauri::command]
pub async fn welcome_add(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    if window.label() != "prefs" {
        return Err("only Preferences asks this".into());
    }
    *app.state::<WelcomeMode>().0.lock().unwrap_or_else(|e| e.into_inner()) = Some("add");
    crate::present(&app, "welcome")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn org(id: &str, unread: u64) -> Org {
        Org { id: id.into(), name: id.to_uppercase(), logo: None, unread, waiting: 0, pair: false }
    }
    fn server(s: &str, signed_in: bool, orgs: Vec<Org>) -> ServerWorkspaces {
        ServerWorkspaces { server: s.into(), signed_in, orgs, ..Default::default() }
    }

    #[test]
    fn the_window_cookies_a_server_gets() {
        let url = |u: &str| u.parse::<Url>().unwrap();
        // The server on this computer, by its IP address: wry's own lookup gave it none.
        assert!(cookie_for(Some("127.0.0.1"), false, Some("/"), &url("http://127.0.0.1:4310")));
        assert!(cookie_for(Some("localhost"), true, Some("/"), &url("http://localhost:3000")));
        assert!(cookie_for(Some(".exemplo.com.br"), true, Some("/"), &url("https://agentes.exemplo.com.br")));
        assert!(cookie_for(Some("agentes.exemplo.com.br"), true, None, &url("https://agentes.exemplo.com.br/x")));
        // Another host, a secure cookie over plain http elsewhere, another path: not sent.
        assert!(!cookie_for(Some("agentes-1.tail1234.ts.net"), true, Some("/"), &url("https://agentes.tail1234.ts.net")));
        assert!(!cookie_for(Some("chat.example.com"), true, Some("/"), &url("http://chat.example.com")));
        assert!(!cookie_for(Some("127.0.0.1"), false, Some("/api/auth"), &url("http://127.0.0.1:4310/")));
        assert!(!cookie_for(None, false, Some("/"), &url("http://127.0.0.1:4310")));
        // An IP address never takes a parent domain's cookie.
        assert!(!cookie_for(Some("0.0.1"), false, Some("/"), &url("http://127.0.0.1:4310")));
    }

    #[test]
    fn a_server_that_stopped_answering() {
        let last = server("https://agentes.exemplo.com.br", true, vec![]);
        let first = unreachable(&last, 1_000);
        assert_eq!(first.offline_since, Some(1_000));
        assert!(first.signed_in, "its last answer stays");
        // Still not answering a minute later: offline since the first time.
        assert_eq!(unreachable(&first, 61_000).offline_since, Some(1_000));
    }

    #[test]
    fn workspaces_from_me() {
        let me = json!({ "organizations": [
            { "id": "o-1", "name": "  Acme ", "logo": "/api/app/org-logos/o-1/a.png", "permissions": ["post", "pair_computers"] },
            { "id": "o-2", "name": "Norte", "logo": null, "permissions": ["post"] },
            { "id": "o-3", "name": "Setting up", "onboarding": { "step": 1 } },
            { "id": "../x", "name": "Bad" },
            { "id": "o-4", "name": "" },
        ]});
        assert_eq!(
            parse_me(&me),
            vec![
                ("o-1".into(), "Acme".into(), Some("/api/app/org-logos/o-1/a.png".into()), true),
                ("o-2".into(), "Norte".into(), None, false),
            ]
        );
        assert!(parse_me(&json!({})).is_empty());
    }

    #[test]
    fn accounts_from_device_accounts() {
        let body = json!({ "accounts": [
            { "current": true, "user": { "id": "u1", "name": " Ana ", "email": "ana@example.com", "image": null },
              "organizations": [{ "id": "o-1", "name": "Acme", "logo": null, "permissions": ["pair_computers"] }],
              "unread": [{ "orgId": "o-1", "unread": 2, "waiting": 1 }] },
            { "current": false, "user": { "id": "u2", "name": "Bia", "email": "bia@example.com" },
              "organizations": [], "unread": [] },
            { "current": false, "user": { "id": "../x", "name": "Bad", "email": "bad@example.com" } },
            { "current": false, "user": { "id": "u3", "name": "", "email": "none@example.com" } },
        ]});
        let accounts = parse_accounts(&body);
        assert_eq!(accounts.len(), 2);
        assert_eq!((accounts[0].user_id.as_str(), accounts[0].name.as_str(), accounts[0].current), ("u1", "Ana", true));
        assert_eq!(accounts[0].orgs, vec![("o-1".into(), "Acme".into(), None, true)]);
        assert_eq!(accounts[0].counts.get("o-1"), Some(&(2, 1)));
        assert_eq!((accounts[1].email.as_str(), accounts[1].current), ("bia@example.com", false));
        assert!(parse_accounts(&json!({})).is_empty());
    }

    #[test]
    fn news_of_an_account_the_window_is_not_on() {
        let account = |id: &str, current: bool, unread: u64| Account {
            user_id: id.into(),
            name: id.into(),
            email: format!("{id}@example.com"),
            current,
            orgs: vec![org("o-1", unread)],
        };
        let at = |accounts: Vec<Account>| ServerWorkspaces {
            accounts,
            ..server("https://agentes.exemplo.com.br", true, vec![])
        };
        let before = vec![at(vec![account("u1", true, 1), account("u2", false, 1)])];
        let after = vec![at(vec![account("u1", true, 5), account("u2", false, 3), account("u3", false, 9)])];
        // The window's own account is told elsewhere; one seen for the first time isn't news.
        let told = account_news(&before, &after);
        assert_eq!(told.len(), 1);
        assert_eq!((told[0].1.as_str(), told[0].2.id.as_str(), told[0].3), ("u2", "o-1", 2));
    }

    #[test]
    fn counts_from_me_unread() {
        let counts = parse_unread(&json!({ "organizations": [
            { "orgId": "o-1", "unread": 3, "waiting": 1 },
            { "orgId": "../x", "unread": 9 },
            { "orgId": "o-2" },
        ]}));
        assert_eq!(counts.get("o-1"), Some(&(3, 1)));
        assert_eq!(counts.get("o-2"), Some(&(0, 0)));
        assert_eq!(counts.len(), 2);
    }

    #[test]
    fn only_the_devices_paths_go_with_the_session() {
        let org = "/api/app/organizations/o-1";
        assert!(site_path_allowed("GET", &format!("{org}/devices")));
        assert!(site_path_allowed("GET", "/api/app/me"));
        assert!(!site_path_allowed("PATCH", "/api/app/me"));
        assert!(site_path_allowed("GET", &format!("{org}/members")));
        assert!(site_path_allowed("GET", &format!("{org}/roles")));
        assert!(site_path_allowed("PATCH", &format!("{org}/devices/computers/m-1")));
        assert!(site_path_allowed("PATCH", &format!("{org}/devices/phones/p-1")));
        assert!(site_path_allowed("POST", &format!("{org}/devices/phones/p-1/stop")));
        assert!(site_path_allowed("POST", &format!("{org}/machines/device/K7Q4ZP/confirm")));
        for (method, path) in [
            ("POST", format!("{org}/machines/device/K7Q-4ZP/confirm")),
            ("POST", format!("{org}/machines/device/K7Q4ZP/deny")),
            ("GET", format!("{org}/machines/device/K7Q4ZP/confirm")),
            ("DELETE", format!("{org}/devices/computers/m-1")),
            ("POST", format!("{org}/devices/connect-links")),
            ("GET", format!("{org}/devices?x=1")),
            ("GET", format!("{org}/devices/")),
            ("PATCH", format!("{org}/devices/phones/../stop")),
            ("GET", "/api/app/organizations/../x/devices".into()),
            ("GET", format!("{org}/channels")),
            ("POST", format!("{org}/devices/phones/p%2F1/stop")),
        ] {
            assert!(!site_path_allowed(method, &path), "{method} {path}");
        }
    }

    #[test]
    fn the_cookie_header() {
        let header = cookie_header(
            [("__Secure-better-auth.session_token", "abc.def"), ("x", "a;b"), ("", "v"), ("theme", "dark")].into_iter(),
        );
        assert_eq!(header, "__Secure-better-auth.session_token=abc.def; theme=dark");
    }

    #[test]
    fn only_new_unread_elsewhere_is_told() {
        let open = "https://app.agentes.chat";
        let own = "https://agentes.exemplo.com.br";
        let before = vec![server(open, true, vec![org("a", 1)]), server(own, true, vec![org("b", 2), org("c", 5)])];
        let after = vec![
            server(open, true, vec![org("a", 9)]),
            server(own, true, vec![org("b", 4), org("c", 3), org("d", 7)]),
        ];
        let told = news(&before, &after, &[open]);
        assert_eq!(told.len(), 1, "the server open isn't told, nor fewer unread, nor a workspace seen first now");
        assert_eq!((told[0].0.as_str(), told[0].1.id.as_str(), told[0].2), (own, "b", 2));
        assert!(news(&before, &after, &[]).is_empty(), "no page: nothing told");
        // Signed in again just now: its counts aren't news.
        let signed_out = vec![server(own, false, vec![])];
        assert!(news(&signed_out, &after, &[open]).is_empty());
        // The server the window just left: what came while it was open was the page's to tell.
        assert!(news(&before, &after, &[open, own]).is_empty());
    }

    #[test]
    fn each_server_is_asked_on_its_cadence() {
        let secs = |s: u64| Some(Duration::from_secs(s));
        // Never asked: now, whatever the window does.
        assert!(due(None, false, true));
        // The window shows: a server elsewhere about every minute (a pass that comes a little early counts)...
        assert!(!due(secs(20), true, false));
        assert!(due(secs(50), true, false));
        // ...the one open in it every five minutes, as every server while the window is hidden.
        assert!(!due(secs(60), true, true));
        assert!(!due(secs(200), false, false));
        assert!(due(secs(280), false, false));
        assert!(due(secs(280), true, true));
    }

    #[test]
    fn waits_are_a_little_off_so_apps_opened_together_ask_apart() {
        let minute = Duration::from_secs(60);
        assert_eq!(jittered(minute, 0.5), minute);
        assert_eq!(jittered(minute, 0.0), Duration::from_secs(51));
        assert_eq!(jittered(minute, 1.0), Duration::from_secs(69));
        assert_eq!(jittered(minute, 7.0), Duration::from_secs(69), "kept within the jitter");
        let r = random();
        assert!((0.0..=1.0).contains(&r));
    }

    #[test]
    fn notice_words() {
        let labels: HashMap<String, String> = [
            ("serversCloud", "agentes.chat"),
            ("serverTitle", "O agentes.chat neste Mac"),
            ("workspaceNewsOne", "1 notificação nova"),
            ("workspaceNewsMany", "{count} notificações novas"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(
            notice_text(&labels, "https://agentes.exemplo.com.br", false, "Oficina", 3),
            Some(("Oficina · agentes.exemplo.com.br".into(), "3 notificações novas".into()))
        );
        assert_eq!(
            notice_text(&labels, servers::CLOUD, false, "Acme", 1),
            Some(("Acme · agentes.chat".into(), "1 notificação nova".into()))
        );
        // The app's own server by what it is, at its local or its Tailscale address alike.
        assert_eq!(
            notice_text(&labels, "https://macbook-air.tail1234.ts.net", true, "Oficina", 1),
            Some(("Oficina · O agentes.chat neste Mac".into(), "1 notificação nova".into()))
        );
        assert_eq!(notice_text(&HashMap::new(), servers::CLOUD, false, "Acme", 1), None, "before the labels arrived");
    }
}
