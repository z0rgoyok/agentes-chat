//! agentes-speech: speech to text for voice messages on the server's own computer (ADR 0100). It answers the same
//! HTTP as deploy/speech/server.py (OpenAI's `POST /v1/audio/transcriptions`, `POST /v1/warm`, `GET /health`), so
//! the core uses it as its `local` engine with warm on. The core downloads it and its models, starts it on
//! 127.0.0.1 with a key of its own, and reads the port from its first line.
//!
//! The models load on the first warm or recording and leave memory after `SPEECH_IDLE_SECONDS` without one. A
//! language Parakeet doesn't know is 422 `unsupported_language`, no words in a recording with sound 422 `no_words`,
//! a full house 503: the core's next engine takes the recording, or it goes as audio. Logs hold timings and the
//! language heard, never audio or words.

mod audio;
mod models;
mod webm;

use models::{Models, PARAKEET};
use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// -80 dBFS at the loudest: no microphone signal (a muted one, or the core's second of zeros when it tests).
const SILENCE: f32 = 1e-4;
/// The apps record up to 5 minutes, and the core takes 5 s more for the clock's slack.
const MAX_SECONDS: u32 = 305;
/// The core's VOICE_MAX_BYTES, and the multipart around it.
const MAX_BODY: usize = 25 * 1024 * 1024 + 64 * 1024;

fn env<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn log(fields: Value) {
    println!("{fields}");
}

fn failure(status: u16, code: &str, message: &str) -> (u16, Value) {
    let kind = if status >= 500 {
        "server_error"
    } else {
        "invalid_request_error"
    };
    (
        status,
        json!({ "error": { "message": message, "type": kind, "code": code } }),
    )
}

/// `workers` recordings at once and `queue` waiting; one that can't start within `wait` is told busy.
struct Gate {
    state: Mutex<(usize, usize)>,
    freed: Condvar,
    workers: usize,
    queue: usize,
    wait: Duration,
}

impl Gate {
    fn new(workers: usize, queue: usize, wait: Duration) -> Gate {
        Gate {
            state: Mutex::new((0, 0)),
            freed: Condvar::new(),
            workers: workers.max(1),
            queue,
            wait,
        }
    }

    fn enter(&self) -> bool {
        let mut s = self.state.lock().unwrap();
        if s.0 < self.workers {
            s.0 += 1;
            return true;
        }
        if s.1 >= self.queue {
            return false;
        }
        s.1 += 1;
        let (mut s, _) = self
            .freed
            .wait_timeout_while(s, self.wait, |s| s.0 >= self.workers)
            .unwrap();
        s.1 -= 1;
        if s.0 >= self.workers {
            return false;
        }
        s.0 += 1;
        true
    }

    fn leave(&self) {
        self.state.lock().unwrap().0 -= 1;
        self.freed.notify_one();
    }
}

/// What the HTTP side needs, so it can be tested without models.
trait Engine: Send + Sync {
    /// The model files are all there.
    fn ready(&self) -> bool;
    fn warm(&self);
    fn transcribe(&self, audio: &[u8]) -> (u16, Value);
}

struct Speech {
    dir: PathBuf,
    threads: i32,
    gate: Gate,
    idle: Duration,
    models: Mutex<Option<Arc<Models>>>,
    loading: Mutex<()>,
    used: Mutex<Instant>,
}

impl Speech {
    fn models(&self) -> Result<Arc<Models>, String> {
        *self.used.lock().unwrap() = Instant::now();
        let _one = self.loading.lock().unwrap();
        if let Some(m) = self.models.lock().unwrap().clone() {
            return Ok(m);
        }
        let started = Instant::now();
        let loaded = Arc::new(Models::load(&self.dir, self.threads)?);
        log(json!({ "event": "loaded", "took": started.elapsed().as_secs_f32() }));
        *self.models.lock().unwrap() = Some(loaded.clone());
        Ok(loaded)
    }

    /// Frees the models' memory once nobody used them for `idle`.
    fn unload_when_idle(&self) {
        let mut models = self.models.lock().unwrap();
        let unused = models.as_ref().is_some_and(|m| Arc::strong_count(m) == 1);
        if unused && self.used.lock().unwrap().elapsed() >= self.idle {
            *models = None;
            log(json!({ "event": "unloaded" }));
        }
    }
}

