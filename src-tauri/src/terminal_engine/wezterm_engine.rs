use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use wezterm_term::input::{KeyCode, KeyModifiers};
use wezterm_term::{Alert, AlertHandler, Terminal, TerminalConfiguration, TerminalSize};

use super::config::WeztermTerminalConfig;
use super::input::{TerminalKeyEvent, TerminalMouseEvent};
use super::render_frame::{
    cursor_state, render_row, CursorState, CursorVisibility, RenderFrame, TerminalControlEvent,
};
use super::search::{
    TerminalSearchDirection, TerminalSearchMatch, TerminalSearchPosition, TerminalSearchQuery,
};
use super::selection::TerminalSelectionPoint;
use super::sync_output::SynchronizedOutput;
use super::TerminalEngine;

const DECRQM_SYNCHRONIZED_OUTPUT_REPLY: &[u8] = b"\x1b[?2026;2$y";

struct SharedWriter {
    inner: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.inner.lock().unwrap().write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.lock().unwrap().flush()
    }
}

/// How long a bare DECTCEM hide is treated as provisional.
///
/// A TUI repaint is bracketed by `CSI ? 25 l` ... `CSI ? 25 h`, and ConPTY
/// hands those to us as separate reads, so publishing the hide immediately
/// makes the cursor strobe once per keystroke at a shell prompt. This is the
/// same "do not paint a half-finished repaint" problem `sync_output` solves
/// for apps that speak DECSET 2026; the grace window covers the apps that do
/// not. It only ever delays a hide - a hide that outlives the window is
/// published normally, so an app that genuinely parks its cursor off-screen
/// still gets what it asked for.
const CURSOR_HIDE_GRACE: Duration = Duration::from_millis(90);

const CONTROL_EVENT_CAPACITY: usize = 256;
const IMAGE_CACHE_KEY_CAPACITY: usize = 1_024;

fn find_osc_terminator(bytes: &[u8]) -> Option<(usize, usize)> {
    for index in 0..bytes.len() {
        if bytes[index] == 0x07 {
            return Some((index, 1));
        }
        if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
            return Some((index, 2));
        }
    }
    None
}

/// A wezterm-term adapter owned by one terminal session.
///
/// The PTY reader calls `feed`; a separate attachment/frame scheduler calls
/// `take_render_frame`.  The two operations are intentionally independent so
/// PTY read frequency never dictates IPC frequency.
///
/// Contract with the caller of `feed`: each call must carry one complete
/// output burst - everything one ConPTY paint pass wrote, coalesced by the
/// PTY pump (`terminal::pty_pump`) - applied under a single lock acquisition.
/// Between any two `feed` calls, whatever `take_render_frame` observes is
/// state that is actually eligible to be rendered; feeding a mid-repaint
/// slice (half a redraw, a cursor hidden only because DECTCEM has not been
/// re-enabled yet) makes that torn state paintable too.
pub struct WeztermTerminalEngine {
    terminal: Terminal,
    /// WezTerm's sequence number is used internally for dirty-row queries;
    /// this separate counter is the monotonic transport sequence exposed to
    /// renderers. A full snapshot or viewport move can happen without a
    /// model mutation, so it must still receive a newer IPC sequence.
    last_frame_sequence: u64,
    last_emitted_sequence: usize,
    last_cursor: Option<CursorState>,
    /// When the model first reported a hidden cursor that has not been
    /// published yet. See `CURSOR_HIDE_GRACE`.
    cursor_hide_pending_since: Option<Instant>,
    last_scrollback_length: usize,
    last_alternate_screen: bool,
    last_mouse_reporting: bool,
    last_viewport_top: Option<i64>,
    last_viewport_bottom: Option<i64>,
    /// The last title authored by the shell/application through an OSC title
    /// sequence. This is deliberately separate from `Terminal::get_title()`:
    /// wezterm-term initializes its internal window title to "wezterm", which
    /// is model state rather than a user-authored terminal title.
    last_title: Arc<Mutex<Option<String>>>,
    last_cwd: Option<String>,
    force_full_snapshot: bool,
    viewport_top: Option<i64>,
    control_events: Arc<Mutex<VecDeque<TerminalControlEvent>>>,
    osc133_buffer: Vec<u8>,
    known_image_keys: HashSet<String>,
    sync_output: SynchronizedOutput,
    reply_writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

#[derive(Clone)]
struct AlertCollector {
    events: Arc<Mutex<VecDeque<TerminalControlEvent>>>,
    last_title: Arc<Mutex<Option<String>>>,
}

fn push_control_event(
    events: &Arc<Mutex<VecDeque<TerminalControlEvent>>>,
    event: TerminalControlEvent,
) {
    let mut events = events.lock().unwrap();
    if events.len() >= CONTROL_EVENT_CAPACITY {
        events.pop_front();
    }
    events.push_back(event);
}

impl AlertHandler for AlertCollector {
    fn alert(&mut self, alert: Alert) {
        match alert {
            Alert::Bell => {
                push_control_event(&self.events, TerminalControlEvent::Bell);
            }
            Alert::WindowTitleChanged(title) => {
                *self.last_title.lock().unwrap() = Some(title.clone());
                push_control_event(&self.events, TerminalControlEvent::TitleChanged { title });
            }
            _ => {}
        }
    }
}

impl WeztermTerminalEngine {
    pub fn new(
        size: TerminalSize,
        config: WeztermTerminalConfig,
        writer: Box<dyn Write + Send>,
    ) -> Self {
        let events = Arc::new(Mutex::new(VecDeque::new()));
        let last_title = Arc::new(Mutex::new(None));
        let reply_writer = Arc::new(Mutex::new(writer));
        let mut terminal = Terminal::new(
            size,
            Arc::new(config) as Arc<dyn TerminalConfiguration + Send + Sync>,
            "project-terminal",
            env!("CARGO_PKG_VERSION"),
            Box::new(SharedWriter {
                inner: Arc::clone(&reply_writer),
            }),
        );
        // ConPTY reports output using Windows console semantics.  Keeping
        // this upstream compatibility switch enabled is important for line
        // wrapping and resize behavior on PowerShell/cmd.
        terminal.enable_conpty_quirks();
        // `enable_conpty_quirks` also suppresses the first OSC 0 as a
        // ConPTY bootstrap workaround. This adapter has no GUI bootstrap
        // title to discard, so clear that one-shot upstream state before any
        // PTY bytes arrive. The terminal model still owns all parsing and the
        // ConPTY compatibility behavior remains enabled.
        terminal.advance_bytes(b"\x1bc");
        terminal.set_notification_handler(Box::new(AlertCollector {
            events: events.clone(),
            last_title: last_title.clone(),
        }));

        let mut engine = Self {
            terminal,
            last_frame_sequence: 0,
            last_emitted_sequence: 0,
            last_cursor: None,
            cursor_hide_pending_since: None,
            last_scrollback_length: 0,
            last_alternate_screen: false,
            last_mouse_reporting: false,
            last_viewport_top: None,
            last_viewport_bottom: None,
            last_title,
            last_cwd: None,
            force_full_snapshot: true,
            viewport_top: None,
            control_events: events,
            osc133_buffer: Vec::new(),
            known_image_keys: HashSet::new(),
            sync_output: SynchronizedOutput::new(),
            reply_writer,
        };
        engine.collect_control_events();
        engine
    }

    pub fn terminal(&self) -> &Terminal {
        &self.terminal
    }

    pub fn terminal_mut(&mut self) -> &mut Terminal {
        &mut self.terminal
    }

    fn collect_control_events(&mut self) {
        // Title changes are emitted by AlertCollector when wezterm-term
        // receives a real OSC 0/2 sequence. CWD does not have an equivalent
        // alert in this API, so it remains a state comparison here.
        let cwd = self.terminal.get_current_dir().map(ToString::to_string);
        if cwd != self.last_cwd {
            self.last_cwd = cwd.clone();
            push_control_event(
                &self.control_events,
                TerminalControlEvent::CwdChanged { cwd },
            );
        }
    }

