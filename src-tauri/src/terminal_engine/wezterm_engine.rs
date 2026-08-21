use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::sync::{Arc, Mutex};

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
use super::TerminalEngine;

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
pub struct WeztermTerminalEngine {
    terminal: Terminal,
    last_emitted_sequence: usize,
    last_cursor: Option<CursorState>,
    last_scrollback_length: usize,
    last_alternate_screen: bool,
    last_mouse_reporting: bool,
    last_viewport_top: Option<i64>,
    last_viewport_bottom: Option<i64>,
    last_title: String,
    last_cwd: Option<String>,
    force_full_snapshot: bool,
    viewport_top: Option<i64>,
    control_events: Arc<Mutex<VecDeque<TerminalControlEvent>>>,
    osc133_buffer: Vec<u8>,
    known_image_keys: HashSet<String>,
}

#[derive(Clone)]
struct AlertCollector {
    events: Arc<Mutex<VecDeque<TerminalControlEvent>>>,
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
        if matches!(alert, Alert::Bell) {
            push_control_event(&self.events, TerminalControlEvent::Bell);
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
        let mut terminal = Terminal::new(
            size,
            Arc::new(config) as Arc<dyn TerminalConfiguration + Send + Sync>,
            "project-terminal",
            env!("CARGO_PKG_VERSION"),
            writer,
        );
        // ConPTY reports output using Windows console semantics.  Keeping
        // this upstream compatibility switch enabled is important for line
        // wrapping and resize behavior on PowerShell/cmd.
        terminal.enable_conpty_quirks();
        terminal.set_notification_handler(Box::new(AlertCollector {
            events: events.clone(),
        }));

        let mut engine = Self {
            terminal,
            last_emitted_sequence: 0,
            last_cursor: None,
            last_scrollback_length: 0,
            last_alternate_screen: false,
            last_mouse_reporting: false,
            last_viewport_top: None,
            last_viewport_bottom: None,
            last_title: String::new(),
            last_cwd: None,
            force_full_snapshot: true,
            viewport_top: None,
            control_events: events,
            osc133_buffer: Vec::new(),
            known_image_keys: HashSet::new(),
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
        let title = self.terminal.get_title().to_string();
        if title != self.last_title {
            self.last_title = title.clone();
            push_control_event(
                &self.control_events,
                TerminalControlEvent::TitleChanged { title },
            );
        }

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
        const MAX_BUFFER: usize = 16 * 1024;

        self.osc133_buffer.extend_from_slice(data);
        if self.osc133_buffer.len() > MAX_BUFFER {
            let keep_from = self
                .osc133_buffer
                .len()
                .saturating_sub(PREFIX.len().saturating_sub(1));
            self.osc133_buffer.drain(..keep_from);
        }

        loop {
            let Some(start) = self
                .osc133_buffer
                .windows(PREFIX.len())
                .position(|window| window == PREFIX)
            else {
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

        stable_rows
            .into_iter()
            .filter_map(|stable_row| {
                let phys = screen.stable_row_to_phys(stable_row)?;
                let line = screen
                    .lines_in_phys_range(phys..phys.saturating_add(1))
                    .pop()?;
                Some(render_row(stable_row as i64, &line))
            })
            .collect()
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
        self.collect_command_finished_marks(data);
        self.terminal.advance_bytes(data);
        self.collect_control_events();
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
        // Title/cwd are stateful and are re-enqueued below. Bell and command
        // completion are edge-triggered; replaying events that accumulated
        // while a renderer was detached would make a newly attached view act
        // on stale history, so discard the old control queue during a full
        // resync.
        self.control_events.lock().unwrap().clear();
        if !self.last_title.is_empty() {
            push_control_event(
                &self.control_events,
                TerminalControlEvent::TitleChanged {
                    title: self.last_title.clone(),
                },
            );
        }
        if self.last_cwd.is_some() {
            push_control_event(
                &self.control_events,
                TerminalControlEvent::CwdChanged {
                    cwd: self.last_cwd.clone(),
                },
            );
        }
    }

    fn set_viewport_top(&mut self, stable_row: i64) {
        self.set_viewport(stable_row);
    }

    fn take_render_frame(&mut self) -> Option<RenderFrame> {
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
        let full_snapshot = self.force_full_snapshot;
        let mut dirty_rows = self.changed_rows(full_snapshot, viewport_top, rows);
        self.prepare_image_payloads(&mut dirty_rows);
        let cursor_changed = self.last_cursor.as_ref() != Some(&cursor);
        let viewport_changed = self.last_scrollback_length != scrollback_length
            || self.last_alternate_screen != alternate_screen
            || self.last_mouse_reporting != mouse_reporting
            || self.last_viewport_top != Some(viewport_top)
            || self.last_viewport_bottom != Some(viewport_bottom);

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

        Some(RenderFrame {
            sequence: self.last_emitted_sequence as u64,
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

    for stable_row in first_row..bottom_row {
        let Some(phys_row) = screen.stable_row_to_phys(stable_row as isize) else {
            continue;
        };
        let Some(line) = screen
            .lines_in_phys_range(phys_row..phys_row.saturating_add(1))
            .pop()
        else {
            continue;
        };
        let searchable = searchable_line(&line, query.case_sensitive);
        if searchable.chars.len() < needle.len() {
            continue;
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
    use crate::terminal_engine::{RenderColor, TerminalEngine, DEFAULT_SCROLLBACK_LINES};

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

    fn engine() -> WeztermTerminalEngine {
        WeztermTerminalEngine::new(
            TerminalSize {
                rows: 4,
                cols: 12,
                pixel_width: 0,
                pixel_height: 0,
                dpi: 96,
            },
            WeztermTerminalConfig::default(),
            Box::new(NoopWriter),
        )
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
        assert_eq!(frame.dirty_rows[0].cells[0].text, "h");
        assert_eq!(frame.cursor.column, 5);
        assert!(engine.take_render_frame().is_none());
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
        assert_eq!(
            row.cells[2].hyperlink.as_deref(),
            Some("https://example.com")
        );
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
    #[ignore = "large-output stress test; run with cargo test -- --ignored"]
    fn bounds_scrollback_after_one_hundred_megabytes_of_output() {
        let mut engine = engine();
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
}
