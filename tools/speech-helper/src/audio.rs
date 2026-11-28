//! A recording as mono f32 samples at its own rate (sherpa-onnx resamples), from what the apps and chat surfaces send:
//! WebM/Opus (browsers), MP4/AAC (the phone, Safari), Ogg/Opus (WhatsApp, Telegram), WAV and MP3.

use crate::webm;
use std::io::Cursor;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL, CODEC_TYPE_OPUS};
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Opus always decodes at 48 kHz.
const OPUS_RATE: u32 = 48_000;
/// 120 ms at 48 kHz: Opus's longest frame.
const OPUS_FRAME: usize = 5_760;

pub struct Samples {
    pub samples: Vec<f32>,
    pub rate: u32,
}

impl Samples {
    pub fn seconds(&self) -> f32 {
        self.samples.len() as f32 / self.rate as f32
    }
}

/// None when the recording can't be read. Stops past `max_seconds`, so a long file costs no more than that.
pub fn decode(data: &[u8], max_seconds: u32) -> Option<Samples> {
    if let Some(frames) = webm::opus_frames(data) {
        return opus(frames.into_iter(), max_seconds);
    }
    let source = MediaSourceStream::new(Box::new(Cursor::new(data.to_vec())), Default::default());
    let probed = symphonia::default::get_probe()
        .format(
            &Hint::new(),
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?;
    let (id, params) = (track.id, track.codec_params.clone());
    let mut packets = std::iter::from_fn(|| loop {
        match format.next_packet() {
            Ok(p) if p.track_id() == id => return Some(p),
            Ok(_) => continue,
            Err(_) => return None,
        }
    });
    if params.codec == CODEC_TYPE_OPUS {
        let data: Vec<Vec<u8>> = packets.by_ref().map(|p| p.data.to_vec()).collect();
        return opus(data.iter().map(|d| d.as_slice()), max_seconds);
    }
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .ok()?;
    let mut rate = params.sample_rate.unwrap_or(0);
    let mut out = Vec::new();
    for packet in packets {
        let buffer = match decoder.decode(&packet) {
            Ok(b) => b,
            Err(Error::DecodeError(_)) => continue,
            Err(_) => break,
        };
        let spec = *buffer.spec();
        rate = spec.rate;
        let channels = spec.channels.count().max(1);
        let mut interleaved = SampleBuffer::<f32>::new(buffer.capacity() as u64, spec);
        interleaved.copy_interleaved_ref(buffer);
        out.extend(
            interleaved
                .samples()
                .chunks(channels)
                .map(|f| f.iter().sum::<f32>() / channels as f32),
        );
        if rate > 0 && out.len() > (max_seconds as usize + 1) * rate as usize {
            break;
        }
    }
    (rate > 0 && !out.is_empty()).then_some(Samples { samples: out, rate })
}

fn opus<'a>(frames: impl Iterator<Item = &'a [u8]>, max_seconds: u32) -> Option<Samples> {
    // Any Opus stream decodes to the channels asked for: a stereo one comes down mixed.
    let mut decoder = opus::Decoder::new(OPUS_RATE, opus::Channels::Mono).ok()?;
    let mut out = Vec::new();
    let mut frame = vec![0f32; OPUS_FRAME];
    for packet in frames {
        if let Ok(n) = decoder.decode_float(packet, &mut frame, false) {
            out.extend_from_slice(&frame[..n]);
        }
        if out.len() > (max_seconds as usize + 1) * OPUS_RATE as usize {
            break;
        }
    }
    (!out.is_empty()).then_some(Samples {
        samples: out,
        rate: OPUS_RATE,
    })
}