impl Engine for Speech {
    fn ready(&self) -> bool {
        models::FILES.iter().all(|f| self.dir.join(f).is_file())
    }

    fn warm(&self) {
        if let Err(error) = self.models() {
            log(json!({ "event": "load_failed", "error": error }));
        }
    }

    fn transcribe(&self, data: &[u8]) -> (u16, Value) {
        let asked = Instant::now();
        if !self.gate.enter() {
            log(json!({ "event": "busy" }));
            return failure(503, "busy", "Busy: the next engine should take this one");
        }
        let answer = (|| {
            let models = match self.models() {
                Ok(m) => m,
                Err(error) => {
                    log(json!({ "event": "load_failed", "error": error }));
                    return failure(
                        503,
                        "not_loaded",
                        "The models didn't load: the next engine should take this one",
                    );
                }
            };
            let started = Instant::now();
            let Some(audio) = audio::decode(data, MAX_SECONDS) else {
                return failure(400, "unreadable_audio", "This recording can't be read");
            };
            let seconds = (audio.seconds() * 10.0).round() / 10.0;
            if seconds > MAX_SECONDS as f32 {
                return failure(413, "too_long", "Recordings go up to 305 seconds");
            }
            if audio.samples.iter().all(|s| s.abs() < SILENCE) {
                log(json!({ "event": "silent", "seconds": seconds }));
                return (200, json!({ "text": "" }));
            }
            let heard = models.guess(&audio);
            if !PARAKEET.contains(&heard.as_str()) {
                log(json!({ "event": "not_for_me", "seconds": seconds, "heard": heard }));
                return failure(
                    422,
                    "unsupported_language",
                    "Parakeet doesn't know this language",
                );
            }
            let text = models.words(&audio);
            if text.is_empty() {
                log(json!({ "event": "no_words", "seconds": seconds, "heard": heard }));
                return failure(
                    422,
                    "no_words",
                    "Parakeet heard no words: the next engine should try this one",
                );
            }
            log(json!({
                "event": "transcribed", "seconds": seconds, "heard": heard,
                "waited": (started - asked).as_secs_f32(), "took": started.elapsed().as_secs_f32(),
            }));
            (200, json!({ "text": text }))
        })();
        self.gate.leave();
        answer
    }
}

/// A multipart/form-data body's fields, by name.
fn form_fields<'a>(content_type: &str, body: &'a [u8]) -> Vec<(String, &'a [u8])> {
    let lower = content_type.to_ascii_lowercase();
    let Some(at) = lower.find("boundary=") else {
        return vec![];
    };
    if !lower.starts_with("multipart/form-data") {
        return vec![];
    }
    let boundary = content_type[at + 9..]
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches('"');
    let marker = format!("--{boundary}").into_bytes();
    let mut parts = split(body, &marker);
    if parts.len() < 3 {
        return vec![];
    }
    parts.remove(0);
    parts.pop();
    parts
        .into_iter()
        .filter_map(|part| {
            let split_at = find(part, b"\r\n\r\n")?;
            let head = String::from_utf8_lossy(&part[..split_at]);
            let name = head
                .split(';')
                .find_map(|p| p.trim().strip_prefix("name=\"")?.split('"').next())?;
            let value = &part[split_at + 4..];
            Some((
                name.to_string(),
                value.strip_suffix(b"\r\n").unwrap_or(value),
            ))
        })
        .collect()
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn split<'a>(mut hay: &'a [u8], marker: &[u8]) -> Vec<&'a [u8]> {
    let mut out = Vec::new();
    while let Some(at) = find(hay, marker) {
        out.push(&hay[..at]);
        hay = &hay[at + marker.len()..];
    }
    out.push(hay);
    out
}

/// Equal keys, in time that doesn't depend on where they differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

struct Request<'a> {
    method: &'a str,
    path: &'a str,
    authorization: &'a str,
    content_type: &'a str,
    /// None: no Content-Length; Err: past MAX_BODY.
    body: Option<Result<Vec<u8>, ()>>,
}

