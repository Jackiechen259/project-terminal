//! Frame-batched delivery for Rust-owned terminal models.
//!
//! PTY reads can arrive much faster than a WebView can paint. This scheduler
//! wakes only when a renderer is attached, waits one frame interval to coalesce
//! output, and then extracts one dirty-row frame from the session model. A
//! session with no frame subscribers keeps parsing and retaining terminal state
//! but does not continuously serialize or publish render frames.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex as StdMutex};
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::broadcast;

use crate::terminal_engine::{
    RenderFrame, TerminalControlEvent, TerminalEngine, WeztermTerminalEngine,
};

const FRAME_INTERVAL: Duration = Duration::from_millis(16);
const FRAME_CHANNEL_CAPACITY: usize = 4;
const IN_FLIGHT_TIMEOUT: Duration = Duration::from_millis(80);
const CONTROL_CHANNEL_CAPACITY: usize = 128;

pub struct TerminalFrameSubscription {
    pub frames: broadcast::Receiver<Arc<RenderFrame>>,
    pub controls: broadcast::Receiver<Arc<TerminalControlEvent>>,
    pub cancellation: tokio::sync::watch::Receiver<bool>,
    pub paused: tokio::sync::watch::Receiver<bool>,
    pub(crate) hub: Arc<TerminalFrameHub>,
}

impl TerminalFrameSubscription {
    /// Release scheduler backpressure after this frame has been serialized
    /// onto the renderer transport. Skipping this stalls later extracts so
    /// dirty rows accumulate instead of overflowing the broadcast buffer.
    pub fn note_consumed(&self) {
        self.hub.mark_frame_consumed();
    }
}

pub struct TerminalFrameHub {
    frames: broadcast::Sender<Arc<RenderFrame>>,
    controls: broadcast::Sender<Arc<TerminalControlEvent>>,
    signal: Arc<(StdMutex<bool>, Condvar)>,
    /// Mirrors the `bool` inside `signal`. A PTY reader that outpaces the
    /// scheduler calls `notify()` far more often than the scheduler actually
    /// wakes; once a wake is already pending, later reads in the same frame
    /// window can skip the mutex lock and condvar notify entirely.
    pending: AtomicBool,
    shutdown: AtomicBool,
    /// True while a published frame has not yet been acknowledged by a
    /// consumer. The scheduler refuses to extract another frame until this
    /// clears, so wezterm dirty tracking accumulates instead of dropping
    /// rows and then forcing a full snapshot.
    in_flight: AtomicBool,
    /// Subscribers that currently want render frames. Hidden desktop views
    /// decrement this; control events still flow. Extract is skipped when
    /// the count is zero so a background agent TUI does not serialize JSON.
    active_frame_consumers: AtomicUsize,
}

impl TerminalFrameHub {
    pub fn new(engine: Arc<Mutex<WeztermTerminalEngine>>) -> Arc<Self> {
        let (frames, _) = broadcast::channel(FRAME_CHANNEL_CAPACITY);
        let (controls, _) = broadcast::channel(CONTROL_CHANNEL_CAPACITY);
        let hub = Arc::new(Self {
            frames,
            controls,
            signal: Arc::new((StdMutex::new(false), Condvar::new())),
            pending: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            in_flight: AtomicBool::new(false),
            active_frame_consumers: AtomicUsize::new(0),
        });

        let hub_for_thread = Arc::clone(&hub);
        thread::spawn(move || run_scheduler(engine, hub_for_thread));
        hub
    }

    pub fn subscribe(self: &Arc<Self>) -> TerminalFrameSubscription {
        self.active_frame_consumers.fetch_add(1, Ordering::AcqRel);
        let cancellation = tokio::sync::watch::channel(false).1;
        let paused = tokio::sync::watch::channel(false).1;
        TerminalFrameSubscription {
            frames: self.frames.subscribe(),
            controls: self.controls.subscribe(),
            cancellation,
            paused,
            hub: Arc::clone(self),
        }
    }