/// Longer than `high` seconds: cut at the quietest tenth of a second between `low` and `high` into each piece, as
/// deploy/speech/server.py does (a transducer's memory grows with the length).
pub fn pieces(samples: &[f32], rate: u32, low: f32, high: f32) -> Vec<&[f32]> {
    let (low, high, step) = (
        (low * rate as f32) as usize,
        (high * rate as f32) as usize,
        (rate / 10).max(1) as usize,
    );
    let mut out = Vec::new();
    let mut start = 0;
    while samples.len() - start > high {
        let window = &samples[start + low..start + high];
        let quietest = window
            .chunks(step)
            .enumerate()
            .map(|(i, c)| (i, c.iter().map(|s| s * s).sum::<f32>()))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map_or(0, |(i, _)| i);
        let cut = start + low + quietest * step + step / 2;
        out.push(&samples[start..cut]);
        start = cut;
    }
    out.push(&samples[start..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(samples: &[i16], rate: u32) -> Vec<u8> {
        let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut out = b"RIFF".to_vec();
        out.extend((36 + data.len() as u32).to_le_bytes());
        out.extend(b"WAVEfmt ");
        out.extend(16u32.to_le_bytes());
        out.extend(1u16.to_le_bytes());
        out.extend(1u16.to_le_bytes());
        out.extend(rate.to_le_bytes());
        out.extend((rate * 2).to_le_bytes());
        out.extend(2u16.to_le_bytes());
        out.extend(16u16.to_le_bytes());
        out.extend(b"data");
        out.extend((data.len() as u32).to_le_bytes());
        out.extend(data);
        out
    }

    #[test]
    fn reads_a_wav_at_its_own_rate() {
        let tone: Vec<i16> = (0..16_000)
            .map(|i| ((i as f32 / 8.0).sin() * 8000.0) as i16)
            .collect();
        let read = decode(&wav(&tone, 16_000), 305).expect("decoded");
        assert_eq!(read.rate, 16_000);
        assert!((read.seconds() - 1.0).abs() < 0.01);
        assert!(read.samples.iter().any(|s| s.abs() > 0.1));
    }

    #[test]
    fn reads_a_browsers_webm_opus() {
        fn element(id: &[u8], body: &[u8]) -> Vec<u8> {
            let mut out = id.to_vec();
            out.extend_from_slice(&[0x40 | (body.len() >> 8) as u8, body.len() as u8]);
            out.extend_from_slice(body);
            out
        }
        let mut encoder =
            opus::Encoder::new(48_000, opus::Channels::Mono, opus::Application::Voip).unwrap();
        let mut data = element(&webm::EBML_MAGIC, &[]);
        data.extend_from_slice(&[0x18, 0x53, 0x80, 0x67, 0xFF]);
        let entry = [element(&[0xD7], &[1]), element(&[0x86], b"A_OPUS")].concat();
        data.extend(element(
            &[0x16, 0x54, 0xAE, 0x6B],
            &element(&[0xAE], &entry),
        ));
        data.extend_from_slice(&[0x1F, 0x43, 0xB6, 0x75, 0xFF]);
        // A second of tone, in 20 ms frames.
        for f in 0..50 {
            let pcm: Vec<f32> = (0..960)
                .map(|i| ((f * 960 + i) as f32 / 20.0).sin() * 0.3)
                .collect();
            let mut block = vec![0x81, 0, 0, 0x80];
            block.extend(encoder.encode_vec_float(&pcm, 4000).unwrap());
            data.extend(element(&[0xA3], &block));
        }
        let read = decode(&data, 305).expect("decoded");
        assert_eq!(read.rate, 48_000);
        assert!((read.seconds() - 1.0).abs() < 0.05);
        assert!(read.samples.iter().any(|s| s.abs() > 0.1));
    }

    #[test]
    fn what_isnt_audio_is_none() {
        assert!(decode(b"<html>not a recording</html>", 305).is_none());
    }

    #[test]
    fn long_audio_cuts_at_its_quietest_tenth() {
        let rate = 100;
        let mut samples = vec![1.0f32; 40 * rate as usize];
        // Quiet at 20.0 to 20.1 s.
        samples[2000..2010].fill(0.0);
        let parts = pieces(&samples, rate, 15.0, 25.0);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].len(), 2005);
        assert_eq!(parts.iter().map(|p| p.len()).sum::<usize>(), samples.len());
        assert_eq!(pieces(&samples[..1000], rate, 15.0, 25.0).len(), 1);
    }
}
