//! DECSET 2026 synchronized output hold.
//!
//! wezterm-term ignores this mode (upstream handles it in the mux). Without a
//! hold here, a TUI that wraps each animation frame in `CSI ? 2026 h` … redraw
//! … `CSI ? 2026 l` can be extracted mid-redraw and painted as a torn frame.

use std::time::{Duration, Instant};

/// Total-duration cap on a DECSET 2026 hold, measured from the moment the
/// hold began - **not** an idle timeout. The hold used to reset this clock on
/// every byte received while holding, so a TUI that kept animating inside
/// `2026h` ... `2026l` (a busy spinner, a fast log) held forever and was
/// never force-flushed. A total cap still frees a hold that legitimately
/// idles out (a stalled or crashed app leaves `holding` true with no more
/// bytes coming), while also bounding the worst case for one that never goes
/// idle at all.
pub const HOLD_TIMEOUT: Duration = Duration::from_secs(1);

/// Hard ceiling on how large `hold_buffer` may grow. Without this, a
/// misbehaving or malicious app that opens a hold and then emits output
/// forever (see `HOLD_TIMEOUT`'s doc) would still buffer unboundedly in
/// memory between the moment the hold starts and its 1s timeout - this
/// releases the hold immediately once it is clearly not "one animation
/// frame" any more.
pub const HOLD_MAX_BYTES: usize = 8 * 1024 * 1024;

/// A `NeedMore` classification whose unresolved tail already exceeds this
/// many bytes is not a real in-flight CSI sequence waiting on the next PTY
/// read - a real 2026/DECRQM/soft-reset sequence this parser recognizes is at
/// most a dozen bytes. Treat the tail as ordinary bytes instead of parking it
/// in `pending` forever, so a malformed or adversarial "sequence" that never
/// reaches a final byte cannot grow `pending` without bound.
const MAX_PENDING: usize = 32;

pub struct SynchronizedOutput {
    holding: bool,
    hold_buffer: Vec<u8>,
    pending: Vec<u8>,
    /// Set once, when the hold begins (`BeginHold`) - never touched per byte
    /// while holding. See `HOLD_TIMEOUT`.
    hold_started_at: Option<Instant>,
}

pub struct PushOutcome {
    pub flush: Vec<u8>,
    pub decrqm_replies: usize,
}

enum Special {
    Byte,
    NeedMore,
    BeginHold { seq_len: usize },
    EndHold { seq_len: usize },
    Query { seq_len: usize },
    SoftReset { seq_len: usize },
}

impl Default for SynchronizedOutput {
    fn default() -> Self {
        Self::new()
    }
}

impl SynchronizedOutput {
    pub fn new() -> Self {
        Self {
            holding: false,
            hold_buffer: Vec::new(),
            pending: Vec::new(),
            hold_started_at: None,
        }
    }

    #[cfg(test)]
    pub fn is_holding(&self) -> bool {
        self.holding
    }

    /// Test-only escape hatch for `HOLD_TIMEOUT`/`poll_timeout` without an
    /// actual `sleep`: rewinds the hold's start time by `by`.
    #[cfg(test)]
    pub fn backdate_hold(&mut self, by: Duration) {
        if let Some(started) = self.hold_started_at {
            self.hold_started_at = Some(started - by);
        }
    }

    pub fn hold_remaining(&self) -> Option<Duration> {
        if !self.holding {
            return None;
        }
        let started = self.hold_started_at?;
        Some(HOLD_TIMEOUT.saturating_sub(started.elapsed()))
    }

    /// Force-flushes the hold once it has been open for `HOLD_TIMEOUT`,
    /// regardless of how recently a byte arrived (see `HOLD_TIMEOUT`'s doc).
    /// Only `hold_buffer` is returned - a partial CSI sequence still sitting
    /// in `pending` belongs to whatever `push` completes it next, not to a
    /// timeout flush, so an in-flight escape sequence is never cut in half.
    pub fn poll_timeout(&mut self) -> Option<Vec<u8>> {
        if !self.holding {
            return None;
        }
        let Some(started) = self.hold_started_at else {
            return None;
        };
        if started.elapsed() < HOLD_TIMEOUT {
            return None;
        }
        self.holding = false;
        self.hold_started_at = None;
        Some(std::mem::take(&mut self.hold_buffer))
    }

    pub fn push(&mut self, data: &[u8]) -> PushOutcome {
        if let Some(flushed) = self.poll_timeout() {
            let mut outcome = self.push_bytes(data);
            if !flushed.is_empty() {
                let mut combined = flushed;
                combined.extend(outcome.flush);
                outcome.flush = combined;
            }
            return outcome;
        }
        self.push_bytes(data)
    }

