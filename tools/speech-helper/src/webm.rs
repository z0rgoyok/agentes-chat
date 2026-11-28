//! The Opus frames of a WebM recording, as browsers' MediaRecorder writes it: a Segment and Clusters of unknown size,
//! SimpleBlocks without lacing. Only what a voice message needs: the first Opus track's frames, in order.

const SEGMENT: u32 = 0x1853_8067;
const CLUSTER: u32 = 0x1F43_B675;
const TRACKS: u32 = 0x1654_AE6B;
const TRACK_ENTRY: u32 = 0xAE;
const TRACK_NUMBER: u32 = 0xD7;
const CODEC_ID: u32 = 0x86;
const BLOCK_GROUP: u32 = 0xA0;
const BLOCK: u32 = 0xA1;
const SIMPLE_BLOCK: u32 = 0xA3;
pub const EBML_MAGIC: [u8; 4] = [0x1A, 0x45, 0xDF, 0xA3];

/// Masters whose children are read in place (sized or not): everything else is skipped by its size.
const MASTERS: [u32; 5] = [SEGMENT, CLUSTER, TRACKS, TRACK_ENTRY, BLOCK_GROUP];

/// A variable-length integer at `at`: its value (marker kept for ids, dropped for sizes) and its length.
fn vint(data: &[u8], at: usize, keep_marker: bool) -> Option<(u64, usize)> {
    let first = *data.get(at)?;
    let len = first.leading_zeros() as usize + 1;
    if len > 8 || at + len > data.len() {
        return None;
    }
    let mut value = if keep_marker {
        first as u64
    } else {
        (first as u64) & (0xFF >> len)
    };
    for byte in &data[at + 1..at + len] {
        value = (value << 8) | *byte as u64;
    }
    Some((value, len))
}

/// The size's value when every bit is set: unknown, until the parent ends.
fn unknown(value: u64, len: usize) -> bool {
    value == (1u64 << (7 * len)) - 1
}

/// The first Opus track's frames; None when it isn't a WebM with Opus.
pub fn opus_frames(data: &[u8]) -> Option<Vec<&[u8]>> {
    if !data.starts_with(&EBML_MAGIC) {
        return None;
    }
    let mut frames = Vec::new();
    let mut track: Option<u64> = None;
    // The track entry being read: its number and codec, kept until both are known.
    let (mut number, mut codec): (Option<u64>, Option<&[u8]>) = (None, None);
    let mut at = 0;
    while at < data.len() {
        let (id, id_len) = vint(data, at, true)?;
        let (size, size_len) = vint(data, at + id_len, false)?;
        let body = at + id_len + size_len;
        let id = id as u32;
        if id == TRACK_ENTRY {
            number = None;
            codec = None;
        }
        if MASTERS.contains(&id) {
            at = body;
            continue;
        }
        if unknown(size, size_len) {
            return None;
        }
        let end = body.checked_add(size as usize)?.min(data.len());
        let value = &data[body..end];
        match id {
            TRACK_NUMBER => number = Some(value.iter().fold(0u64, |n, b| (n << 8) | *b as u64)),
            CODEC_ID => codec = Some(value),
            SIMPLE_BLOCK | BLOCK => {
                if let (Some(want), Some((n, n_len))) = (track, vint(value, 0, false)) {
                    // Track, 2 bytes of time, 1 of flags; laced blocks never come from a recorder.
                    let flags = value.get(n_len + 2).copied().unwrap_or(0);
                    if n == want && flags & 0x06 == 0 && value.len() > n_len + 3 {
                        frames.push(&value[n_len + 3..]);
                    }
                }
            }
            _ => {}
        }
        if track.is_none() && codec == Some(b"A_OPUS".as_slice()) {
            track = number;
        }
        at = end;
    }
    track.map(|_| frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn element(id: &[u8], body: &[u8]) -> Vec<u8> {
        let mut out = id.to_vec();
        out.push(0x80 | body.len() as u8);
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn reads_a_recorders_webm_with_unknown_sizes() {
        let mut data = element(&EBML_MAGIC, &[]);
        // Segment and Cluster of unknown size, as MediaRecorder writes them.
        data.extend_from_slice(&[
            0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        ]);
        let entry = [element(&[0xD7], &[1]), element(&[0x86], b"A_OPUS")].concat();
        data.extend(element(
            &[0x16, 0x54, 0xAE, 0x6B],
            &element(&[0xAE], &entry),
        ));
        data.extend_from_slice(&[0x1F, 0x43, 0xB6, 0x75, 0xFF]);
        data.extend(element(&[0xE7], &[0]));
        data.extend(element(&[0xA3], &[0x81, 0, 0, 0x80, 7, 7, 7]));
        data.extend(element(&[0xA3], &[0x82, 0, 0, 0x80, 9]));
        data.extend(element(&[0xA3], &[0x81, 0, 20, 0x80, 8, 8]));
        assert_eq!(
            opus_frames(&data),
            Some(vec![&[7u8, 7, 7][..], &[8, 8][..]])
        );
    }

    #[test]
    fn anything_else_is_none() {
        assert_eq!(opus_frames(b"RIFF....WAVE"), None);
        let no_opus = [
            element(&EBML_MAGIC, &[]),
            element(&[0xAE], &element(&[0x86], b"A_VORBIS")),
        ]
        .concat();
        assert_eq!(opus_frames(&no_opus), None);
    }
}