    /// The model deliberately owns VT parsing. WezTerm currently stores OSC
    /// 133 semantic prompt marks without exposing a notification callback, so
    /// this tiny side channel only recognizes the one Project Terminal event
    /// we need (`D[;exit-code]`). It is not a second screen/ANSI parser.
    fn collect_command_finished_marks(&mut self, data: &[u8]) {
        const PREFIX: &[u8] = b"\x1b]133;";
        // Bounds an unterminated (malformed or adversarial) OSC 133 sequence
        // only - a real prompt-mark payload is a handful of bytes. This must
        // never be checked before the scan loop below: a real PTY read can be
        // this large on its own, and truncating first would silently discard
        // a mark that arrived intact in this very read.
        const MAX_BUFFER: usize = 64 * 1024;

        self.osc133_buffer.extend_from_slice(data);

        loop {
            let Some(start) = memchr::memmem::find(&self.osc133_buffer, PREFIX) else {
                let keep = PREFIX.len().saturating_sub(1);
                let remove = self.osc133_buffer.len().saturating_sub(keep);
                if remove > 0 {
                    self.osc133_buffer.drain(..remove);
                }
                break;
            };

            if start > 0 {
                self.osc133_buffer.drain(..start);
            }
            let payload_start = PREFIX.len();
            let Some((end, terminator_len)) =
                find_osc_terminator(&self.osc133_buffer[payload_start..])
            else {
                // Terminator not seen yet - wait for more data, but give up
                // on a sequence that never terminates so it cannot grow this
                // buffer without bound.
                if self.osc133_buffer.len() > MAX_BUFFER {
                    self.osc133_buffer.clear();
                }
                break;
            };

            let payload = &self.osc133_buffer[payload_start..payload_start + end];
            if payload.first() == Some(&b'D') {
                let exit_code = payload
                    .strip_prefix(b"D;")
                    .and_then(|value| std::str::from_utf8(value).ok())
                    .and_then(|value| value.parse::<i32>().ok());
                push_control_event(
                    &self.control_events,
                    TerminalControlEvent::CommandFinished { exit_code },
                );
            }
            self.osc133_buffer
                .drain(..payload_start + end + terminator_len);
        }
    }

    fn viewport_bounds(&self) -> (i64, i64) {
        let screen = self.terminal.screen();
        let first_row = screen.phys_to_stable_row_index(0) as i64;
        let bottom_top = screen.visible_row_to_stable_row(0) as i64;
        (first_row, bottom_top)
    }

    fn current_frame_state(&mut self) -> (u16, u16, i64, i64, usize, bool, bool, CursorState) {
        let size = self.terminal.get_size();
        let (first_row, bottom_top, scrollback_length) = {
            let screen = self.terminal.screen();
            (
                screen.phys_to_stable_row_index(0) as i64,
                screen.visible_row_to_stable_row(0) as i64,
                screen
                    .scrollback_rows()
                    .saturating_sub(screen.physical_rows),
            )
        };
        let requested_top = self.viewport_top.unwrap_or(bottom_top);
        let viewport_top = requested_top.clamp(first_row, bottom_top);
        if requested_top != viewport_top {
            self.viewport_top = (viewport_top != bottom_top).then_some(viewport_top);
            self.force_full_snapshot = true;
            self.known_image_keys.clear();
        }
        let alternate_screen = self.terminal.is_alt_screen_active();
        let mouse_reporting = self.terminal.is_mouse_grabbed();
        let mut cursor = cursor_state(self.terminal.cursor_pos());
        if viewport_top != bottom_top {
            cursor.visibility = CursorVisibility::Hidden;
        }
        (
            size.rows.min(u16::MAX as usize) as u16,
            size.cols.min(u16::MAX as usize) as u16,
            viewport_top,
            bottom_top,
            scrollback_length,
            alternate_screen,
            mouse_reporting,
            cursor,
        )
    }

    fn changed_rows(
        &self,
        full_snapshot: bool,
        viewport_top: i64,
        rows: u16,
    ) -> Vec<super::RenderRow> {
        let screen = self.terminal.screen();
        let stable_start = viewport_top as isize;
        let stable_end = stable_start.saturating_add(rows as isize);
        let stable_rows = if full_snapshot {
            (stable_start..stable_end).collect()
        } else {
            screen.get_changed_stable_rows(stable_start..stable_end, self.last_emitted_sequence)
        };

        // `with_phys_lines` hands back borrowed `&Line`s instead of cloning
        // each one - `lines_in_phys_range(..).pop()` was deep-cloning a
        // row's full cell/attribute storage per dirty row, every frame, only
        // to read it once here.
        stable_rows
            .into_iter()
            .filter_map(|stable_row| {
                let phys = screen.stable_row_to_phys(stable_row)?;
                let mut row = None;
                screen.with_phys_lines(phys..phys.saturating_add(1), |lines| {
                    row = lines
                        .first()
                        .map(|line| render_row(stable_row as i64, line));
                });
                row
            })
            .collect()
    }

    fn apply_bytes(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        self.collect_command_finished_marks(data);
        self.terminal.advance_bytes(data);
        self.collect_control_events();
    }

    fn reply_synchronized_output_queries(&self, count: usize) {
        if count == 0 {
            return;
        }
        let mut writer = self.reply_writer.lock().unwrap();
        for _ in 0..count {
            let _ = writer.write_all(DECRQM_SYNCHRONIZED_OUTPUT_REPLY);
        }
        let _ = writer.flush();
    }

    /// Remaining time before a deferred cursor hide must be published, if one
    /// is pending. Like `synchronized_hold_remaining`, this lets the frame
    /// scheduler wake on its own: a hidden cursor produces no further PTY
    /// bytes, so without this the hide would never reach the renderer.
    pub fn cursor_hide_remaining(&self) -> Option<Duration> {
        let since = self.cursor_hide_pending_since?;
        Some(CURSOR_HIDE_GRACE.saturating_sub(since.elapsed()))
    }

    /// Remaining time before a stuck DECSET 2026 hold is force-flushed.
    /// The frame scheduler uses this to wake without waiting for more PTY bytes.
    pub fn synchronized_hold_remaining(&self) -> Option<Duration> {
        self.sync_output.hold_remaining()
    }

    /// Age a pending cursor hide so a test can cross `CURSOR_HIDE_GRACE`
    /// without sleeping.
    #[cfg(test)]
    pub fn backdate_cursor_hide(&mut self, by: Duration) {
        if let Some(since) = self.cursor_hide_pending_since {
            self.cursor_hide_pending_since = since.checked_sub(by);
        }
    }

    /// Test-only escape hatch for `SynchronizedOutput`'s total-duration hold
    /// cap without an actual `sleep`.
    #[cfg(test)]
    pub fn backdate_synchronized_hold(&mut self, by: Duration) {
        self.sync_output.backdate_hold(by);
    }

    fn set_viewport(&mut self, stable_row: i64) {
        let (first_row, bottom_top) = self.viewport_bounds();
        let next = stable_row.clamp(first_row, bottom_top);
        let current = self.viewport_top.unwrap_or(bottom_top);
        self.viewport_top = (next != bottom_top).then_some(next);
        if current != next {
            self.force_full_snapshot = true;
            self.known_image_keys.clear();
        }
    }

    fn prepare_image_payloads(&mut self, rows: &mut [super::RenderRow]) {
        for row in rows {
            for cell in &mut row.cells {
                for image in &mut cell.images {
                    if image.data_base64.is_none() {
                        continue;
                    }
                    if self.known_image_keys.contains(&image.cache_key) {
                        image.data_base64 = None;
                        image.animation_frames.clear();
                        continue;
                    }
                    if self.known_image_keys.len() >= IMAGE_CACHE_KEY_CAPACITY {
                        // Keep the cache bookkeeping bounded. A later frame
                        // may resend an older image payload, but the renderer
                        // can safely replace its existing cache entry.
                        self.known_image_keys.clear();
                    }
                    self.known_image_keys.insert(image.cache_key.clone());
                }
            }
        }
    }
}

impl TerminalEngine for WeztermTerminalEngine {
    fn feed(&mut self, data: &[u8]) {
        let outcome = self.sync_output.push(data);
        self.apply_bytes(&outcome.flush);
        self.reply_synchronized_output_queries(outcome.decrqm_replies);
    }

    fn resize(&mut self, size: TerminalSize) {
        if self.terminal.get_size() == size {
            return;
        }
        self.terminal.resize(size);
        self.known_image_keys.clear();
        if let Some(top) = self.viewport_top {
            let (first_row, bottom_top) = self.viewport_bounds();
            self.viewport_top = (top.clamp(first_row, bottom_top) != bottom_top)
                .then_some(top.clamp(first_row, bottom_top));
        }
        self.force_full_snapshot = true;
        self.collect_control_events();
    }

    fn request_full_snapshot(&mut self) {
        self.force_full_snapshot = true;
        self.known_image_keys.clear();
        // A shell-authored title and cwd are stateful and are re-enqueued
        // below. Bell and command
        // completion are edge-triggered; replaying events that accumulated
        // while a renderer was detached would make a newly attached view act
        // on stale history, so discard the old control queue during a full
        // resync.
        self.control_events.lock().unwrap().clear();
        // `None` means the shell has never authored a title. In that case do
        // not expose wezterm-term's internal bootstrap title and let the
        // frontend keep the profile's initial tab title. `Some("")` is a
        // real empty OSC title and must be replayed so the frontend can
        // restore that same profile fallback after a reconnect.
        if let Some(title) = self.last_title.lock().unwrap().clone() {
            push_control_event(
                &self.control_events,
                TerminalControlEvent::TitleChanged { title },
            );
        }
        // `None` is also state: it clears a cwd that a detached renderer may
        // still have cached from an earlier OSC 7 notification. Replaying the
        // explicit absence makes attach/resync deterministic.
        push_control_event(
            &self.control_events,
            TerminalControlEvent::CwdChanged {
                cwd: self.last_cwd.clone(),
            },
        );
    }

