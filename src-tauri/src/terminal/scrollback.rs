//! Bounded in-memory terminal scrollback.
//!
//! The buffer stores raw PTY bytes rather than UTF-8 text because terminal
//! output may contain arbitrary bytes and split escape sequences.

use std::collections::VecDeque;

use bytes::Bytes;

pub const DEFAULT_SCROLLBACK_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScrollbackSnapshot {
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

#[derive(Debug)]
pub struct OutputRingBuffer {
    chunks: VecDeque<Bytes>,
    total_bytes: usize,
    max_bytes: usize,
    truncated: bool,
}

impl OutputRingBuffer {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            total_bytes: 0,
            max_bytes: max_bytes.max(1),
            truncated: false,
        }
    }

    pub fn push(&mut self, bytes: impl Into<Bytes>) {
        let mut bytes = bytes.into();
        if bytes.is_empty() {
            return;
        }

        if bytes.len() > self.max_bytes {
            bytes = bytes.slice(bytes.len() - self.max_bytes..);
            self.chunks.clear();
            self.total_bytes = 0;
            self.truncated = true;
        }

        self.total_bytes += bytes.len();
        self.chunks.push_back(bytes);
        while self.total_bytes > self.max_bytes {
            if let Some(removed) = self.chunks.pop_front() {
                self.total_bytes -= removed.len();
                self.truncated = true;
            }
        }
    }

    pub fn snapshot(&self) -> ScrollbackSnapshot {
        let mut bytes = Vec::with_capacity(self.total_bytes);
        for chunk in &self.chunks {
            bytes.extend_from_slice(chunk);
        }
        ScrollbackSnapshot {
            bytes,
            truncated: self.truncated,
        }
    }

    #[cfg(test)]
    fn total_bytes(&self) -> usize {
        self.total_bytes
    }
}

impl Default for OutputRingBuffer {
    fn default() -> Self {
        Self::new(DEFAULT_SCROLLBACK_BYTES)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_binary_bytes_without_utf8_conversion() {
        let mut buffer = OutputRingBuffer::new(16);
        buffer.push(Bytes::from_static(&[0, 0xff, 0x80, b'A']));

        assert_eq!(buffer.snapshot().bytes, [0, 0xff, 0x80, b'A']);
        assert!(!buffer.snapshot().truncated);
    }

    #[test]
    fn drops_oldest_complete_chunks_when_limit_is_exceeded() {
        let mut buffer = OutputRingBuffer::new(6);
        buffer.push(Bytes::from_static(b"abc"));
        buffer.push(Bytes::from_static(b"def"));
        buffer.push(Bytes::from_static(b"gh"));

        assert_eq!(buffer.snapshot().bytes, b"defgh");
        assert_eq!(buffer.total_bytes(), 5);
        assert!(buffer.snapshot().truncated);
    }

    #[test]
    fn keeps_tail_of_a_single_oversized_chunk() {
        let mut buffer = OutputRingBuffer::new(4);
        buffer.push(Bytes::from_static(b"123456"));

        assert_eq!(buffer.snapshot().bytes, b"3456");
        assert_eq!(buffer.total_bytes(), 4);
        assert!(buffer.snapshot().truncated);
    }

    #[test]
    fn snapshot_does_not_consume_contents() {
        let mut buffer = OutputRingBuffer::new(8);
        buffer.push(Bytes::from_static(b"abc"));

        assert_eq!(buffer.snapshot(), buffer.snapshot());
        assert_eq!(buffer.total_bytes(), 3);
    }

    #[test]
    fn empty_chunks_do_not_change_state() {
        let mut buffer = OutputRingBuffer::new(4);
        buffer.push(Bytes::new());

        assert_eq!(buffer.snapshot().bytes, b"");
        assert!(!buffer.snapshot().truncated);
    }
}