    pub fn pause_frame_delivery(&self) {
        self.active_frame_consumers
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                Some(count.saturating_sub(1))
            })
            .ok();
    }

    pub fn resume_frame_delivery(&self) {
        self.active_frame_consumers.fetch_add(1, Ordering::AcqRel);
        self.notify();
    }

    fn wants_frames(&self) -> bool {
        self.active_frame_consumers.load(Ordering::Acquire) > 0
    }

    pub fn mark_frame_consumed(&self) {
        self.in_flight.store(false, Ordering::Release);
        // Always wake the scheduler. `notify()` coalesces through `pending`
        // and can skip the condvar if a PTY burst already set it, which
        // would leave this wait sitting until `IN_FLIGHT_TIMEOUT`.
        let (pending, wake) = &*self.signal;
        *pending.lock().unwrap() = true;
        self.pending.store(true, Ordering::Release);
        wake.notify_one();
    }

    pub fn renderer_count(&self) -> usize {
        self.frames.receiver_count()
    }

    pub fn notify(&self) {
        // A background session must not wake a scheduler that has no renderer
        // attached. Attachment itself calls notify after requesting a full
        // snapshot, so no state is lost by this fast path.
        if self.frames.receiver_count() == 0 && self.controls.receiver_count() == 0 {
            return;
        }
        // A PTY reader that outpaces the scheduler calls this far more often
        // than the scheduler actually wakes. Once a wake is already pending,
        // skip the mutex lock and condvar notify entirely - only the
        // false->true transition needs to touch `signal`. In the rare case
        // this races with the scheduler's own reset of `pending` (see
        // `run_scheduler`), the very next notify (or the next PTY read,
        // resize, or renderer attach - all of which also call `notify`)
        // still wakes it, since the model itself already has this data via
        // `feed()`; nothing is lost, at most a frame is briefly delayed.
        if self.pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let (signal_pending, wake) = &*self.signal;
        *signal_pending.lock().unwrap() = true;
        wake.notify_one();
    }

    pub fn shutdown(&self) {
        if self.shutdown.swap(true, Ordering::AcqRel) {
            return;
        }
        let (pending, wake) = &*self.signal;
        *pending.lock().unwrap() = true;
        wake.notify_one();
    }
}