    fn push_bytes(&mut self, data: &[u8]) -> PushOutcome {
        let mut input = std::mem::take(&mut self.pending);
        input.extend_from_slice(data);

        let mut flush = Vec::new();
        let mut decrqm_replies = 0;
        let mut index = 0;

        while index < input.len() {
            match classify(&input[index..]) {
                Special::NeedMore => {
                    if input.len() - index > MAX_PENDING {
                        // Not a real in-flight sequence - see MAX_PENDING's
                        // doc. Fall back to one ordinary byte and keep
                        // reclassifying from the next one instead of parking
                        // an ever-growing tail.
                        self.emit(&input[index..index + 1], &mut flush);
                        index += 1;
                        continue;
                    }
                    self.pending = input[index..].to_vec();
                    break;
                }
                Special::BeginHold { seq_len } => {
                    if !self.holding {
                        self.holding = true;
                        self.hold_started_at = Some(Instant::now());
                    }
                    index += seq_len;
                }
                Special::EndHold { seq_len } => {
                    if self.holding {
                        self.holding = false;
                        flush.extend(std::mem::take(&mut self.hold_buffer));
                        self.hold_started_at = None;
                    }
                    index += seq_len;
                }
                Special::Query { seq_len } => {
                    decrqm_replies += 1;
                    index += seq_len;
                }
                Special::SoftReset { seq_len } => {
                    if self.holding {
                        self.holding = false;
                        flush.extend(std::mem::take(&mut self.hold_buffer));
                        self.hold_started_at = None;
                    }
                    self.emit(&input[index..index + seq_len], &mut flush);
                    index += seq_len;
                }
                Special::Byte => {
                    self.emit(&input[index..index + 1], &mut flush);
                    index += 1;
                }
            }
        }

        PushOutcome {
            flush,
            decrqm_replies,
        }
    }

    fn emit(&mut self, bytes: &[u8], flush: &mut Vec<u8>) {
        if self.holding {
            self.hold_buffer.extend_from_slice(bytes);
            if self.hold_buffer.len() >= HOLD_MAX_BYTES {
                self.holding = false;
                self.hold_started_at = None;
                flush.extend(std::mem::take(&mut self.hold_buffer));
            }
        } else {
            flush.extend_from_slice(bytes);
        }
    }
}

fn classify(bytes: &[u8]) -> Special {
    if bytes.is_empty() {
        return Special::NeedMore;
    }

    let csi_start = if bytes[0] == 0x9b {
        1
    } else if bytes[0] == 0x1b {
        if bytes.len() == 1 {
            return Special::NeedMore;
        }
        if bytes[1] != b'[' {
            return Special::Byte;
        }
        2
    } else {
        return Special::Byte;
    };

    for (offset, &byte) in bytes[csi_start..].iter().enumerate() {
        if (0x40..=0x7e).contains(&byte) {
            let seq_len = csi_start + offset + 1;
            let params = &bytes[csi_start..csi_start + offset];
            return classify_csi(params, byte, seq_len);
        }
        if !(0x20..=0x3f).contains(&byte) {
            return Special::Byte;
        }
    }
    Special::NeedMore
}

