//! Two-level PTY pump: a dedicated OS-read thread plus a coalescing parse
//! thread.
//!
//! ConPTY writes one paint pass as a single pipe write, but the anonymous
//! pipe's small internal buffer means a blocking `read` usually sees that
//! pass split across several reads. Feeding the terminal model once per raw
//! `read` (the old design) let the frame scheduler observe - and publish - a
//! mid-repaint state: a redraw half-applied, or the cursor stopped wherever
//! the read boundary happened to land, because a `feed`/`take_render_frame`
//! race can interleave between any two reads (see `session.rs`'s reader for
//! the lock discipline this depends on).
//!
//! The fix mirrors upstream wezterm's mux (`mux/src/lib.rs`): read the
//! bytes, then wait a short idle window for the rest of the same paint pass
//! to arrive before handing anything to the model. The read thread only
//! performs the blocking OS `read` and forwards raw chunks over a channel;
//! the parse thread owns all the coalescing timing and calls `on_burst`
//! exactly once per coalesced burst - so a caller that takes a lock inside
//! `on_burst` (feeding a terminal model, notifying a scheduler) takes that
//! lock once per burst, never once per syscall.

use std::io::Read;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Single OS `read` buffer size. A ConPTY paint pass is commonly larger than
/// this (the anonymous pipe's own buffer is small), so one paint pass is
/// expected to arrive as several reads - that is exactly what
/// `BurstCoalescer` exists to reassemble.
const PTY_READ_BUFFER_BYTES: usize = 64 * 1024;

/// How long to wait, after the most recently received chunk, for another one
/// before considering a burst finished.
const COALESCE_IDLE: Duration = Duration::from_millis(2);

/// Hard ceiling on how long a single burst may keep growing, regardless of
/// how tightly packed the incoming chunks are. Bounds worst-case input
/// latency (a keystroke echo waiting behind a burst) under sustained output.
const COALESCE_MAX_WAIT: Duration = Duration::from_millis(10);

/// Hard ceiling on how large a single burst may grow, regardless of timing.
/// Bounds the terminal-model lock's worst-case hold time - see the risk note
/// in the design plan this module implements.
const COALESCE_MAX_BYTES: usize = 256 * 1024;

/// Poll interval used while waiting out the idle/max-wait window.
/// `mpsc::Receiver::recv_timeout` is condvar-based, and on Windows a condvar
/// timeout is quantized to the ~15.6ms system timer tick - far coarser than
/// the 2ms idle window above. `thread::sleep`, by contrast, is backed by a
/// high-resolution waitable timer (stable since Rust 1.77, matching this
/// crate's `rust-version`), so a short sleep-poll loop is the more precise
/// wait primitive here. A burst wakes this thread on the order of
/// `COALESCE_IDLE / COALESCE_POLL` (~4) times; an idle session spends the
/// whole wait blocked in `recv()`, so this costs nothing when nothing is
/// happening. See the `timer_granularity_probe` test for a one-off measure
/// of `thread::sleep`'s actual precision on the machine running it.
const COALESCE_POLL: Duration = Duration::from_micros(500);

/// Bounded so a stalled parse thread applies backpressure to the OS read
/// loop instead of letting it buffer an unbounded amount of PTY output in
/// memory.
const CHUNK_CHANNEL_CAPACITY: usize = 64;

/// Coalesces raw PTY-read chunks, received over a channel, into bursts.
///
/// `next_burst` blocks (at zero CPU cost) for the first chunk of a new
/// burst, then coalesces any further chunks that arrive within `idle` of the
/// previous one, up to `max_wait` total or `max_bytes` total - whichever
/// comes first.
struct BurstCoalescer {
    rx: mpsc::Receiver<Vec<u8>>,
    idle: Duration,
    max_wait: Duration,
    max_bytes: usize,
    /// The tail of a chunk that would have pushed the previous burst past
    /// `max_bytes`, held here so the next call to `next_burst` starts from
    /// it instead of blocking on the channel. Keeps the byte cap a true
    /// hard ceiling (see `COALESCE_MAX_BYTES`) without losing or reordering
    /// any bytes - a chunk is simply split across two bursts instead of
    /// landing whole in one, exactly as it could already be split across
    /// two raw PTY reads upstream.
    carryover: Vec<u8>,
}