    fn set_viewport_top(&mut self, stable_row: i64) {
        self.set_viewport(stable_row);
    }

    fn take_render_frame(&mut self) -> Option<RenderFrame> {
        if let Some(flushed) = self.sync_output.poll_timeout() {
            self.apply_bytes(&flushed);
        }
        let (
            rows,
            cols,
            viewport_top,
            viewport_bottom,
            scrollback_length,
            alternate_screen,
            mouse_reporting,
            cursor,
        ) = self.current_frame_state();
        // Entering or leaving the alternate screen must always resync every
        // visible row, not just whatever wezterm-term marked dirty: leaving
        // alt screen marks the primary screen's dirty rows against the
        // oldest physical row in scrollback, not the viewport, so relying on
        // `get_changed_stable_rows` here leaves stale alt-screen content on
        // screen until something else repaints it. Deliberately not routed
        // through `request_full_snapshot()` - that also clears the pending
        // control-event queue (bell, command-finished), which a screen
        // switch must not discard.
        let screen_switched = alternate_screen != self.last_alternate_screen;
        if screen_switched {
            self.known_image_keys.clear();
        }
        let full_snapshot = self.force_full_snapshot || screen_switched;
        let mut dirty_rows = self.changed_rows(full_snapshot, viewport_top, rows);
        self.prepare_image_payloads(&mut dirty_rows);
        let cursor_changed = self.last_cursor.as_ref() != Some(&cursor);
        let viewport_changed = self.last_scrollback_length != scrollback_length
            || self.last_alternate_screen != alternate_screen
            || self.last_mouse_reporting != mouse_reporting
            || self.last_viewport_top != Some(viewport_top)
            || self.last_viewport_bottom != Some(viewport_bottom);

        // Hold back a frame whose only news is that the cursor went away.
        // Mid-repaint the model reports DECTCEM off and whatever position the
        // paint happened to reach; both are transient, and a repaint that ends
        // with `CSI ? 25 h` makes them never worth publishing at all. Only a
        // bare hide is deferred - once real content, a viewport move, or a
        // snapshot rides along, the frame goes out immediately with the
        // model's true cursor, so nothing that affects what the user reads is
        // ever delayed by this.
        let bare_cursor_hide = cursor_changed
            && !full_snapshot
            && dirty_rows.is_empty()
            && !viewport_changed
            && cursor.visibility == CursorVisibility::Hidden
            && self
                .last_cursor
                .as_ref()
                .is_some_and(|last| last.visibility == CursorVisibility::Visible);
        if bare_cursor_hide {
            let since = *self
                .cursor_hide_pending_since
                .get_or_insert_with(Instant::now);
            if since.elapsed() < CURSOR_HIDE_GRACE {
                // Deliberately before any `last_*` bookkeeping: the hide must
                // still look new on the next extract so it can be published
                // once the grace window expires.
                return None;
            }
        }
        self.cursor_hide_pending_since = None;

        let has_render_state =
            full_snapshot || !dirty_rows.is_empty() || cursor_changed || viewport_changed;

        self.last_emitted_sequence = self.terminal.current_seqno();
        self.last_cursor = Some(cursor.clone());
        self.last_scrollback_length = scrollback_length;
        self.last_alternate_screen = alternate_screen;
        self.last_mouse_reporting = mouse_reporting;
        self.last_viewport_top = Some(viewport_top);
        self.last_viewport_bottom = Some(viewport_bottom);
        self.force_full_snapshot = false;

        if !has_render_state {
            return None;
        }

        self.last_frame_sequence = self.last_frame_sequence.saturating_add(1);

        Some(RenderFrame {
            sequence: self.last_frame_sequence,
            rows,
            cols,
            dirty_rows,
            cursor,
            scrollback_length,
            viewport_top,
            viewport_bottom,
            alternate_screen,
            mouse_reporting,
            full_snapshot,
        })
    }

    fn drain_control_events(&mut self) -> Vec<TerminalControlEvent> {
        self.control_events.lock().unwrap().drain(..).collect()
    }

    fn key_down(&mut self, event: &TerminalKeyEvent) -> Result<(), String> {
        let key = event
            .key_code()
            .ok_or_else(|| format!("unsupported key event: {}", event.key))?;
        self.terminal
            .key_down(key, event.modifiers())
            .map_err(|error| error.to_string())
    }