fn classify_csi(params: &[u8], final_byte: u8, seq_len: usize) -> Special {
    if params == b"!" && final_byte == b'p' {
        return Special::SoftReset { seq_len };
    }
    if params == b"?2026$" && final_byte == b'p' {
        return Special::Query { seq_len };
    }
    let is_2026 = params == b"?2026" || params.starts_with(b"?2026;");
    if is_2026 && final_byte == b'h' {
        return Special::BeginHold { seq_len };
    }
    if is_2026 && final_byte == b'l' {
        return Special::EndHold { seq_len };
    }
    Special::Byte
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_ordinary_bytes_through() {
        let mut sync = SynchronizedOutput::new();
        let outcome = sync.push(b"hello");
        assert_eq!(outcome.flush, b"hello");
        assert_eq!(outcome.decrqm_replies, 0);
        assert!(!sync.is_holding());
    }

    #[test]
    fn holds_until_reset() {
        let mut sync = SynchronizedOutput::new();
        let first = sync.push(b"\x1b[?2026hpartial");
        assert!(first.flush.is_empty());
        assert!(sync.is_holding());

        let second = sync.push(b" done\x1b[?2026l");
        assert_eq!(second.flush, b"partial done");
        assert!(!sync.is_holding());
    }

    #[test]
    fn flushes_prefix_before_entering_hold() {
        let mut sync = SynchronizedOutput::new();
        let outcome = sync.push(b"before\x1b[?2026hheld\x1b[?2026lafter");
        assert_eq!(outcome.flush, b"beforeheldafter");
        assert!(!sync.is_holding());
    }

    #[test]
    fn splits_csi_across_chunks() {
        let mut sync = SynchronizedOutput::new();
        let first = sync.push(b"\x1b[?20");
        assert!(first.flush.is_empty());
        assert!(!sync.is_holding());

        let second = sync.push(b"26hsecret");
        assert!(second.flush.is_empty());
        assert!(sync.is_holding());

        let third = sync.push(b"\x1b[?2026l");
        assert_eq!(third.flush, b"secret");
    }

    #[test]
    fn intercepts_decrqm_without_passing_it_through() {
        let mut sync = SynchronizedOutput::new();
        let outcome = sync.push(b"pre\x1b[?2026$ppost");
        assert_eq!(outcome.flush, b"prepost");
        assert_eq!(outcome.decrqm_replies, 1);
    }

    #[test]
    fn soft_reset_releases_hold() {
        let mut sync = SynchronizedOutput::new();
        let _ = sync.push(b"\x1b[?2026hheld");
        let outcome = sync.push(b"\x1b[!p");
        assert_eq!(outcome.flush, b"held\x1b[!p");
        assert!(!sync.is_holding());
    }

    #[test]
    fn timeout_flushes_a_stuck_hold() {
        let mut sync = SynchronizedOutput::new();
        let _ = sync.push(b"\x1b[?2026hpartial");
        sync.backdate_hold(HOLD_TIMEOUT + Duration::from_millis(20));
        let flushed = sync.poll_timeout().expect("timeout flush");
        assert_eq!(flushed, b"partial");
        assert!(!sync.is_holding());
    }

    #[test]
    fn timeout_keeps_a_partial_csi_pending() {
        let mut sync = SynchronizedOutput::new();
        // Everything through `\x1b[?20` is consumed: the hold begins, then
        // "partial" is buffered, then the trailing `\x1b[?20` is an
        // in-flight CSI (well under MAX_PENDING) that has to wait for more
        // bytes to know what it is.
        let first = sync.push(b"\x1b[?2026hpartial\x1b[?20");
        assert!(first.flush.is_empty());
        assert!(sync.is_holding());

        sync.backdate_hold(HOLD_TIMEOUT + Duration::from_millis(20));
        let flushed = sync.poll_timeout().expect("timeout flush");
        // Only the hold buffer is flushed by the timeout - the partial CSI
        // is not chopped in half just because the hold around it timed out.
        assert_eq!(flushed, b"partial");
        assert!(!sync.is_holding());

        // The partial CSI survived the timeout flush in `pending` and still
        // completes into a real 2026 sequence, starting a new hold.
        let second = sync.push(b"26h more");
        assert!(second.flush.is_empty());
        assert!(
            sync.is_holding(),
            "the completed CSI carried over from `pending` must still be recognized"
        );
    }

    #[test]
    fn hold_buffer_byte_cap_releases_the_hold() {
        let mut sync = SynchronizedOutput::new();
        let begin = sync.push(b"\x1b[?2026h");
        assert!(begin.flush.is_empty());
        assert!(sync.is_holding());

        let chunk = vec![b'x'; HOLD_MAX_BYTES];
        let outcome = sync.push(&chunk);
        assert_eq!(
            outcome.flush.len(),
            HOLD_MAX_BYTES,
            "the byte cap must release everything buffered so far, not drop it"
        );
        assert!(
            !sync.is_holding(),
            "hold must release once the buffer cap is hit, without waiting for HOLD_TIMEOUT"
        );
    }

    #[test]
    fn overlong_csi_parameters_are_not_parked() {
        let mut sync = SynchronizedOutput::new();
        // An escape sequence whose parameter bytes never reach a final byte
        // (0x40..=0x7e) - well past MAX_PENDING - must not be parked in
        // `pending` forever waiting for a terminator that may never come.
        let mut malformed = vec![0x1b, b'['];
        malformed.extend(std::iter::repeat(b'9').take(40));

        let outcome = sync.push(&malformed);
        assert_eq!(
            outcome.flush, malformed,
            "an overlong unterminated sequence must fall back to literal bytes"
        );
        assert!(!sync.is_holding());
    }
}
