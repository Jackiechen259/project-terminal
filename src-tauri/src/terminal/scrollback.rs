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
    pub replay: Vec<ScrollbackReplayEvent>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScrollbackReplayEvent {
    Output(Bytes),
    Resize { rows: u16, cols: u16 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollbackSnapshotFormat {
    /// Flatten retained output for clients that do not understand resize
    /// events, such as the mobile websocket protocol.
    Flat,
    /// Preserve output chunks and resize boundaries for the desktop client.
    Replay,
}

#[derive(Debug)]
pub struct OutputRingBuffer {
    events: VecDeque<ScrollbackReplayEvent>,
    total_bytes: usize,
    max_bytes: usize,
    truncated: bool,
}

impl OutputRingBuffer {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            events: VecDeque::new(),
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
            let last_resize = self.events.iter().rev().find_map(|event| match event {
                ScrollbackReplayEvent::Resize { rows, cols } => {
                    Some(ScrollbackReplayEvent::Resize {
                        rows: *rows,
                        cols: *cols,
                    })
                }
                ScrollbackReplayEvent::Output(_) => None,
            });
            self.events.clear();
            if let Some(resize) = last_resize {
                self.events.push_back(resize);
            }
            self.total_bytes = 0;
            self.truncated = true;
        }

        self.total_bytes += bytes.len();
        self.events.push_back(ScrollbackReplayEvent::Output(bytes));
        while self.total_bytes > self.max_bytes {
            match self.events.pop_front() {
                Some(ScrollbackReplayEvent::Output(removed)) => {
                    self.total_bytes -= removed.len();
                    self.truncated = true;
                }
                Some(ScrollbackReplayEvent::Resize { .. }) => {}
                None => break,
            }
        }
        self.compact_leading_resizes();
    }

    /// Record the grid that subsequent PTY output was rendered against.
    ///
    /// Replaying raw ANSI output at a single, newer grid corrupts dynamic TUIs:
    /// cursor-addressed redraws land on different rows and leave stale frames
    /// behind. Resize events therefore form part of the retained history.
    pub fn resize(&mut self, rows: u16, cols: u16) {
        let event = ScrollbackReplayEvent::Resize { rows, cols };
        if matches!(
            self.events.back(),
            Some(ScrollbackReplayEvent::Resize { .. })
        ) {
            self.events.pop_back();
        }
        self.events.push_back(event);
    }

    pub fn snapshot(&self, format: ScrollbackSnapshotFormat) -> ScrollbackSnapshot {
        let (bytes, replay) = match format {
            ScrollbackSnapshotFormat::Flat => {
                let mut bytes = Vec::with_capacity(self.total_bytes);
                for event in &self.events {
                    if let ScrollbackReplayEvent::Output(chunk) = event {
                        bytes.extend_from_slice(chunk);
                    }
                }
                (bytes, Vec::new())
            }
            // `Bytes` clones share their backing allocation. This keeps the
            // reader's critical section short even with a large scrollback.
            ScrollbackSnapshotFormat::Replay => (Vec::new(), self.events.iter().cloned().collect()),
        };
        ScrollbackSnapshot {
            bytes,
            replay,
            truncated: self.truncated,
        }
    }

    fn compact_leading_resizes(&mut self) {
        let leading_resizes = self
            .events
            .iter()
            .take_while(|event| matches!(event, ScrollbackReplayEvent::Resize { .. }))
            .count();
        for _ in 1..leading_resizes {
            self.events.pop_front();
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

        assert_eq!(
            buffer.snapshot(ScrollbackSnapshotFormat::Flat).bytes,
            [0, 0xff, 0x80, b'A']
        );
        assert!(!buffer.snapshot(ScrollbackSnapshotFormat::Flat).truncated);
    }

    #[test]
    fn drops_oldest_complete_chunks_when_limit_is_exceeded() {
        let mut buffer = OutputRingBuffer::new(6);
        buffer.push(Bytes::from_static(b"abc"));
        buffer.push(Bytes::from_static(b"def"));
        buffer.push(Bytes::from_static(b"gh"));

        assert_eq!(
            buffer.snapshot(ScrollbackSnapshotFormat::Flat).bytes,
            b"defgh"
        );
        assert_eq!(buffer.total_bytes(), 5);
        assert!(buffer.snapshot(ScrollbackSnapshotFormat::Flat).truncated);
    }

    #[test]
    fn keeps_tail_of_a_single_oversized_chunk() {
        let mut buffer = OutputRingBuffer::new(4);
        buffer.push(Bytes::from_static(b"123456"));

        assert_eq!(
            buffer.snapshot(ScrollbackSnapshotFormat::Flat).bytes,
            b"3456"
        );
        assert_eq!(buffer.total_bytes(), 4);
        assert!(buffer.snapshot(ScrollbackSnapshotFormat::Flat).truncated);
    }

    #[test]
    fn snapshot_does_not_consume_contents() {
        let mut buffer = OutputRingBuffer::new(8);
        buffer.push(Bytes::from_static(b"abc"));

        assert_eq!(
            buffer.snapshot(ScrollbackSnapshotFormat::Flat),
            buffer.snapshot(ScrollbackSnapshotFormat::Flat)
        );
        assert_eq!(buffer.total_bytes(), 3);
    }

    #[test]
    fn snapshot_format_does_not_duplicate_retained_output() {
        let mut buffer = OutputRingBuffer::new(8);
        buffer.resize(24, 80);
        buffer.push(Bytes::from_static(b"abc"));

        let flat = buffer.snapshot(ScrollbackSnapshotFormat::Flat);
        assert_eq!(flat.bytes, b"abc");
        assert!(flat.replay.is_empty());

        let replay = buffer.snapshot(ScrollbackSnapshotFormat::Replay);
        assert!(replay.bytes.is_empty());
        assert_eq!(
            replay.replay,
            vec![
                ScrollbackReplayEvent::Resize { rows: 24, cols: 80 },
                ScrollbackReplayEvent::Output(Bytes::from_static(b"abc")),
            ]
        );
    }

    #[test]
    fn empty_chunks_do_not_change_state() {
        let mut buffer = OutputRingBuffer::new(4);
        buffer.push(Bytes::new());

        assert_eq!(buffer.snapshot(ScrollbackSnapshotFormat::Flat).bytes, b"");
        assert!(!buffer.snapshot(ScrollbackSnapshotFormat::Flat).truncated);
    }

    #[test]
    fn snapshot_preserves_resize_boundaries_for_tui_replay() {
        let mut buffer = OutputRingBuffer::new(16);
        buffer.resize(24, 80);
        buffer.push(Bytes::from_static(b"first"));
        buffer.resize(40, 120);
        buffer.push(Bytes::from_static(b"second"));

        assert_eq!(
            buffer.snapshot(ScrollbackSnapshotFormat::Replay).replay,
            vec![
                ScrollbackReplayEvent::Resize { rows: 24, cols: 80 },
                ScrollbackReplayEvent::Output(Bytes::from_static(b"first")),
                ScrollbackReplayEvent::Resize {
                    rows: 40,
                    cols: 120
                },
                ScrollbackReplayEvent::Output(Bytes::from_static(b"second")),
            ]
        );
    }

    #[test]
    fn truncation_keeps_only_the_latest_leading_resize() {
        let mut buffer = OutputRingBuffer::new(4);
        buffer.resize(24, 80);
        buffer.push(Bytes::from_static(b"old"));
        buffer.resize(30, 100);
        buffer.push(Bytes::from_static(b"newer"));

        assert_eq!(
            buffer.snapshot(ScrollbackSnapshotFormat::Replay).replay,
            vec![
                ScrollbackReplayEvent::Resize {
                    rows: 30,
                    cols: 100
                },
                ScrollbackReplayEvent::Output(Bytes::from_static(b"ewer")),
            ]
        );
    }
}