    fn text_input(&mut self, text: &str) -> Result<(), String> {
        for character in text.chars() {
            self.terminal
                .key_down(KeyCode::Char(character), KeyModifiers::NONE)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn mouse_event(&mut self, event: &TerminalMouseEvent) -> Result<(), String> {
        self.terminal
            .mouse_event(event.to_wezterm())
            .map_err(|error| error.to_string())
    }

    fn focus_changed(&mut self, focused: bool) {
        self.terminal.focus_changed(focused);
    }

    fn send_paste(&mut self, text: &str) -> Result<(), String> {
        self.terminal
            .send_paste(text)
            .map_err(|error| error.to_string())
    }

    fn bracketed_paste_enabled(&self) -> bool {
        self.terminal.bracketed_paste_enabled()
    }

    fn search(&self, query: &TerminalSearchQuery) -> Vec<TerminalSearchMatch> {
        search_screen(self.terminal.screen(), query)
    }

    fn selection_text(
        &self,
        anchor: &TerminalSelectionPoint,
        focus: &TerminalSelectionPoint,
    ) -> String {
        selection_text_screen(self.terminal.screen(), anchor, focus)
    }
}

fn selection_text_screen(
    screen: &wezterm_term::Screen,
    anchor: &TerminalSelectionPoint,
    focus: &TerminalSelectionPoint,
) -> String {
    if anchor.stable_row == focus.stable_row && anchor.column == focus.column {
        return String::new();
    }

    let (start, end) = if anchor.stable_row < focus.stable_row
        || (anchor.stable_row == focus.stable_row && anchor.column <= focus.column)
    {
        (*anchor, *focus)
    } else {
        (*focus, *anchor)
    };

    let first_row = screen.phys_to_stable_row_index(0) as i64;
    let last_row = (screen.visible_row_to_stable_row(0) as i64)
        .saturating_add(screen.physical_rows as i64)
        .saturating_sub(1);
    let start_row = start.stable_row.clamp(first_row, last_row);
    let end_row = end.stable_row.clamp(first_row, last_row);
    let mut lines = Vec::new();

    for stable_row in start_row..=end_row {
        let from = if stable_row == start_row {
            usize::from(start.column)
        } else {
            0
        };
        let to = if stable_row == end_row {
            usize::from(end.column)
        } else {
            screen.physical_cols
        };

        // Borrow the line via `with_phys_lines` rather than deep-cloning it
        // through `lines_in_phys_range(..).pop()` - a selection can span the
        // entire scrollback, so this ran once per selected row.
        let mut text = String::new();
        if let Some(phys_row) = screen.stable_row_to_phys(stable_row as isize) {
            screen.with_phys_lines(phys_row..phys_row.saturating_add(1), |lines| {
                if let Some(line) = lines.first() {
                    text = selected_line_text(line, from, to);
                }
            });
        }
        lines.push(text);
    }

    lines.join("\n")
}

fn selected_line_text(line: &wezterm_term::Line, from: usize, to: usize) -> String {
    if from >= to {
        return String::new();
    }

    let mut text = String::new();
    let mut cursor = from;
    for cell in line.visible_cells() {
        let cell_start = cell.cell_index();
        let cell_end = cell_start.saturating_add(cell.width().max(1));
        if cell_end <= from {
            continue;
        }
        if cell_start >= to {
            break;
        }

        let visible_start = cell_start.max(from);
        let visible_end = cell_end.min(to);
        if visible_start > cursor {
            text.extend(std::iter::repeat(' ').take(visible_start - cursor));
        }
        let value = cell.str().to_string();
        if value.is_empty() {
            text.extend(std::iter::repeat(' ').take(visible_end - visible_start));
        } else {
            // Terminal cells are the unit of selection. Keeping a wide or
            // combining grapheme intact is preferable to slicing UTF-8/UTF-16
            // text at a browser code-unit boundary.
            text.push_str(&value);
        }
        cursor = cursor.max(visible_end);
        if cursor >= to {
            break;
        }
    }

    text.trim_end().to_string()
}

fn search_screen(
    screen: &wezterm_term::Screen,
    query: &TerminalSearchQuery,
) -> Vec<TerminalSearchMatch> {
    if query.query.is_empty() {
        return Vec::new();
    }

    let needle = normalized_chars(&query.query, query.case_sensitive);
    if needle.is_empty() {
        return Vec::new();
    }

    let first_row = screen.phys_to_stable_row_index(0) as i64;
    let bottom_row = screen.visible_row_to_stable_row(0) as i64 + screen.physical_rows as i64;
    let mut matches = Vec::new();

    // Borrow each line via `with_phys_lines` rather than deep-cloning it
    // through `lines_in_phys_range(..).pop()` - a search scans every row in
    // the scrollback, so this used to clone the entire visible history plus
    // scrollback per search.
    for stable_row in first_row..bottom_row {
        let Some(phys_row) = screen.stable_row_to_phys(stable_row as isize) else {
            continue;
        };
        screen.with_phys_lines(phys_row..phys_row.saturating_add(1), |lines| {
            let Some(line) = lines.first() else {
                return;
            };
            let searchable = searchable_line(line, query.case_sensitive);
            if searchable.chars.len() < needle.len() {
                return;
            }

            for start in 0..=searchable.chars.len() - needle.len() {
                if searchable.chars[start..start + needle.len()] != needle {
                    continue;
                }
                let end = start + needle.len() - 1;
                matches.push(TerminalSearchMatch {
                    stable_row,
                    start_column: searchable.start_columns[start],
                    end_column: searchable.end_columns[end],
                });
            }
        });
    }

    if matches.is_empty() {
        return matches;
    }

    match query.direction {
        TerminalSearchDirection::Forward => {
            if let Some(start) = query.start {
                rotate_forward(&mut matches, start);
            }
        }
        TerminalSearchDirection::Backward => {
            matches.reverse();
            if let Some(start) = query.start {
                rotate_backward(&mut matches, start);
            }
        }
    }
    matches
}

struct SearchableLine {
    chars: Vec<char>,
    start_columns: Vec<u16>,
    end_columns: Vec<u16>,
}

fn searchable_line(line: &wezterm_term::Line, case_sensitive: bool) -> SearchableLine {
    let mut searchable = SearchableLine {
        chars: Vec::new(),
        start_columns: Vec::new(),
        end_columns: Vec::new(),
    };

    for cell in line.visible_cells() {
        let start_column = cell.cell_index().min(u16::MAX as usize) as u16;
        let end_column = cell
            .cell_index()
            .saturating_add(cell.width())
            .min(u16::MAX as usize) as u16;
        let text = cell.str().to_string();
        let text = if text.is_empty() {
            " ".to_string()
        } else {
            text
        };
        for character in text.chars() {
            for normalized in normalized_char(character, case_sensitive) {
                searchable.chars.push(normalized);
                searchable.start_columns.push(start_column);
                searchable
                    .end_columns
                    .push(end_column.max(start_column.saturating_add(1)));
            }
        }
    }
    searchable
}

fn normalized_chars(value: &str, case_sensitive: bool) -> Vec<char> {
    value
        .chars()
        .flat_map(|character| normalized_char(character, case_sensitive))
        .collect()
}

fn normalized_char(character: char, case_sensitive: bool) -> Vec<char> {
    if case_sensitive {
        vec![character]
    } else {
        character.to_lowercase().collect()
    }
}

fn position_at_or_after(result: &TerminalSearchMatch, position: TerminalSearchPosition) -> bool {
    result.stable_row > position.stable_row
        || (result.stable_row == position.stable_row && result.start_column >= position.column)
}

fn position_at_or_before(result: &TerminalSearchMatch, position: TerminalSearchPosition) -> bool {
    result.stable_row < position.stable_row
        || (result.stable_row == position.stable_row && result.start_column <= position.column)
}

fn rotate_forward(matches: &mut [TerminalSearchMatch], start: TerminalSearchPosition) {
    if let Some(index) = matches
        .iter()
        .position(|result| position_at_or_after(result, start))
    {
        matches.rotate_left(index);
    }
}

fn rotate_backward(matches: &mut [TerminalSearchMatch], start: TerminalSearchPosition) {
    if let Some(index) = matches
        .iter()
        .position(|result| position_at_or_before(result, start))
    {
        matches.rotate_left(index);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_engine::{
        CellBlink, RenderColor, TerminalEngine, DEFAULT_SCROLLBACK_LINES,
    };

    #[derive(Clone)]
    struct CaptureWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for CaptureWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct NoopWriter;

    impl Write for NoopWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn engine_with_size(rows: usize, cols: usize) -> WeztermTerminalEngine {
        WeztermTerminalEngine::new(
            TerminalSize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
                dpi: 96,
            },
            WeztermTerminalConfig::default(),
            Box::new(NoopWriter),
        )
    }

    fn image_engine() -> WeztermTerminalEngine {
        WeztermTerminalEngine::new(
            TerminalSize {
                rows: 4,
                cols: 12,
                pixel_width: 1_200,
                pixel_height: 400,
                dpi: 96,
            },
            WeztermTerminalConfig::default(),
            Box::new(NoopWriter),
        )
    }

    fn engine() -> WeztermTerminalEngine {
        engine_with_size(4, 12)
    }

    fn capture_engine() -> (WeztermTerminalEngine, Arc<Mutex<Vec<u8>>>) {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let engine = WeztermTerminalEngine::new(
            TerminalSize {
                rows: 4,
                cols: 12,
                pixel_width: 0,
                pixel_height: 0,
                dpi: 96,
            },
            WeztermTerminalConfig::default(),
            Box::new(CaptureWriter {
                bytes: bytes.clone(),
            }),
        );
        (engine, bytes)
    }

    fn take_output(bytes: &Arc<Mutex<Vec<u8>>>) -> Vec<u8> {
        std::mem::take(&mut *bytes.lock().unwrap())
    }

    fn wait_for_output(bytes: &Arc<Mutex<Vec<u8>>>) -> Vec<u8> {
        for _ in 0..1_000 {
            let output = take_output(bytes);
            if !output.is_empty() {
                return output;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        Vec::new()
    }

    fn wait_for_output_len(bytes: &Arc<Mutex<Vec<u8>>>, length: usize) -> Vec<u8> {
        let mut output = Vec::new();
        for _ in 0..1_000 {
            output.extend(take_output(bytes));
            if output.len() >= length {
                return output;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        output
    }

    fn key_event(key: &str) -> TerminalKeyEvent {
        TerminalKeyEvent {
            key: key.into(),
            code: None,
            location: 0,
            num_lock: false,
            shift: false,
            alt: false,
            ctrl: false,
            meta: false,
        }
    }

    #[test]
    fn starts_with_one_full_visible_snapshot() {
        let mut engine = engine();
        let frame = engine.take_render_frame().expect("initial snapshot");
        assert!(frame.full_snapshot);
        assert_eq!(frame.rows, 4);
        assert_eq!(frame.cols, 12);
        assert_eq!(frame.dirty_rows.len(), 4);
        assert!(engine.take_render_frame().is_none());
    }

    #[test]
    fn parses_text_and_reports_only_changed_rows_after_initial_snapshot() {
        let mut engine = engine();
        let _ = engine.take_render_frame();

        engine.feed(b"hello");
        let frame = engine.take_render_frame().expect("text frame");
        assert!(!frame.full_snapshot);
        assert_eq!(frame.dirty_rows.len(), 1);
        assert_eq!(frame.dirty_rows[0].stable_row, 0);
        assert_eq!(frame.dirty_rows[0].cells[0].text, "hello");
        assert_eq!(frame.dirty_rows[0].cells[0].width, 5);
        assert_eq!(frame.dirty_rows[0].cells.len(), 1);
        assert_eq!(frame.cursor.column, 5);
        assert!(engine.take_render_frame().is_none());
    }

    #[test]
    fn automatic_scrolling_can_move_viewport_in_an_incremental_frame() {
        let mut engine = engine_with_size(3, 12);
        let initial = engine.take_render_frame().expect("initial snapshot");

        engine.feed(b"one\r\ntwo\r\nthree\r\nfour\r\n");
        let scrolled = engine.take_render_frame().expect("scroll frame");

        assert!(scrolled.viewport_top > initial.viewport_top);
        assert!(!scrolled.full_snapshot);
        assert!(!scrolled.dirty_rows.is_empty());
        assert!(scrolled
            .dirty_rows
            .iter()
            .any(|row| row.stable_row >= scrolled.viewport_top));
    }

    #[test]
    fn does_not_emit_wezterm_bootstrap_title() {
        let mut engine = engine();

        let events = engine.drain_control_events();

        assert!(!events
            .iter()
            .any(|event| { matches!(event, TerminalControlEvent::TitleChanged { .. }) }));
    }

    #[test]
    fn ordinary_output_does_not_change_title() {
        let mut engine = engine();
        let _ = engine.drain_control_events();

        engine.feed(b"hello world\r\n");

        assert!(!engine
            .drain_control_events()
            .iter()
            .any(|event| { matches!(event, TerminalControlEvent::TitleChanged { .. }) }));
    }

    #[test]
    fn preserves_sgr_colors_wide_cells_and_hyperlinks() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        engine.feed(
            "\x1b[1;38;2;1;2;3mA\x1b[0m界\x1b]8;;https://example.com\x07link\x1b]8;;\x07"
                .as_bytes(),
        );
        let frame = engine.take_render_frame().expect("styled frame");
        let row = &frame.dirty_rows[0];
        assert_eq!(row.cells[0].text, "A");
        assert_eq!(row.cells[0].intensity, super::super::CellIntensity::Bold);
        assert_eq!(row.cells[0].foreground, RenderColor::Rgba([1, 2, 3, 255]));
        assert_eq!(row.cells[1].text, "界");
        assert_eq!(row.cells[1].width, 2);
        assert_eq!(row.cells[2].text, "link");
        assert_eq!(row.cells[2].width, 4);
        assert_eq!(
            row.cells[2].hyperlink.as_deref(),
            Some("https://example.com")
        );
    }

    #[test]
    fn decodes_iterm_inline_images_into_cached_render_cells() {
        // A tiny valid PNG, encoded as required by OSC 1337 File=inline=1.
        const TINY_PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAsAAAALCAYAAACprHcmAAAACXBIWXMAAAGKAAABigEzlzBYAAAAOUlEQVQYlZXOwQ0AMAzCQEdi7yaT0xWAN7JuDCac2PQKYxflycOoICOKtPIuqFCg4/LzKxiz6xjyAYh9DR1sLUN1AAAAAElFTkSuQmCC";

        let mut engine = image_engine();
        let _ = engine.take_render_frame();
        engine.feed(format!("\x1b]1337;File=inline=1:{TINY_PNG_BASE64}\x07").as_bytes());

        let frame = engine.take_render_frame().expect("image frame");
        let cache_key = {
            let image = frame
                .dirty_rows
                .iter()
                .flat_map(|row| row.cells.iter())
                .flat_map(|cell| cell.images.iter())
                .find(|image| image.data_base64.is_some())
                .expect("inline image payload");

            assert_eq!(image.mime_type, "image/png");
            // EncodedFile intentionally leaves dimensions for the browser's
            // image decoder; RGBA frames carry explicit dimensions in the
            // protocol.
            assert_eq!((image.width, image.height), (0, 0));
            assert!(image
                .cache_key
                .chars()
                .all(|character| character.is_ascii_hexdigit()));
            assert!(image
                .data_base64
                .as_deref()
                .is_some_and(|data| data == TINY_PNG_BASE64));
            image.cache_key.clone()
        };

        engine.feed(format!("\x1b]1337;File=inline=1:{TINY_PNG_BASE64}\x07").as_bytes());
        let repeat = engine.take_render_frame().expect("repeated image frame");
        let cached = repeat
            .dirty_rows
            .iter()
            .flat_map(|row| row.cells.iter())
            .flat_map(|cell| cell.images.iter())
            .find(|image| image.cache_key == cache_key)
            .expect("cached image placement");
        assert!(cached.data_base64.is_none());
    }

    #[test]
    fn decodes_sixel_graphics_into_model_owned_image_cells() {
        let mut engine = image_engine();
        let _ = engine.take_render_frame();

        // One sixel column: define/select a red palette entry and paint one
        // six-pixel-high column, then terminate the DCS image.
        engine.feed(b"\x1bPq#0;2;100;0;0#0@\x1b\\");

        let frame = engine.take_render_frame().expect("sixel frame");
        let image = frame
            .dirty_rows
            .iter()
            .flat_map(|row| row.cells.iter())
            .flat_map(|cell| cell.images.iter())
            .find(|image| image.data_base64.is_some())
            .expect("sixel image payload");

        assert_eq!(image.format, "rgba8");
        assert_eq!(image.mime_type, "application/octet-stream");
        assert_eq!((image.width, image.height), (1, 6));
        assert_eq!(
            image.data_base64.as_deref().map(|data| data.len()),
            Some(32)
        );
    }

    #[test]
    fn decodes_kitty_graphics_into_model_owned_image_cells() {
        const TINY_PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAsAAAALCAYAAACprHcmAAAACXBIWXMAAAGKAAABigEzlzBYAAAAOUlEQVQYlZXOwQ0AMAzCQEdi7yaT0xWAN7JuDCac2PQKYxflycOoICOKtPIuqFCg4/LzKxiz6xjyAYh9DR1sLUN1AAAAAElFTkSuQmCC";

        let mut engine = image_engine();
        let _ = engine.take_render_frame();
        engine.feed(format!("\x1b_Ga=T,t=d,f=100;{TINY_PNG_BASE64}\x1b\\").as_bytes());

        let frame = engine.take_render_frame().expect("kitty frame");
        let image = frame
            .dirty_rows
            .iter()
            .flat_map(|row| row.cells.iter())
            .flat_map(|cell| cell.images.iter())
            .find(|image| image.data_base64.is_some())
            .expect("kitty image payload");

        // Kitty graphics decode into RGBA cells; the original PNG is not
        // preserved as an encoded file the way iTerm inline images are.
        assert_eq!(image.format, "rgba8");
        assert!(image.width > 0);
        assert!(image.height > 0);
        assert!(image.data_base64.is_some());
    }

    #[test]
    fn title_and_cwd_are_control_events() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        let _ = engine.drain_control_events();

        engine.feed(b"\x1b]2;Project Terminal\x07\x1b]7;file:///C:/work\x07");
        let events = engine.drain_control_events();
        assert!(events.iter().any(|event| {
            matches!(event, TerminalControlEvent::TitleChanged { title } if title == "Project Terminal")
        }));
        assert!(events.iter().any(|event| {
            matches!(event, TerminalControlEvent::CwdChanged { cwd } if cwd.as_deref() == Some("file:///C:/work"))
        }));
    }

    #[test]
    fn osc_zero_updates_title() {
        let mut engine = engine();
        let _ = engine.drain_control_events();

        engine.feed(b"\x1b]0;PowerShell - project\x07");

        assert!(engine.drain_control_events().iter().any(|event| {
            matches!(
                event,
                TerminalControlEvent::TitleChanged { title }
                    if title == "PowerShell - project"
            )
        }));
    }

    #[test]
    fn literal_wezterm_title_from_osc_is_preserved() {
        let mut engine = engine();
        let _ = engine.drain_control_events();

        engine.feed(b"\x1b]2;wezterm\x07");

        assert!(engine.drain_control_events().iter().any(|event| {
            matches!(event, TerminalControlEvent::TitleChanged { title } if title == "wezterm")
        }));
    }

    #[test]
    fn full_snapshot_without_shell_title_does_not_emit_a_title() {
        let mut engine = engine();
        let _ = engine.drain_control_events();

        engine.request_full_snapshot();

        assert!(!engine
            .drain_control_events()
            .iter()
            .any(|event| { matches!(event, TerminalControlEvent::TitleChanged { .. }) }));
    }

    #[test]
    fn full_snapshot_replays_the_last_shell_title() {
        let mut engine = engine();
        let _ = engine.drain_control_events();

        engine.feed(b"\x1b]2;nvim\x07");
        let _ = engine.drain_control_events();

        engine.request_full_snapshot();

        assert!(engine.drain_control_events().iter().any(|event| {
            matches!(event, TerminalControlEvent::TitleChanged { title } if title == "nvim")
        }));
    }

    #[test]
    fn command_finished_osc_marks_are_detected_across_reads() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        let _ = engine.drain_control_events();

        engine.feed(b"\x1b]133;D;");
        assert!(engine.drain_control_events().is_empty());
        engine.feed(b"7\x1b\\");
        assert!(engine.drain_control_events().iter().any(|event| {
            matches!(
                event,
                TerminalControlEvent::CommandFinished { exit_code: Some(7) }
            )
        }));
    }

    #[test]
    fn command_finished_osc_mark_survives_a_full_pty_read_buffer() {
        // Regression test: a full 16KB PTY read (the reader's buffer size)
        // must not truncate the OSC 133 scan buffer before it has a chance
        // to find a mark that arrived intact within that same read.
        let mut engine = engine();
        let _ = engine.take_render_frame();
        let _ = engine.drain_control_events();

        const PTY_READ_BUFFER_BYTES: usize = 16 * 1024;
        let mark = b"\x1b]133;D;42\x07";
        let mut chunk = vec![b'x'; PTY_READ_BUFFER_BYTES - mark.len()];
        chunk.extend_from_slice(mark);
        assert_eq!(chunk.len(), PTY_READ_BUFFER_BYTES);

        engine.feed(&chunk);
        assert!(engine.drain_control_events().iter().any(|event| {
            matches!(
                event,
                TerminalControlEvent::CommandFinished {
                    exit_code: Some(42)
                }
            )
        }));
    }

    #[test]
    fn reports_bell_without_mixing_it_into_render_rows() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        let _ = engine.drain_control_events();

        engine.feed(b"\x07");

        assert!(engine
            .drain_control_events()
            .iter()
            .any(|event| matches!(event, TerminalControlEvent::Bell)));
        assert!(engine.take_render_frame().is_none());
    }

    #[test]
    fn full_snapshot_resync_drops_stale_transient_control_events() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        let _ = engine.drain_control_events();

        engine.feed(b"\x07\x1b]133;D;7\x07");
        assert!(engine
            .drain_control_events()
            .iter()
            .any(|event| matches!(event, TerminalControlEvent::Bell)));

        engine.feed(b"\x07\x1b]133;D;8\x07");
        engine.request_full_snapshot();
        let events = engine.drain_control_events();
        assert!(!events.iter().any(|event| {
            matches!(
                event,
                TerminalControlEvent::Bell | TerminalControlEvent::CommandFinished { .. }
            )
        }));
    }

    #[test]
    fn full_snapshot_replays_an_explicitly_cleared_cwd() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        let _ = engine.drain_control_events();

        engine.feed(b"\x1b]7;file:///C:/work\x07");
        let _ = engine.drain_control_events();
        engine.feed(b"\x1b]7;\x07");
        assert!(engine
            .drain_control_events()
            .iter()
            .any(|event| { matches!(event, TerminalControlEvent::CwdChanged { cwd: None }) }));

        engine.request_full_snapshot();
        assert!(engine
            .drain_control_events()
            .iter()
            .any(|event| { matches!(event, TerminalControlEvent::CwdChanged { cwd: None }) }));
    }