fn route(engine: &dyn Engine, key: &str, r: Request) -> (u16, Option<Value>) {
    let fail = |(s, v): (u16, Value)| (s, Some(v));
    match (r.method, r.path) {
        ("GET", "/health") if engine.ready() => (200, Some(json!({ "status": "ok" }))),
        ("GET", "/health") => (503, Some(json!({ "status": "missing" }))),
        ("POST", "/v1/warm" | "/v1/audio/transcriptions") => {
            if !key.is_empty()
                && !same(
                    r.authorization.as_bytes(),
                    format!("Bearer {key}").as_bytes(),
                )
            {
                return fail(failure(401, "invalid_api_key", "Wrong or missing key"));
            }
            if r.path == "/v1/warm" {
                engine.warm();
                return (204, None);
            }
            let body = match r.body {
                None => {
                    return fail(failure(
                        411,
                        "length_required",
                        "Send the body with its Content-Length",
                    ))
                }
                Some(Err(())) => {
                    return fail(failure(413, "too_large", "The recording is too large"))
                }
                Some(Ok(b)) => b,
            };
            let fields = form_fields(r.content_type, &body);
            let field = |name: &str| fields.iter().find(|(n, _)| n == name).map(|(_, v)| *v);
            let Some(file) = field("file").filter(|f| !f.is_empty()) else {
                return fail(failure(
                    400,
                    "no_file",
                    "Send the recording in the field file",
                ));
            };
            if field("response_format").is_some_and(|f| f != b"json") {
                return fail(failure(
                    400,
                    "json_only",
                    "This server answers response_format json only",
                ));
            }
            fail(engine.transcribe(file))
        }
        _ => fail(failure(404, "not_found", "Not found")),
    }
}

