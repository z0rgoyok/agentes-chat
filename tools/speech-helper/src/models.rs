//! Parakeet TDT 0.6B v3 and Whisper tiny's language guess, on sherpa-onnx (CPU, int8), from the files the core
//! downloads (packages/engine/src/speech-local.ts names them).

use crate::audio::{pieces, Samples};
use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig,
    SpokenLanguageIdentification, SpokenLanguageIdentificationConfig,
    SpokenLanguageIdentificationWhisperConfig,
};
use std::path::Path;

/// Parakeet TDT 0.6B v3's languages, as Whisper names them.
pub const PARAKEET: [&str; 25] = [
    "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hr", "hu", "it", "lt", "lv", "mt",
    "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "uk",
];
/// Whisper hears language from its first 30 seconds.
const GUESS_SECONDS: f32 = 30.0;

pub struct Models {
    words: OfflineRecognizer,
    language: SpokenLanguageIdentification,
}

/// The files under the models folder, as the core lays them out.
pub const FILES: [&str; 6] = [
    "parakeet/encoder.int8.onnx",
    "parakeet/decoder.int8.onnx",
    "parakeet/joiner.int8.onnx",
    "parakeet/tokens.txt",
    "whisper/tiny-encoder.int8.onnx",
    "whisper/tiny-decoder.int8.onnx",
];

fn path(dir: &Path, file: &str) -> Option<String> {
    Some(dir.join(file).to_string_lossy().into_owned())
}

impl Models {
    pub fn load(dir: &Path, threads: i32) -> Result<Models, String> {
        if let Some(missing) = FILES.iter().find(|f| !dir.join(f).is_file()) {
            return Err(format!("missing {missing}"));
        }
        let mut config = OfflineRecognizerConfig::default();
        config.model_config.transducer = OfflineTransducerModelConfig {
            encoder: path(dir, FILES[0]),
            decoder: path(dir, FILES[1]),
            joiner: path(dir, FILES[2]),
        };
        config.model_config.tokens = path(dir, FILES[3]);
        config.model_config.num_threads = threads;
        config.model_config.provider = Some("cpu".into());
        let words = OfflineRecognizer::create(&config).ok_or("Parakeet didn't load")?;
        let language = SpokenLanguageIdentification::create(&SpokenLanguageIdentificationConfig {
            whisper: SpokenLanguageIdentificationWhisperConfig {
                encoder: path(dir, FILES[4]),
                decoder: path(dir, FILES[5]),
                tail_paddings: 0,
            },
            num_threads: threads,
            ..Default::default()
        })
        .ok_or("Whisper tiny didn't load")?;
        Ok(Models { words, language })
    }

    /// The spoken language's code, from the first 30 seconds.
    pub fn guess(&self, audio: &Samples) -> String {
        let head = (GUESS_SECONDS * audio.rate as f32) as usize;
        let stream = self.language.create_stream();
        stream.accept_waveform(
            audio.rate as i32,
            &audio.samples[..audio.samples.len().min(head)],
        );
        self.language
            .compute(&stream)
            .map(|r| r.lang)
            .unwrap_or_default()
    }

    pub fn words(&self, audio: &Samples) -> String {
        pieces(&audio.samples, audio.rate, 15.0, 25.0)
            .into_iter()
            .filter_map(|piece| {
                let stream = self.words.create_stream();
                stream.accept_waveform(audio.rate as i32, piece);
                self.words.decode(&stream);
                stream.get_result().map(|r| r.text.trim().to_string())
            })
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
}