    #[test]
    fn full_snapshot_replays_an_explicitly_cleared_title() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        let _ = engine.drain_control_events();

        engine.feed(b"\x1b]2;Project Terminal\x07");
        let _ = engine.drain_control_events();
        engine.feed(b"\x1b]2;\x07");
        assert!(engine.drain_control_events().iter().any(|event| {
            matches!(event, TerminalControlEvent::TitleChanged { title } if title.is_empty())
        }));

        engine.request_full_snapshot();
        assert!(engine.drain_control_events().iter().any(|event| {
            matches!(event, TerminalControlEvent::TitleChanged { title } if title.is_empty())
        }));
    }

    #[test]
    fn full_snapshot_gets_a_new_transport_sequence_without_model_output() {
        let mut engine = engine();
        let initial = engine.take_render_frame().expect("initial frame");

        engine.feed(b"output");
        let incremental = engine.take_render_frame().expect("incremental frame");
        assert!(incremental.sequence > initial.sequence);

        engine.request_full_snapshot();
        let snapshot = engine.take_render_frame().expect("resync frame");
        assert!(snapshot.full_snapshot);
        assert!(snapshot.sequence > incremental.sequence);
    }

    #[test]
    fn preserves_bracketed_paste_and_de_fangs_embedded_markers() {
        let (mut engine, output) = capture_engine();
        let _ = engine.take_render_frame();

        engine.feed(b"\x1b[?2004h");
        assert!(engine.bracketed_paste_enabled());
        let _ = take_output(&output);

        engine
            .send_paste("one\ntwo\x1b[200~ignored\x1b[201~")
            .unwrap();

        assert_eq!(
            wait_for_output(&output),
            b"\x1b[200~one\ntwoignored\x1b[201~"
        );
    }