fn run_scheduler(engine: Arc<Mutex<WeztermTerminalEngine>>, hub: Arc<TerminalFrameHub>) {
    let mut last_frame_at: Option<Instant> = None;

    loop {
        let (pending, wake) = &*hub.signal;
        let mut is_pending = pending.lock().unwrap();
        while !*is_pending && !hub.shutdown.load(Ordering::Acquire) {
            is_pending = wake.wait(is_pending).unwrap();
        }
        if hub.shutdown.load(Ordering::Acquire) {
            return;
        }
        *is_pending = false;
        hub.pending.store(false, Ordering::Release);

        // Enforce a maximum frame rate while still allowing notifications to
        // accumulate during the wait. The first frame is intentionally
        // delayed by one interval so a startup burst becomes one snapshot.
        let target = last_frame_at
            .map(|last| last + FRAME_INTERVAL)
            .unwrap_or_else(|| Instant::now() + FRAME_INTERVAL);
        while Instant::now() < target && !hub.shutdown.load(Ordering::Acquire) {
            let remaining = target.saturating_duration_since(Instant::now());
            let (next, _) = wake.wait_timeout(is_pending, remaining).unwrap();
            is_pending = next;
        }
        if hub.in_flight.load(Ordering::Acquire) {
            let deadline = Instant::now() + IN_FLIGHT_TIMEOUT;
            while hub.in_flight.load(Ordering::Acquire)
                && Instant::now() < deadline
                && !hub.shutdown.load(Ordering::Acquire)
            {
                let remaining = deadline.saturating_duration_since(Instant::now());
                let (next, _) = wake.wait_timeout(is_pending, remaining).unwrap();
                is_pending = next;
            }
            if hub.in_flight.load(Ordering::Acquire) {
                hub.in_flight.store(false, Ordering::Release);
            }
        }
        drop(is_pending);

        if hub.shutdown.load(Ordering::Acquire) {
            return;
        }
        if hub.frames.receiver_count() == 0 && hub.controls.receiver_count() == 0 {
            continue;
        }

        let (frame, controls) = {
            let mut model = engine.lock();
            let frame = if hub.wants_frames() {
                model.take_render_frame().map(Arc::new)
            } else {
                None
            };
            let controls = model
                .drain_control_events()
                .into_iter()
                .map(Arc::new)
                .collect::<Vec<_>>();
            (frame, controls)
        };

        let extracted = frame.is_some();
        if let Some(frame) = frame {
            hub.in_flight.store(true, Ordering::Release);
            if hub.frames.send(frame).is_err() {
                hub.in_flight.store(false, Ordering::Release);
            }
        }
        for event in controls {
            let _ = hub.controls.send(event);
        }
        last_frame_at = Some(Instant::now());

        // A DECSET 2026 hold has no further PTY bytes until the TUI ends the
        // frame (or the 1s total-duration cap fires - see
        // `sync_output::HOLD_TIMEOUT`). Wake the scheduler ourselves so a
        // stuck hold still flushes instead of freezing the pane.
        if !extracted && hub.wants_frames() {
            if let Some(remaining) = engine.lock().synchronized_hold_remaining() {
                let (pending_lock, wake) = &*hub.signal;
                let mut is_pending = pending_lock.lock().unwrap();
                if !*is_pending && !hub.shutdown.load(Ordering::Acquire) {
                    let (next, _) = wake.wait_timeout(is_pending, remaining).unwrap();
                    is_pending = next;
                }
                *is_pending = true;
                hub.pending.store(true, Ordering::Release);
                drop(is_pending);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_engine::{TerminalControlEvent, TerminalEngine, WeztermTerminalConfig};
    use std::io::Write;
    use std::time::Instant;
    use wezterm_term::TerminalSize;

    struct NoopWriter;

    impl Write for NoopWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn engine() -> WeztermTerminalEngine {
        WeztermTerminalEngine::new(
            TerminalSize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
                dpi: 96,
            },
            WeztermTerminalConfig::default(),
            Box::new(NoopWriter),
        )
    }

    #[test]
    fn coalesces_a_burst_before_paint_into_one_frame() {
        let model = Arc::new(Mutex::new(engine()));
        let hub = TerminalFrameHub::new(Arc::clone(&model));
        let mut subscription = hub.subscribe();

        // Hold the model lock while feeding the burst so the scheduler cannot
        // observe a partial burst. The production reader (`pty_pump`) also
        // takes this same lock only once per coalesced burst rather than
        // once per raw PTY read now, but this test still holds it across the
        // whole loop below so every notification within one frame window
        // collapses to the latest model state regardless of how many `feed`
        // calls produced it.
        {
            let mut model = model.lock();
            for index in 0..100 {
                model.feed(format!("output-{index:03}\r\n").as_bytes());
            }
        }
        hub.notify();

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut frames = Vec::new();
        while Instant::now() < deadline && frames.is_empty() {
            match subscription.frames.try_recv() {
                Ok(frame) => {
                    subscription.note_consumed();
                    frames.push(frame);
                }
                Err(broadcast::error::TryRecvError::Empty) => {
                    thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("frame scheduler failed: {error}"),
            }
        }
        assert_eq!(frames.len(), 1, "initial burst was not painted");

        // Allow one additional frame interval. Since no model state changed,
        // the scheduler may wake, but it must not publish a second frame.
        thread::sleep(FRAME_INTERVAL + Duration::from_millis(8));
        while let Ok(frame) = subscription.frames.try_recv() {
            frames.push(frame);
        }
        assert_eq!(frames.len(), 1, "a no-op scheduler tick emitted a frame");

        hub.shutdown();
    }

    #[test]
    fn holds_dirty_rows_until_the_previous_frame_is_consumed() {
        let model = Arc::new(Mutex::new(engine()));
        let hub = TerminalFrameHub::new(Arc::clone(&model));
        let mut subscription = hub.subscribe();

        {
            let mut model = model.lock();
            model.feed(b"one\r\n");
        }
        hub.notify();

        let deadline = Instant::now() + Duration::from_secs(2);
        let first = loop {
            match subscription.frames.try_recv() {
                Ok(frame) => break frame,
                Err(broadcast::error::TryRecvError::Empty) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("first frame failed: {error}"),
            }
        };
        assert!(
            first
                .dirty_rows
                .iter()
                .any(|row| row.cells.iter().any(|cell| cell.text.contains("one"))),
            "first frame missed the initial output"
        );

        {
            let mut model = model.lock();
            model.feed(b"two\r\n");
        }
        hub.notify();
        thread::sleep(FRAME_INTERVAL + Duration::from_millis(8));
        match subscription.frames.try_recv() {
            Ok(_) => panic!("extracted a second frame before the first was consumed"),
            Err(broadcast::error::TryRecvError::Empty) => {}
            Err(error) => panic!("backpressure check failed: {error}"),
        }

        subscription.note_consumed();
        let deadline = Instant::now() + Duration::from_secs(2);
        let second = loop {
            match subscription.frames.try_recv() {
                Ok(frame) => {
                    subscription.note_consumed();
                    break frame;
                }
                Err(broadcast::error::TryRecvError::Empty) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("second frame failed: {error}"),
            }
        };
        assert!(
            second
                .dirty_rows
                .iter()
                .any(|row| row.cells.iter().any(|cell| cell.text.contains("two"))),
            "accumulated output was lost while the first frame was in flight"
        );

        hub.shutdown();
    }

    #[test]
    fn skips_frame_extract_while_every_subscriber_is_paused_but_still_emits_controls() {
        let model = Arc::new(Mutex::new(engine()));
        let hub = TerminalFrameHub::new(Arc::clone(&model));
        let mut subscription = hub.subscribe();
        hub.pause_frame_delivery();

        {
            let mut model = model.lock();
            model.feed(b"hidden\r\n\x07");
        }
        hub.notify();
        thread::sleep(FRAME_INTERVAL + Duration::from_millis(8));
        match subscription.frames.try_recv() {
            Ok(_) => panic!("extracted a frame while every subscriber was paused"),
            Err(broadcast::error::TryRecvError::Empty) => {}
            Err(error) => panic!("paused extract check failed: {error}"),
        }
        let mut saw_bell = false;
        let deadline = Instant::now() + Duration::from_secs(2);
        while !saw_bell && Instant::now() < deadline {
            while let Ok(event) = subscription.controls.try_recv() {
                if matches!(event.as_ref(), TerminalControlEvent::Bell) {
                    saw_bell = true;
                }
            }
            if !saw_bell {
                thread::sleep(Duration::from_millis(2));
            }
        }
        assert!(
            saw_bell,
            "control events must still flow while frames are paused"
        );

        hub.shutdown();
    }

    #[test]
    fn extracts_again_after_one_subscriber_resumes() {
        let model = Arc::new(Mutex::new(engine()));
        let hub = TerminalFrameHub::new(Arc::clone(&model));
        let mut subscription = hub.subscribe();
        hub.pause_frame_delivery();

        {
            let mut model = model.lock();
            model.feed(b"paused-output\r\n");
        }
        hub.notify();
        thread::sleep(FRAME_INTERVAL + Duration::from_millis(8));
        assert!(
            matches!(
                subscription.frames.try_recv(),
                Err(broadcast::error::TryRecvError::Empty)
            ),
            "paused subscriber still received a frame"
        );

        {
            let mut model = model.lock();
            model.request_full_snapshot();
        }
        hub.resume_frame_delivery();

        let deadline = Instant::now() + Duration::from_secs(2);
        let resumed = loop {
            match subscription.frames.try_recv() {
                Ok(frame) => {
                    subscription.note_consumed();
                    break frame;
                }
                Err(broadcast::error::TryRecvError::Empty) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("resumed frame failed: {error}"),
            }
        };
        assert!(
            resumed.dirty_rows.iter().any(|row| row
                .cells
                .iter()
                .any(|cell| cell.text.contains("paused-output"))),
            "resume snapshot missed output accumulated while paused"
        );

        hub.shutdown();
    }
}