fn serve(server: tiny_http::Server, engine: Arc<dyn Engine>, key: String) {
    let key = Arc::new(key);
    for mut request in server.incoming_requests() {
        let (engine, key) = (engine.clone(), key.clone());
        std::thread::spawn(move || {
            let header = |name: &'static str| {
                request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv(name))
                    .map(|h| h.value.as_str().to_string())
                    .unwrap_or_default()
            };
            let (authorization, content_type) = (header("Authorization"), header("Content-Type"));
            let body = request.body_length().map(|n| {
                if n > MAX_BODY {
                    return Err(());
                }
                let mut data = Vec::with_capacity(n);
                request
                    .as_reader()
                    .take(n as u64)
                    .read_to_end(&mut data)
                    .map_err(|_| ())?;
                Ok(data)
            });
            let method = request.method().as_str().to_uppercase();
            let path = request.url().split('?').next().unwrap_or("").to_string();
            let (status, body) = route(
                engine.as_ref(),
                &key,
                Request {
                    method: &method,
                    path: &path,
                    authorization: &authorization,
                    content_type: &content_type,
                    body,
                },
            );
            let data = body.map(|b| b.to_string()).unwrap_or_default();
            let mut response = tiny_http::Response::from_string(data).with_status_code(status);
            if status != 204 {
                response.add_header(
                    tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
                );
            }
            if status == 503 {
                response.add_header(tiny_http::Header::from_bytes("Retry-After", "1").unwrap());
            }
            let _ = request.respond(response);
        });
    }
}

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let dir = arg("--models")
        .or_else(|| std::env::var("SPEECH_MODELS").ok())
        .unwrap_or_else(|| "models".into());
    let host = arg("--host").unwrap_or_else(|| env("SPEECH_HOST", "127.0.0.1".to_string()));
    let port: u16 = arg("--port")
        .and_then(|p| p.parse().ok())
        .unwrap_or_else(|| env("SPEECH_PORT", 0));
    let workers = env("SPEECH_WORKERS", 1usize);
    // The person's apps and the agents' work come first.
    #[cfg(unix)]
    unsafe {
        libc::nice(10);
    }
    // ponytail: Windows keeps its normal priority, BELOW_NORMAL_PRIORITY_CLASS if notes slow the machine down.
    let speech = Arc::new(Speech {
        dir: PathBuf::from(dir),
        threads: env("SPEECH_THREADS", 2),
        gate: Gate::new(
            workers,
            env("SPEECH_QUEUE", 4),
            Duration::from_secs_f32(env("SPEECH_WAIT_SECONDS", 3.0)),
        ),
        idle: Duration::from_secs(env("SPEECH_IDLE_SECONDS", 600)),
        models: Mutex::new(None),
        loading: Mutex::new(()),
        used: Mutex::new(Instant::now()),
    });
    let server = match tiny_http::Server::http((host.as_str(), port)) {
        Ok(s) => s,
        Err(error) => {
            log(json!({ "event": "listen_failed", "error": error.to_string() }));
            std::process::exit(1);
        }
    };
    let port = server.server_addr().to_ip().map_or(0, |a| a.port());
    // The first line: the core reads the port it got.
    log(json!({ "event": "listening", "port": port, "ready": speech.ready() }));
    let idle = speech.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        idle.unload_when_idle();
    });
    serve(
        server,
        speech,
        std::env::var("SPEECH_API_KEY").unwrap_or_default(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake;
    impl Engine for Fake {
        fn ready(&self) -> bool {
            true
        }
        fn warm(&self) {}
        fn transcribe(&self, audio: &[u8]) -> (u16, Value) {
            (200, json!({ "text": String::from_utf8_lossy(audio) }))
        }
    }

    fn post<'a>(
        path: &'a str,
        auth: &'a str,
        content_type: &'a str,
        body: Option<Result<Vec<u8>, ()>>,
    ) -> Request<'a> {
        Request {
            method: "POST",
            path,
            authorization: auth,
            content_type,
            body,
        }
    }

    const FORM: &str = "multipart/form-data; boundary=xyz";
    fn form(fields: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, value) in fields {
            out.extend(
                format!("--xyz\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n")
                    .as_bytes(),
            );
            out.extend(*value);
            out.extend(b"\r\n");
        }
        out.extend(b"--xyz--\r\n");
        out
    }

    #[test]
    fn answers_as_openais_transcription_api() {
        let body = form(&[("model", b"whisper-1"), ("file", b"oi")]);
        let (status, answer) = route(
            &Fake,
            "k",
            post("/v1/audio/transcriptions", "Bearer k", FORM, Some(Ok(body))),
        );
        assert_eq!((status, answer), (200, Some(json!({ "text": "oi" }))));
    }

    #[test]
    fn refuses_what_the_contract_refuses() {
        let code = |r: Request| route(&Fake, "k", r).1.unwrap()["error"]["code"].clone();
        let ok = |b: Vec<u8>| Some(Ok(b));
        assert_eq!(
            code(post(
                "/v1/audio/transcriptions",
                "Bearer x",
                FORM,
                ok(vec![])
            )),
            "invalid_api_key"
        );
        assert_eq!(
            code(post("/v1/audio/transcriptions", "Bearer k", FORM, None)),
            "length_required"
        );
        assert_eq!(
            code(post(
                "/v1/audio/transcriptions",
                "Bearer k",
                FORM,
                Some(Err(()))
            )),
            "too_large"
        );
        assert_eq!(
            code(post(
                "/v1/audio/transcriptions",
                "Bearer k",
                FORM,
                ok(form(&[("x", b"1")]))
            )),
            "no_file"
        );
        let text = form(&[("file", b"oi"), ("response_format", b"text")]);
        assert_eq!(
            code(post("/v1/audio/transcriptions", "Bearer k", FORM, ok(text))),
            "json_only"
        );
        assert_eq!(code(post("/nope", "Bearer k", FORM, None)), "not_found");
        assert_eq!(
            route(&Fake, "k", post("/v1/warm", "Bearer k", "", None)),
            (204, None)
        );
        let health = Request {
            method: "GET",
            path: "/health",
            authorization: "",
            content_type: "",
            body: None,
        };
        assert_eq!(route(&Fake, "k", health).0, 200);
    }

    #[test]
    fn a_full_house_is_busy_at_once() {
        let gate = Gate::new(1, 0, Duration::from_millis(10));
        assert!(gate.enter());
        assert!(!gate.enter());
        gate.leave();
        assert!(gate.enter());
    }
}