    #[test]
    fn encodes_application_cursor_keys_in_the_terminal_model() {
        let (mut engine, output) = capture_engine();
        let _ = engine.take_render_frame();

        engine.feed(b"\x1b[?1h");
        let _ = engine.take_render_frame();
        let _ = take_output(&output);

        engine.key_down(&key_event("ArrowUp")).unwrap();

        assert_eq!(wait_for_output(&output), b"\x1bOA");
    }

    #[test]
    fn encodes_num_lock_keypad_digits_as_text() {
        let (mut engine, output) = capture_engine();
        let _ = engine.take_render_frame();

        engine
            .key_down(&TerminalKeyEvent {
                key: "1".into(),
                code: Some("Numpad1".into()),
                location: 3,
                num_lock: true,
                shift: false,
                alt: false,
                ctrl: false,
                meta: false,
            })
            .unwrap();

        assert_eq!(wait_for_output(&output), b"1");
    }

    #[test]
    fn encodes_ctrl_c_as_a_terminal_control_character() {
        let (mut engine, output) = capture_engine();
        let _ = engine.take_render_frame();

        let mut event = key_event("c");
        event.ctrl = true;
        engine.key_down(&event).unwrap();

        assert_eq!(wait_for_output(&output), b"\x03");
    }

    #[test]
    fn sends_composed_text_through_the_model_keyboard_path() {
        let (mut engine, output) = capture_engine();
        let _ = engine.take_render_frame();

        engine.text_input("A界🙂e\u{301}").unwrap();

        let expected = "A界🙂e\u{301}".as_bytes();
        assert_eq!(wait_for_output_len(&output, expected.len()), expected);
    }

    #[test]
    fn encodes_sgr_mouse_reporting_and_exposes_the_active_mode() {
        let (mut engine, output) = capture_engine();
        let _ = engine.take_render_frame();

        engine.feed(b"\x1b[?1000h\x1b[?1006h");
        let frame = engine.take_render_frame().expect("mouse mode frame");
        assert!(frame.mouse_reporting);
        let _ = take_output(&output);

        engine
            .mouse_event(&TerminalMouseEvent {
                kind: super::super::TerminalMouseEventKind::Press,
                button: super::super::TerminalMouseButton::Left,
                x: 1,
                y: 2,
                x_pixel_offset: 0,
                y_pixel_offset: 0,
                shift: false,
                alt: false,
                ctrl: false,
            })
            .unwrap();

        assert_eq!(wait_for_output(&output), b"\x1b[<0;2;3M");
    }

    #[test]
    fn encodes_any_event_mouse_moves_without_a_pressed_button() {
        let (mut engine, output) = capture_engine();
        let _ = engine.take_render_frame();

        engine.feed(b"\x1b[?1003h\x1b[?1006h");
        let frame = engine.take_render_frame().expect("mouse mode frame");
        assert!(frame.mouse_reporting);
        let _ = take_output(&output);

        engine
            .mouse_event(&TerminalMouseEvent {
                kind: super::super::TerminalMouseEventKind::Move,
                button: super::super::TerminalMouseButton::None,
                x: 1,
                y: 2,
                x_pixel_offset: 0,
                y_pixel_offset: 0,
                shift: false,
                alt: false,
                ctrl: false,
            })
            .unwrap();

        // SGR any-event motion uses button 32 + 3 (none) = 35.
        assert_eq!(wait_for_output(&output), b"\x1b[<35;2;3M");
    }

    #[test]
    fn button_event_mouse_does_not_encode_hover_moves() {
        let (mut engine, output) = capture_engine();
        let _ = engine.take_render_frame();

        engine.feed(b"\x1b[?1002h\x1b[?1006h");
        let _ = engine.take_render_frame();
        let _ = take_output(&output);

        engine
            .mouse_event(&TerminalMouseEvent {
                kind: super::super::TerminalMouseEventKind::Move,
                button: super::super::TerminalMouseButton::None,
                x: 4,
                y: 1,
                x_pixel_offset: 0,
                y_pixel_offset: 0,
                shift: false,
                alt: false,
                ctrl: false,
            })
            .unwrap();

        assert!(take_output(&output).is_empty());
    }

    #[test]
    fn reports_focus_in_and_out_when_decset_1004_is_enabled() {
        let (mut engine, output) = capture_engine();
        let _ = engine.take_render_frame();

        engine.feed(b"\x1b[?1004h");
        let _ = take_output(&output);

        engine.focus_changed(false);
        assert_eq!(wait_for_output(&output), b"\x1b[O");
        engine.focus_changed(true);
        assert_eq!(wait_for_output(&output), b"\x1b[I");
        engine.focus_changed(true);
        assert!(take_output(&output).is_empty());
    }

    #[test]
    fn does_not_report_focus_when_tracking_is_disabled() {
        let (mut engine, output) = capture_engine();
        let _ = engine.take_render_frame();
        let _ = take_output(&output);

        engine.focus_changed(false);
        assert!(take_output(&output).is_empty());
    }

    #[test]
    fn osc_52_writes_decoded_clipboard_text_through_the_model_clipboard() {
        use wezterm_term::{Clipboard, ClipboardSelection};

        struct RecordingClipboard {
            contents: Mutex<Option<String>>,
        }

        impl Clipboard for RecordingClipboard {
            fn set_contents(
                &self,
                _selection: ClipboardSelection,
                data: Option<String>,
            ) -> anyhow::Result<()> {
                *self.contents.lock().unwrap() = data;
                Ok(())
            }
        }

        let clipboard = Arc::new(RecordingClipboard {
            contents: Mutex::new(None),
        });
        let (mut engine, _output) = capture_engine();
        engine
            .terminal_mut()
            .set_clipboard(&(clipboard.clone() as Arc<dyn Clipboard>));

        // OSC 52 clipboard payload for "hello".
        engine.feed(b"\x1b]52;c;aGVsbG8=\x07");

        assert_eq!(clipboard.contents.lock().unwrap().as_deref(), Some("hello"));
    }

