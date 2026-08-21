//! Frame-batched delivery for Rust-owned terminal models.
//!
//! PTY reads can arrive much faster than a WebView can paint. This scheduler
//! wakes only when a renderer is attached, waits one frame interval to coalesce
//! output, and then extracts one dirty-row frame from the session model. A
//! session with no frame subscribers keeps parsing and retaining terminal state
//! but does not continuously serialize or publish render frames.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex as StdMutex};
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::broadcast;

use crate::terminal_engine::{
    RenderFrame, TerminalControlEvent, TerminalEngine, WeztermTerminalEngine,
};

const FRAME_INTERVAL: Duration = Duration::from_millis(16);
const FRAME_CHANNEL_CAPACITY: usize = 32;
const CONTROL_CHANNEL_CAPACITY: usize = 128;

pub struct TerminalFrameSubscription {
    pub frames: broadcast::Receiver<Arc<RenderFrame>>,
    pub controls: broadcast::Receiver<Arc<TerminalControlEvent>>,
    pub cancellation: tokio::sync::watch::Receiver<bool>,
}

pub struct TerminalFrameHub {
    frames: broadcast::Sender<Arc<RenderFrame>>,
    controls: broadcast::Sender<Arc<TerminalControlEvent>>,
    signal: Arc<(StdMutex<bool>, Condvar)>,
    shutdown: AtomicBool,
}

impl TerminalFrameHub {
    pub fn new(engine: Arc<Mutex<WeztermTerminalEngine>>) -> Arc<Self> {
        let (frames, _) = broadcast::channel(FRAME_CHANNEL_CAPACITY);
        let (controls, _) = broadcast::channel(CONTROL_CHANNEL_CAPACITY);
        let hub = Arc::new(Self {
            frames,
            controls,
            signal: Arc::new((StdMutex::new(false), Condvar::new())),
            shutdown: AtomicBool::new(false),
        });

        let hub_for_thread = Arc::clone(&hub);
        thread::spawn(move || run_scheduler(engine, hub_for_thread));
        hub
    }

    pub fn subscribe(&self) -> TerminalFrameSubscription {
        let cancellation = tokio::sync::watch::channel(false).1;
        TerminalFrameSubscription {
            frames: self.frames.subscribe(),
            controls: self.controls.subscribe(),
            cancellation,
        }
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
        let (pending, wake) = &*self.signal;
        *pending.lock().unwrap() = true;
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
        drop(is_pending);

        if hub.shutdown.load(Ordering::Acquire) {
            return;
        }
        if hub.frames.receiver_count() == 0 && hub.controls.receiver_count() == 0 {
            continue;
        }

        let (frame, controls) = {
            let mut model = engine.lock();
            let frame = model.take_render_frame().map(Arc::new);
            let controls = model
                .drain_control_events()
                .into_iter()
                .map(Arc::new)
                .collect::<Vec<_>>();
            (frame, controls)
        };

        if let Some(frame) = frame {
            let _ = hub.frames.send(frame);
        }
        for event in controls {
            let _ = hub.controls.send(event);
        }
        last_frame_at = Some(Instant::now());
    }
}