/// Appends as much of `chunk` to `burst` as fits within `max_bytes` total,
/// returning any leftover suffix that didn't fit.
fn append_capped(burst: &mut Vec<u8>, chunk: Vec<u8>, max_bytes: usize) -> Option<Vec<u8>> {
    let remaining = max_bytes.saturating_sub(burst.len());
    if chunk.len() <= remaining {
        burst.extend_from_slice(&chunk);
        None
    } else {
        burst.extend_from_slice(&chunk[..remaining]);
        Some(chunk[remaining..].to_vec())
    }
}

impl BurstCoalescer {
    fn new(
        rx: mpsc::Receiver<Vec<u8>>,
        idle: Duration,
        max_wait: Duration,
        max_bytes: usize,
    ) -> Self {
        Self {
            rx,
            idle,
            max_wait,
            max_bytes,
            carryover: Vec::new(),
        }
    }

    /// Returns the next coalesced burst, or `None` once the sender has
    /// disconnected and every chunk it ever sent has already been returned
    /// by an earlier call - i.e. the PTY reader hit EOF/error and there is
    /// nothing left to deliver. A channel keeps delivering messages already
    /// sent regardless of whether the sender has since been dropped, so no
    /// byte the reader thread handed off is ever lost to this transition.
    fn next_burst(&mut self) -> Option<Vec<u8>> {
        // A chunk carried over from the previous burst (because it would
        // have overshot the cap) takes priority over blocking for a new
        // one - it is already-received data waiting to be delivered.
        let first = if self.carryover.is_empty() {
            // Blocks at zero CPU cost - the whole point of putting the
            // blocking OS read on its own thread.
            self.rx.recv().ok()?
        } else {
            std::mem::take(&mut self.carryover)
        };

        let mut burst = Vec::with_capacity(first.len().min(self.max_bytes));
        if let Some(leftover) = append_capped(&mut burst, first, self.max_bytes) {
            // The very first chunk alone already fills (or overshoots) the
            // cap; stash the rest and return immediately without waiting.
            self.carryover = leftover;
            return Some(burst);
        }

        let first_chunk_at = Instant::now();
        let mut last_chunk_at = first_chunk_at;

        while burst.len() < self.max_bytes {
            let deadline = (last_chunk_at + self.idle).min(first_chunk_at + self.max_wait);
            if Instant::now() >= deadline {
                break;
            }
            match self.rx.try_recv() {
                Ok(chunk) => {
                    if let Some(leftover) = append_capped(&mut burst, chunk, self.max_bytes) {
                        // Appending the whole chunk would break the hard
                        // cap - take only what fits and carry the rest
                        // over to the next burst instead of dropping it.
                        self.carryover = leftover;
                        break;
                    }
                    last_chunk_at = Instant::now();
                }
                Err(mpsc::TryRecvError::Empty) => thread::sleep(COALESCE_POLL),
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
        }

        Some(burst)
    }
}

/// Spawns the two-level pump described in the module doc: a `pty-read-*`
/// thread that only performs the blocking OS `read`, and a `pty-parse-*`
/// thread that coalesces those reads into bursts and calls `on_burst` once
/// per burst.
///
/// `on_burst` only ever sees a complete, coalesced burst - never a bare
/// mid-syscall slice - so a caller that takes a lock inside it (feeding a
/// terminal model, say) takes that lock once per burst, not once per raw PTY
/// `read`.
pub(crate) fn spawn_pty_pump<R>(
    session_id: &str,
    mut reader: R,
    mut on_burst: impl FnMut(&[u8]) + Send + 'static,
) where
    R: Read + Send + 'static,
{
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(CHUNK_CHANNEL_CAPACITY);

    thread::Builder::new()
        .name(format!("pty-read-{session_id}"))
        .spawn(move || {
            let mut buf = vec![0u8; PTY_READ_BUFFER_BYTES];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            // The parse thread is gone; nothing left to feed.
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                    Err(_) => break,
                }
            }
            // Dropping `tx` here is the EOF signal `next_burst` relies on:
            // any bytes already sent are still delivered (a channel keeps
            // buffered messages independent of the sender's lifetime), and
            // the very next `recv` after they are drained fails cleanly.
        })
        .expect("spawn pty-read thread");

    thread::Builder::new()
        .name(format!("pty-parse-{session_id}"))
        .spawn(move || {
            let mut coalescer =
                BurstCoalescer::new(rx, COALESCE_IDLE, COALESCE_MAX_WAIT, COALESCE_MAX_BYTES);
            while let Some(burst) = coalescer.next_burst() {
                on_burst(&burst);
            }
        })
        .expect("spawn pty-parse thread");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn make_coalescer(
        idle_ms: u64,
        max_wait_ms: u64,
        max_bytes: usize,
    ) -> (mpsc::SyncSender<Vec<u8>>, BurstCoalescer) {
        let (tx, rx) = mpsc::sync_channel(CHUNK_CHANNEL_CAPACITY);
        let coalescer = BurstCoalescer::new(
            rx,
            Duration::from_millis(idle_ms),
            Duration::from_millis(max_wait_ms),
            max_bytes,
        );
        (tx, coalescer)
    }

    #[test]
    fn coalesces_chunks_that_arrive_within_the_idle_window() {
        let (tx, mut coalescer) = make_coalescer(30, 500, 1024 * 1024);
        let sender = thread::spawn(move || {
            tx.send(b"abc".to_vec()).unwrap();
            thread::sleep(Duration::from_millis(5));
            tx.send(b"def".to_vec()).unwrap();
            thread::sleep(Duration::from_millis(5));
            tx.send(b"ghi".to_vec()).unwrap();
        });

        let burst = coalescer.next_burst().expect("burst");
        sender.join().unwrap();
        assert_eq!(burst, b"abcdefghi");
    }

    #[test]
    fn splits_bursts_at_a_quiet_gap() {
        let (tx, mut coalescer) = make_coalescer(15, 500, 1024 * 1024);
        tx.send(b"first".to_vec()).unwrap();

        let first = coalescer.next_burst().expect("first burst");
        assert_eq!(first, b"first");

        thread::sleep(Duration::from_millis(30));
        tx.send(b"second".to_vec()).unwrap();
        let second = coalescer.next_burst().expect("second burst");
        assert_eq!(
            second, b"second",
            "a burst separated by a quiet gap must not merge with the previous one"
        );
    }

    #[test]
    fn caps_a_burst_at_max_bytes() {
        let (tx, mut coalescer) = make_coalescer(15, 500, 10);
        tx.send(b"AAAAAA".to_vec()).unwrap();
        tx.send(b"BBBBBB".to_vec()).unwrap();
        tx.send(b"CCCCCC".to_vec()).unwrap();

        // The cap is a hard ceiling: a chunk that would push the burst past
        // it is split, not appended whole. 6 ("AAAAAA") + 6 ("BBBBBB") would
        // be 12 bytes, so only the first 4 bytes of "BBBBBB" are taken.
        let burst = coalescer.next_burst().expect("capped burst");
        assert!(
            burst.len() <= 10,
            "burst must never exceed the byte cap, even mid-chunk: {burst:?}"
        );
        assert_eq!(
            burst, b"AAAAAABBBB",
            "burst must stop growing exactly at the byte cap, splitting the chunk if needed"
        );

        // The two bytes of "BBBBBB" that didn't fit must carry over - not be
        // dropped or reordered - followed by the untouched "CCCCCC" chunk.
        let rest = coalescer.next_burst().expect("remaining bytes");
        assert_eq!(
            rest, b"BBCCCCCC",
            "bytes past the cap must carry over to the next burst in order, not be dropped"
        );
    }

    #[test]
    fn carries_over_split_bytes_even_when_they_alone_exceed_the_next_cap() {
        // A degenerate but real case: the carried-over remainder from one
        // burst is itself larger than max_bytes (only possible with a very
        // small cap, as in this test). The next burst must still return
        // no more than max_bytes and preserve the rest for the burst after.
        let (tx, mut coalescer) = make_coalescer(15, 500, 3);
        tx.send(b"AAAAAAAAAA".to_vec()).unwrap(); // 10 bytes, way over cap

        let first = coalescer.next_burst().expect("first burst");
        assert_eq!(first, b"AAA");
        let second = coalescer.next_burst().expect("second burst");
        assert_eq!(second, b"AAA");
        let third = coalescer.next_burst().expect("third burst");
        assert_eq!(third, b"AAA");
        let fourth = coalescer.next_burst().expect("fourth burst");
        assert_eq!(
            fourth, b"A",
            "the final leftover byte must not be lost once the source chunk is exhausted"
        );
    }

    #[test]
    fn flushes_the_tail_when_the_reader_hangs_up() {
        let (tx, mut coalescer) = make_coalescer(30, 500, 1024 * 1024);
        tx.send(b"tail".to_vec()).unwrap();
        drop(tx);

        let burst = coalescer
            .next_burst()
            .expect("the tail must survive the sender hanging up");
        assert_eq!(burst, b"tail");

        assert!(
            coalescer.next_burst().is_none(),
            "once the tail is drained, the coalescer must report EOF"
        );
    }

    /// A `Read` stand-in that hands back pre-queued chunks one per `read`
    /// call, then reports EOF (`Ok(0)`) once the queue is empty - simulating
    /// one ConPTY paint pass arriving as several physical reads.
    struct ChunkedReader {
        chunks: VecDeque<Vec<u8>>,
    }

    impl Read for ChunkedReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.chunks.pop_front() {
                Some(chunk) => {
                    let n = chunk.len().min(buf.len());
                    buf[..n].copy_from_slice(&chunk[..n]);
                    Ok(n)
                }
                None => Ok(0),
            }
        }
    }

    #[test]
    fn pump_applies_a_multi_read_burst_as_one_callback() {
        let reader = ChunkedReader {
            chunks: VecDeque::from(vec![b"AAAA".to_vec(), b"BBBB".to_vec(), b"CCCC".to_vec()]),
        };

        let (result_tx, result_rx) = mpsc::channel::<Vec<u8>>();
        spawn_pty_pump("pump-test", reader, move |burst: &[u8]| {
            let _ = result_tx.send(burst.to_vec());
        });

        let mut bursts = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match result_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(burst) => bursts.push(burst),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !bursts.is_empty() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        assert_eq!(
            bursts.len(),
            1,
            "a burst split across multiple physical reads must reach on_burst as one callback: {bursts:?}"
        );
        assert_eq!(bursts[0], b"AAAABBBBCCCC");
    }

    #[test]
    #[ignore = "one-off timer-granularity probe; run with `cargo test --manifest-path src-tauri/Cargo.toml --test unit timer_granularity_probe -- --ignored --nocapture`"]
    fn timer_granularity_probe() {
        const SAMPLES: usize = 200;
        let mut deltas = Vec::with_capacity(SAMPLES);
        for _ in 0..SAMPLES {
            let start = Instant::now();
            thread::sleep(COALESCE_POLL);
            deltas.push(start.elapsed());
        }
        deltas.sort();
        let p50 = deltas[SAMPLES / 2];
        let p95 = deltas[(SAMPLES * 95) / 100];
        println!(
            "thread::sleep({COALESCE_POLL:?}) over {SAMPLES} samples: p50={p50:?} p95={p95:?} min={:?} max={:?}",
            deltas.first().unwrap(),
            deltas.last().unwrap(),
        );
    }
}
