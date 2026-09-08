//! DECSET 2026 synchronized output hold.
//!
//! wezterm-term ignores this mode (upstream handles it in the mux). Without a
//! hold here, a TUI that wraps each animation frame in `CSI ? 2026 h` … redraw
//! … `CSI ? 2026 l` can be extracted mid-redraw and painted as a torn frame.

use std::time::{Duration, Instant};

pub const HOLD_TIMEOUT: Duration = Duration::from_millis(150);

pub struct SynchronizedOutput {
    holding: bool,
    hold_buffer: Vec<u8>,
    pending: Vec<u8>,
    last_hold_byte_at: Option<Instant>,
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
            last_hold_byte_at: None,
        }
    }

    #[cfg(test)]
    pub fn is_holding(&self) -> bool {
        self.holding
    }

    pub fn hold_remaining(&self) -> Option<Duration> {
        if !self.holding {
            return None;
        }
        let started = self.last_hold_byte_at?;
        Some(HOLD_TIMEOUT.saturating_sub(started.elapsed()))
    }

    pub fn poll_timeout(&mut self) -> Option<Vec<u8>> {
        if !self.holding {
            return None;
        }
        let Some(started) = self.last_hold_byte_at else {
            return None;
        };
        if started.elapsed() < HOLD_TIMEOUT {
            return None;
        }
        self.holding = false;
        self.last_hold_byte_at = None;
        let mut flushed = std::mem::take(&mut self.hold_buffer);
        flushed.extend(std::mem::take(&mut self.pending));
        Some(flushed)
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
                    self.pending = input[index..].to_vec();
                    break;
                }
                Special::BeginHold { seq_len } => {
                    if !self.holding {
                        self.holding = true;
                        self.last_hold_byte_at = Some(Instant::now());
                    }
                    index += seq_len;
                }
                Special::EndHold { seq_len } => {
                    if self.holding {
                        self.holding = false;
                        flush.extend(std::mem::take(&mut self.hold_buffer));
                        self.last_hold_byte_at = None;
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
                        self.last_hold_byte_at = None;
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
            self.last_hold_byte_at = Some(Instant::now());
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
        std::thread::sleep(HOLD_TIMEOUT + Duration::from_millis(20));
        let flushed = sync.poll_timeout().expect("timeout flush");
        assert_eq!(flushed, b"partial");
        assert!(!sync.is_holding());
    }
}