    #[test]
    fn tracks_alternate_screen_as_render_state_and_restores_primary_screen() {
        let mut engine = engine();
        let _ = engine.take_render_frame();

        engine.feed(b"primary\x1b[?1049halt");
        let alternate = engine.take_render_frame().expect("alternate frame");
        assert!(alternate.alternate_screen);

        engine.feed(b"\x1b[?1049l");
        let primary = engine.take_render_frame().expect("restored frame");
        assert!(!primary.alternate_screen);
    }

    #[test]
    fn in_place_spinner_on_alternate_screen_emits_each_glyph() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        engine.feed(b"\x1b[?1049h\x1b[H\x1b[2J");
        let _ = engine.take_render_frame();

        engine.feed("\x1b[H⠋".as_bytes());
        let first = engine.take_render_frame().expect("spinner frame 1");
        assert!(first.dirty_rows.iter().any(|row| {
            row.cells
                .iter()
                .any(|cell| cell.text.contains('\u{280B}') || cell.text.contains('⠋'))
        }));

        engine.feed("\x1b[H⠙".as_bytes());
        let second = engine.take_render_frame().expect("spinner frame 2");
        assert!(second.dirty_rows.iter().any(|row| {
            row.cells
                .iter()
                .any(|cell| cell.text.contains('\u{2819}') || cell.text.contains('⠙'))
        }));
    }

    #[test]
    fn synchronized_output_holds_until_reset() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        engine.feed(b"\x1b[?2026h\x1b[Hpartial");
        assert!(
            engine.take_render_frame().is_none(),
            "held mid-frame must not extract"
        );
        engine.feed(b" done\x1b[?2026l");
        let frame = engine.take_render_frame().expect("flushed frame");
        let text: String = frame
            .dirty_rows
            .iter()
            .flat_map(|row| row.cells.iter().map(|cell| cell.text.as_str()))
            .collect();
        assert!(
            text.contains("partial done"),
            "flushed frame missed held output: {text:?}"
        );
    }

    #[test]
    fn synchronized_output_flushes_after_timeout() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        engine.feed(b"\x1b[?2026h\x1b[Hpartial");
        assert!(engine.take_render_frame().is_none());
        engine.backdate_synchronized_hold(
            crate::terminal_engine::sync_output::HOLD_TIMEOUT + Duration::from_millis(20),
        );
        let frame = engine.take_render_frame().expect("timeout flush");
        let text: String = frame
            .dirty_rows
            .iter()
            .flat_map(|row| row.cells.iter().map(|cell| cell.text.as_str()))
            .collect();
        assert!(
            text.contains("partial"),
            "timeout flush missed held output: {text:?}"
        );
    }

    #[test]
    fn synchronized_output_hold_is_capped_even_while_bytes_keep_arriving() {
        let mut engine = engine();
        let _ = engine.take_render_frame();

        engine.feed(b"\x1b[?2026h\x1b[Hframe-1");
        assert!(
            engine.take_render_frame().is_none(),
            "held mid-frame must not extract"
        );

        // More bytes keep arriving inside the hold - the old per-byte idle
        // timer would push HOLD_TIMEOUT back on every one of these; the
        // total-duration cap must not.
        engine.feed(b"frame-2");
        engine.feed(b"frame-3");
        assert!(engine.take_render_frame().is_none());

        engine.backdate_synchronized_hold(
            crate::terminal_engine::sync_output::HOLD_TIMEOUT + Duration::from_millis(20),
        );

        let frame = engine.take_render_frame().expect("capped hold must flush");
        let text: String = frame
            .dirty_rows
            .iter()
            .flat_map(|row| row.cells.iter().map(|cell| cell.text.as_str()))
            .collect();
        assert!(
            text.contains("frame-1frame-2frame-3"),
            "capped flush must include everything buffered before the cap: {text:?}"
        );
    }

    #[test]
    fn repaint_split_across_feeds_exposes_the_hidden_cursor_between_them() {
        // This is the bug the PTY pump exists to avoid: an extraction that
        // lands between two `feed` calls covering one repaint sees the
        // model's torn, mid-repaint state.
        let mut engine = engine();
        let _ = engine.take_render_frame();

        engine.feed(b"\x1b[?25l\x1b[Hspinner");
        let mid_repaint = engine
            .take_render_frame()
            .expect("mid-repaint frame extracted between two feeds");
        assert_eq!(
            mid_repaint.cursor.visibility,
            CursorVisibility::Hidden,
            "an extraction landing between two feeds must see the torn, hidden-cursor state"
        );

        engine.feed(b"\x1b[?25h");
        let restored = engine.take_render_frame().expect("cursor restored frame");
        assert_eq!(restored.cursor.visibility, CursorVisibility::Visible);

        // The same bytes fed as a single burst - what the PTY pump
        // guarantees - never exposes the intermediate hidden state: exactly
        // one frame comes out, and its cursor is already visible.
        let mut atomic_engine = engine_with_size(4, 12);
        let _ = atomic_engine.take_render_frame();
        atomic_engine.feed(b"\x1b[?25l\x1b[Hspinner\x1b[?25h");
        let frame = atomic_engine
            .take_render_frame()
            .expect("single frame for the whole burst");
        assert_eq!(frame.cursor.visibility, CursorVisibility::Visible);
        assert!(
            atomic_engine.take_render_frame().is_none(),
            "one feed of one burst must produce exactly one frame"
        );
    }

    #[test]
    fn leaving_the_alternate_screen_emits_a_full_snapshot_of_primary_rows() {
        let mut engine = engine_with_size(4, 12);
        let _ = engine.take_render_frame();

        // Scroll the primary screen first so restoring it has to repaint
        // physical rows that already have scrollback above them - wezterm's
        // dirty tracking marks those rows against the oldest physical row,
        // not the visible viewport, so this only reproduces with existing
        // scrollback.
        for line in 0..8 {
            engine.feed(format!("line {line}\r\n").as_bytes());
        }
        let _ = engine.take_render_frame();

        engine.feed(b"\x1b[?1049h\x1b[2Jalt screen");
        let alternate = engine.take_render_frame().expect("alternate frame");
        assert!(alternate.alternate_screen);
        assert!(
            alternate.full_snapshot,
            "switching screens must force a full snapshot"
        );

        engine.feed(b"\x1b[?1049l");
        let primary = engine.take_render_frame().expect("restored frame");
        assert!(!primary.alternate_screen);
        assert!(
            primary.full_snapshot,
            "leaving the alternate screen must force a full snapshot of the primary rows"
        );
        assert_eq!(
            primary.dirty_rows.len(),
            primary.rows as usize,
            "a full snapshot must include every visible row, not just wezterm's dirty-marked rows"
        );
    }

    #[test]
    fn sgr_blink_is_preserved_and_not_compacted_with_steady_cells() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        engine.feed(b"\x1b[5mX\x1b[25mY");
        let frame = engine.take_render_frame().expect("blink frame");
        let cells: Vec<_> = frame
            .dirty_rows
            .iter()
            .flat_map(|row| row.cells.iter())
            .collect();
        assert!(
            cells
                .iter()
                .any(|cell| cell.text.contains('X') && cell.blink == CellBlink::Slow),
            "missing blinking X: {cells:?}"
        );
        assert!(
            cells
                .iter()
                .any(|cell| cell.text.contains('Y') && cell.blink == CellBlink::None),
            "Y must stay steady: {cells:?}"
        );
        assert!(
            !cells.iter().any(|cell| cell.text.contains("XY")),
            "blink and steady cells were compacted: {cells:?}"
        );
    }

    #[test]
    fn synchronized_output_query_reports_supported() {
        let (mut engine, output) = capture_engine();
        let _ = take_output(&output);
        engine.feed(b"\x1b[?2026$p");
        assert_eq!(wait_for_output(&output), b"\x1b[?2026;2$y");
    }

    #[test]
    #[ignore = "large-output stress test; run with cargo test -- --ignored"]
    fn bounds_scrollback_after_one_hundred_megabytes_of_output() {
        let mut engine = engine_with_size(24, 80);
        let _ = engine.take_render_frame();

        let line = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\r\n";
        let mut chunk = Vec::with_capacity(16 * 1024);
        while chunk.len() < 16 * 1024 {
            chunk.extend_from_slice(line);
        }
        let repeats = (100 * 1024 * 1024 / chunk.len()).max(1);
        for _ in 0..repeats {
            engine.feed(&chunk);
        }
        engine.feed(b"PT_100MB_LAST_LINE\r\n");

        let frame = engine.take_render_frame().expect("large output frame");
        assert!(frame.scrollback_length <= DEFAULT_SCROLLBACK_LINES);
        assert!(!engine
            .search(&TerminalSearchQuery {
                query: "PT_100MB_LAST_LINE".into(),
                case_sensitive: true,
                direction: TerminalSearchDirection::Forward,
                start: None,
            })
            .is_empty());
    }

    #[test]
    #[ignore = "performance probe; run with cargo test -- --ignored --nocapture"]
    fn render_frame_benchmark_reports_metrics() {
        use std::time::Instant;

        let mut engine = engine();
        let _ = engine.take_render_frame();

        let line = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\r\n";
        let mut chunk = Vec::with_capacity(16 * 1024);
        while chunk.len() < 16 * 1024 {
            chunk.extend_from_slice(line);
        }
        let target_bytes = 8 * 1024 * 1024;
        let mut fed_bytes = 0usize;
        let parse_started = Instant::now();
        while fed_bytes < target_bytes {
            engine.feed(&chunk);
            fed_bytes = fed_bytes.saturating_add(chunk.len());
        }
        engine.feed(b"PT_BENCH\r\n");
        let parse_elapsed = parse_started.elapsed();

        let snapshot_started = Instant::now();
        let frame = engine.take_render_frame().expect("benchmark frame");
        let snapshot_elapsed = snapshot_started.elapsed();

        let serialization_started = Instant::now();
        let serialized = serde_json::to_vec(&frame).expect("serialize benchmark frame");
        let serialization_elapsed = serialization_started.elapsed();

        let search_results = engine.search(&TerminalSearchQuery {
            query: "PT_BENCH".into(),
            case_sensitive: true,
            direction: TerminalSearchDirection::Forward,
            start: None,
        });
        assert!(frame.scrollback_length <= DEFAULT_SCROLLBACK_LINES);
        assert!(!frame.dirty_rows.is_empty());
        assert!(!serialized.is_empty());
        assert!(!search_results.is_empty());

        println!(
            "terminal_benchmark input_bytes={} parse_ms={:.2} snapshot_us={} serialize_us={} dirty_rows={} frame_bytes={} scrollback_rows={}",
            fed_bytes,
            parse_elapsed.as_secs_f64() * 1_000.0,
            snapshot_elapsed.as_micros(),
            serialization_elapsed.as_micros(),
            frame.dirty_rows.len(),
            serialized.len(),
            frame.scrollback_length,
        );
    }

    #[test]
    fn resize_requests_a_full_snapshot_and_deduplicates_same_size() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        engine.resize(TerminalSize {
            rows: 6,
            cols: 20,
            pixel_width: 0,
            pixel_height: 0,
            dpi: 96,
        });
        let frame = engine.take_render_frame().expect("resize frame");
        assert!(frame.full_snapshot);
        assert_eq!((frame.rows, frame.cols), (6, 20));
        engine.resize(TerminalSize {
            rows: 6,
            cols: 20,
            pixel_width: 0,
            pixel_height: 0,
            dpi: 96,
        });
        assert!(engine.take_render_frame().is_none());
    }

    #[test]
    fn viewport_moves_over_stable_scrollback_rows_without_changing_cursor_model() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        engine.feed(b"one\ntwo\nthree\nfour\nfive\nsix\n");
        let bottom = engine.take_render_frame().expect("bottom frame");
        assert_eq!(bottom.viewport_bottom, bottom.viewport_top);
        assert!(bottom.scrollback_length > 0);

        engine.set_viewport_top(0);
        let scrolled = engine.take_render_frame().expect("scrollback frame");
        assert!(scrolled.full_snapshot);
        assert_eq!(scrolled.viewport_top, 0);
        assert_eq!(scrolled.viewport_bottom, bottom.viewport_bottom);
        assert!(matches!(
            scrolled.cursor.visibility,
            super::super::CursorVisibility::Hidden
        ));
    }

    #[test]
    fn searches_rust_owned_scrollback_with_unicode_cell_columns() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        engine.feed("界 alpha\r\nSECOND alpha".as_bytes());

        let results = engine.search(&TerminalSearchQuery {
            query: "ALPHA".into(),
            case_sensitive: false,
            direction: TerminalSearchDirection::Forward,
            start: None,
        });
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].stable_row, 0);
        assert_eq!(results[0].start_column, 3);
        assert_eq!(results[0].end_column, 8);
        assert_eq!(results[1].stable_row, 1);
    }

    #[test]
    fn search_direction_rotates_from_a_stable_position() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        engine.feed(b"one one\r\ntwo one");

        let forward = engine.search(&TerminalSearchQuery {
            query: "one".into(),
            case_sensitive: true,
            direction: TerminalSearchDirection::Forward,
            start: Some(TerminalSearchPosition {
                stable_row: 0,
                column: 1,
            }),
        });
        assert_eq!(forward[0].stable_row, 0);
        assert_eq!(forward[0].start_column, 4);

        let backward = engine.search(&TerminalSearchQuery {
            query: "one".into(),
            case_sensitive: true,
            direction: TerminalSearchDirection::Backward,
            start: Some(TerminalSearchPosition {
                stable_row: 1,
                column: 1,
            }),
        });
        assert_eq!(backward[0].stable_row, 0);
        assert_eq!(backward[0].start_column, 4);
    }

    #[test]
    fn extracts_selection_text_from_stable_rows_and_wide_cells() {
        let mut engine = engine();
        let _ = engine.take_render_frame();
        engine.feed("one two\r\n界 alpha\r\nlast".as_bytes());

        let selected = engine.selection_text(
            &super::super::TerminalSelectionPoint {
                stable_row: 1,
                column: 8,
            },
            &super::super::TerminalSelectionPoint {
                stable_row: 0,
                column: 0,
            },
        );
        assert_eq!(selected, "one two\n界 alpha");
    }

    /// The regression this guards: ConPTY hands a shell's repaint to us as
    /// `CSI ? 25 l` in one read and the redraw plus `CSI ? 25 h` in the next,
    /// so publishing the bare hide made the cursor strobe once per keystroke.
    #[test]
    fn a_bare_cursor_hide_is_not_published_while_a_repaint_is_in_flight() {
        let mut engine = engine();
        engine.feed(b"prompt> ");
        engine.take_render_frame().expect("initial frame");

        // The repaint's opening hide arrives on its own: nothing to show yet.
        engine.feed(b"\x1b[?25l");
        assert!(
            engine.take_render_frame().is_none(),
            "a bare cursor hide must not reach the renderer on its own"
        );

        // The rest of the repaint lands, ending with the cursor shown again.
        engine.feed(b"x\x1b[?25h");
        let frame = engine.take_render_frame().expect("repaint frame");
        assert_eq!(
            frame.cursor.visibility,
            CursorVisibility::Visible,
            "the renderer must never observe the transient hidden state"
        );
        assert_eq!(frame.cursor.column, 9);
    }

    #[test]
    fn a_cursor_hide_that_outlives_the_grace_window_is_published() {
        let mut engine = engine();
        engine.feed(b"prompt> ");
        engine.take_render_frame().expect("initial frame");

        engine.feed(b"\x1b[?25l");
        assert!(engine.take_render_frame().is_none(), "hide deferred");

        // An app that genuinely parks its cursor keeps it hidden; once the
        // grace window passes the hide is honored rather than dropped.
        engine.backdate_cursor_hide(CURSOR_HIDE_GRACE + Duration::from_millis(10));
        let frame = engine
            .take_render_frame()
            .expect("a persistent hide must eventually be published");
        assert_eq!(frame.cursor.visibility, CursorVisibility::Hidden);
    }

    #[test]
    fn a_cursor_hide_that_arrives_with_content_is_published_immediately() {
        let mut engine = engine();
        engine.feed(b"prompt> ");
        engine.take_render_frame().expect("initial frame");

        // Deferral must never hold back a frame that carries real output -
        // only the content-free hide is provisional.
        engine.feed(b"\x1b[?25lredrawn");
        let frame = engine
            .take_render_frame()
            .expect("a frame carrying dirty rows must not be deferred");
        assert_eq!(frame.cursor.visibility, CursorVisibility::Hidden);
        assert!(!frame.dirty_rows.is_empty());
    }

    #[test]
    fn cursor_hide_remaining_reports_only_while_a_hide_is_pending() {
        let mut engine = engine();
        engine.feed(b"prompt> ");
        engine.take_render_frame().expect("initial frame");
        assert!(engine.cursor_hide_remaining().is_none());

        engine.feed(b"\x1b[?25l");
        assert!(engine.take_render_frame().is_none());
        assert!(
            engine.cursor_hide_remaining().is_some(),
            "the scheduler needs a deadline to wake on, or the hide would \
             never be published without more PTY output"
        );

        engine.feed(b"\x1b[?25h");
        let _ = engine.take_render_frame();
        assert!(engine.cursor_hide_remaining().is_none());
    }
}
