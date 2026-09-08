use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use wezterm_cell::image::{ImageData, ImageDataType};
use wezterm_term::color::ColorAttribute;
use wezterm_term::{CellAttributes, CellRef, CursorPosition, Line};

const MAX_IMAGE_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;

/// A renderer-safe color.  Palette colors stay compact on the IPC boundary;
/// true colors preserve alpha so the renderer can apply the terminal theme's
/// blending rules consistently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum RenderColor {
    #[default]
    Default,
    Palette(u8),
    Rgba([u8; 4]),
}

impl RenderColor {
    fn is_default(&self) -> bool {
        matches!(self, RenderColor::Default)
    }
}

impl From<ColorAttribute> for RenderColor {
    fn from(color: ColorAttribute) -> Self {
        match color {
            ColorAttribute::Default => Self::Default,
            ColorAttribute::PaletteIndex(index) => Self::Palette(index),
            ColorAttribute::TrueColorWithPaletteFallback(color, _)
            | ColorAttribute::TrueColorWithDefaultFallback(color) => {
                Self::Rgba(color.as_rgba_u8().into())
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CellIntensity {
    #[default]
    Normal,
    Bold,
    Half,
}

impl CellIntensity {
    fn is_normal(&self) -> bool {
        matches!(self, CellIntensity::Normal)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CellUnderline {
    #[default]
    None,
    Single,
    Double,
    Curly,
    Dotted,
    Dashed,
}

impl CellUnderline {
    fn is_none(&self) -> bool {
        matches!(self, CellUnderline::None)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CellBlink {
    #[default]
    None,
    Slow,
    Rapid,
}

impl CellBlink {
    fn is_none(&self) -> bool {
        matches!(self, CellBlink::None)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAnimationFrame {
    pub data_base64: String,
    pub duration_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CursorShape {
    Default,
    BlinkingBlock,
    SteadyBlock,
    BlinkingUnderline,
    SteadyUnderline,
    BlinkingBar,
    SteadyBar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CursorVisibility {
    Hidden,
    Visible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorState {
    pub column: u16,
    pub row: i32,
    pub shape: CursorShape,
    pub visibility: CursorVisibility,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCellFrame {
    pub image_id: Option<u32>,
    pub placement_id: Option<u32>,
    pub z_index: i32,
    pub top_left: [f32; 2],
    pub bottom_right: [f32; 2],
    pub padding: [u16; 4],
    pub format: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub data_base64: Option<String>,
    /// Stable identity for the image cache.  Pixel bytes are intentionally
    /// sent through a separate cache/control path, never once per frame.
    pub cache_key: String,
    /// Extra GIF/kitty animation frames. Empty for still images; the first
    /// frame still lives in `data_base64` so a client that ignores this field
    /// paints a static image.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub animation_frames: Vec<ImageAnimationFrame>,
}

/// Almost every cell in a typical frame carries the terminal's default
/// colors/attributes at width 1 - the fields below are `skip_serializing_if`
/// so a plain cell serializes as just `{"column":N,"text":"x"}` instead of
/// 13 always-present fields, most of them repeating the same default value
/// across thousands of cells in a full snapshot. Every skipped field also
/// carries a matching `default` so a sparse JSON object (missing those keys)
/// deserializes back to the same value - this is a payload-size change only,
/// never a change to what a `RenderCell` value means.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderCell {
    pub column: u16,
    /// Columns occupied by `text`. A single wide cluster is 2; a compacted
    /// run of five ASCII characters is 5. Default 1 is omitted on the wire.
    #[serde(skip_serializing_if = "is_default_width", default = "default_width")]
    pub width: u8,
    pub text: String,
    #[serde(skip_serializing_if = "RenderColor::is_default", default)]
    pub foreground: RenderColor,
    #[serde(skip_serializing_if = "RenderColor::is_default", default)]
    pub background: RenderColor,
    #[serde(skip_serializing_if = "RenderColor::is_default", default)]
    pub underline_color: RenderColor,
    #[serde(skip_serializing_if = "CellIntensity::is_normal", default)]
    pub intensity: CellIntensity,
    #[serde(skip_serializing_if = "CellUnderline::is_none", default)]
    pub underline: CellUnderline,
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub italic: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub reverse: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub strikethrough: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub invisible: bool,
    #[serde(skip_serializing_if = "CellBlink::is_none", default)]
    pub blink: CellBlink,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub hyperlink: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub images: Vec<ImageCellFrame>,
}

fn is_default_width(width: &u8) -> bool {
    *width == 1
}

fn default_width() -> u8 {
    1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRow {
    /// Stable row identity survives scrollback movement and is the key used
    /// by viewport/selection/search code.  It is not a physical row index.
    pub stable_row: i64,
    pub cells: Vec<RenderCell>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderFrame {
    /// Monotonic attachment sequence. A gap means the incremental cache must
    /// be resynchronized from a later full snapshot.
    pub sequence: u64,
    pub rows: u16,
    pub cols: u16,
    /// When `full_snapshot` is false this contains only changed stable rows in
    /// the current viewport. Automatic scrolling may move `viewport_top`
    /// without making the frame a full snapshot; stable row identity lets the
    /// frontend retain overlapping rows across that move.
    pub dirty_rows: Vec<RenderRow>,
    pub cursor: CursorState,
    pub scrollback_length: usize,
    pub viewport_top: i64,
    pub viewport_bottom: i64,
    pub alternate_screen: bool,
    pub mouse_reporting: bool,
    /// When true, `dirty_rows` is the authoritative complete visible snapshot.
    /// It is the only frame that can rebuild an empty/incompatible cache.
    pub full_snapshot: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalControlEvent {
    Bell,
    TitleChanged { title: String },
    CwdChanged { cwd: Option<String> },
    CommandFinished { exit_code: Option<i32> },
}

pub(crate) fn cursor_state(cursor: CursorPosition) -> CursorState {
    CursorState {
        column: cursor.x.min(u16::MAX as usize) as u16,
        row: cursor.y.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        shape: match cursor.shape {
            wezterm_surface::CursorShape::Default => CursorShape::Default,
            wezterm_surface::CursorShape::BlinkingBlock => CursorShape::BlinkingBlock,
            wezterm_surface::CursorShape::SteadyBlock => CursorShape::SteadyBlock,
            wezterm_surface::CursorShape::BlinkingUnderline => CursorShape::BlinkingUnderline,
            wezterm_surface::CursorShape::SteadyUnderline => CursorShape::SteadyUnderline,
            wezterm_surface::CursorShape::BlinkingBar => CursorShape::BlinkingBar,
            wezterm_surface::CursorShape::SteadyBar => CursorShape::SteadyBar,
        },
        visibility: match cursor.visibility {
            wezterm_surface::CursorVisibility::Hidden => CursorVisibility::Hidden,
            wezterm_surface::CursorVisibility::Visible => CursorVisibility::Visible,
        },
    }
}

fn cell_intensity(attrs: &CellAttributes) -> CellIntensity {
    match attrs.intensity() {
        wezterm_term::Intensity::Normal => CellIntensity::Normal,
        wezterm_term::Intensity::Bold => CellIntensity::Bold,
        wezterm_term::Intensity::Half => CellIntensity::Half,
    }
}

fn cell_blink(attrs: &CellAttributes) -> CellBlink {
    match attrs.blink() {
        wezterm_term::Blink::None => CellBlink::None,
        wezterm_term::Blink::Slow => CellBlink::Slow,
        wezterm_term::Blink::Rapid => CellBlink::Rapid,
    }
}

fn cell_underline(attrs: &CellAttributes) -> CellUnderline {
    match attrs.underline() {
        wezterm_term::Underline::None => CellUnderline::None,
        wezterm_term::Underline::Single => CellUnderline::Single,
        wezterm_term::Underline::Double => CellUnderline::Double,
        wezterm_term::Underline::Curly => CellUnderline::Curly,
        wezterm_term::Underline::Dotted => CellUnderline::Dotted,
        wezterm_term::Underline::Dashed => CellUnderline::Dashed,
    }
}

fn image_frames(attrs: &CellAttributes) -> Vec<ImageCellFrame> {
    attrs
        .images()
        .unwrap_or_default()
        .into_iter()
        .map(|image| {
            let data = image.image_data();
            let payload = image_payload(data);
            let top_left = image.top_left();
            let bottom_right = image.bottom_right();
            ImageCellFrame {
                image_id: image.image_id(),
                placement_id: image.placement_id(),
                z_index: image.z_index(),
                top_left: [top_left.x.into_inner(), top_left.y.into_inner()],
                bottom_right: [bottom_right.x.into_inner(), bottom_right.y.into_inner()],
                padding: {
                    let (left, top, right, bottom) = image.padding();
                    [left, top, right, bottom]
                },
                format: payload
                    .as_ref()
                    .map(|payload| payload.format.to_string())
                    .unwrap_or_else(|| "encoded".to_string()),
                mime_type: payload
                    .as_ref()
                    .map(|payload| payload.mime_type.to_string())
                    .unwrap_or_else(|| "application/octet-stream".to_string()),
                width: payload.as_ref().map(|payload| payload.width).unwrap_or(0),
                height: payload.as_ref().map(|payload| payload.height).unwrap_or(0),
                data_base64: payload.as_ref().map(|payload| payload.data_base64.clone()),
                cache_key: hex_encode(&data.hash()),
                animation_frames: payload
                    .map(|payload| payload.animation_frames)
                    .unwrap_or_default(),
            }
        })
        .collect()
}

/// Lowercase hex encoding without a `format!` allocation per byte - this
/// runs once per image cell per frame.
fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

struct ImagePayload {
    format: &'static str,
    mime_type: &'static str,
    width: u32,
    height: u32,
    data_base64: String,
    animation_frames: Vec<ImageAnimationFrame>,
}

fn image_payload(data: &ImageData) -> Option<ImagePayload> {
    fn encoded(
        data: Vec<u8>,
        format: &'static str,
        width: u32,
        height: u32,
        animation_frames: Vec<ImageAnimationFrame>,
    ) -> Option<ImagePayload> {
        if data.len() > MAX_IMAGE_PAYLOAD_BYTES {
            return None;
        }
        Some(ImagePayload {
            format,
            mime_type: image_mime_type(&data),
            width,
            height,
            data_base64: BASE64.encode(data),
            animation_frames,
        })
    }

    match &*data.data() {
        ImageDataType::EncodedFile(bytes) => encoded(bytes.clone(), "encoded", 0, 0, Vec::new()),
        ImageDataType::EncodedLease(lease) => lease
            .get_data()
            .ok()
            .and_then(|bytes| encoded(bytes, "encoded", 0, 0, Vec::new())),
        ImageDataType::Rgba8 {
            data,
            width,
            height,
            ..
        } => encoded(data.clone(), "rgba8", *width, *height, Vec::new()),
        ImageDataType::AnimRgba8 {
            frames,
            width,
            height,
            durations,
            ..
        } => {
            let animation_frames = if frames.len() > 1 {
                frames
                    .iter()
                    .zip(durations.iter())
                    .filter(|frame| frame.0.len() <= MAX_IMAGE_PAYLOAD_BYTES)
                    .map(|(frame, duration)| ImageAnimationFrame {
                        data_base64: BASE64.encode(frame),
                        duration_ms: duration.as_millis().min(u128::from(u32::MAX)) as u32,
                    })
                    .collect()
            } else {
                Vec::new()
            };
            frames
                .first()
                .cloned()
                .and_then(|data| encoded(data, "rgba8", *width, *height, animation_frames))
        }
    }
}

fn image_mime_type(data: &[u8]) -> &'static str {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if data.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if data.starts_with(b"GIF8") {
        "image/gif"
    } else if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

pub(crate) fn render_row(stable_row: i64, line: &Line) -> RenderRow {
    let cells = line
        .visible_cells()
        .map(|cell: wezterm_term::CellRef<'_>| render_cell(cell))
        .collect();
    RenderRow {
        stable_row,
        cells: compact_render_cells(cells),
    }
}

/// Collapse adjacent cells that share attributes into one run.
///
/// Agent TUIs rewrite whole lines of identically-styled text (status bars,
/// spinners, markdown, file lists). One run serializes as a single JSON
/// object whose `width` is the occupied column count, instead of one object
/// per column. Renderers treat `width` as the columns occupied by `text`,
/// which already held for a single wide cluster.
pub(crate) fn compact_render_cells(cells: Vec<RenderCell>) -> Vec<RenderCell> {
    let mut compacted = Vec::with_capacity(cells.len());
    for cell in cells {
        if let Some(previous) = compacted.last_mut() {
            if try_merge_render_cell(previous, &cell) {
                continue;
            }
        }
        compacted.push(cell);
    }
    compacted
}

fn try_merge_render_cell(previous: &mut RenderCell, next: &RenderCell) -> bool {
    if !can_merge_render_cell(previous, next) {
        return false;
    }
    previous.text.push_str(&next.text);
    previous.width = previous.width.saturating_add(next.width);
    true
}

fn can_merge_render_cell(previous: &RenderCell, next: &RenderCell) -> bool {
    let previous_end = previous.column as u32 + previous.width as u32;
    let Some(previous_cluster_width) = cluster_width(previous) else {
        return false;
    };
    let Some(next_cluster_width) = cluster_width(next) else {
        return false;
    };
    previous_end == next.column as u32
        && previous_cluster_width == next_cluster_width
        && next.text.chars().count() == 1
        && previous.foreground == next.foreground
        && previous.background == next.background
        && previous.underline_color == next.underline_color
        && previous.intensity == next.intensity
        && previous.underline == next.underline
        && previous.italic == next.italic
        && previous.reverse == next.reverse
        && previous.strikethrough == next.strikethrough
        && previous.invisible == next.invisible
        && previous.blink == next.blink
        && previous.hyperlink == next.hyperlink
        && previous.images.is_empty()
        && next.images.is_empty()
}

fn cluster_width(cell: &RenderCell) -> Option<u8> {
    let clusters = cell.text.chars().count();
    if clusters == 0 || cell.width == 0 {
        return None;
    }
    if cell.width as usize % clusters != 0 {
        return None;
    }
    u8::try_from(cell.width as usize / clusters).ok()
}

fn render_cell(cell: CellRef<'_>) -> RenderCell {
    let attrs = cell.attrs();
    RenderCell {
        column: cell.cell_index().min(u16::MAX as usize) as u16,
        width: cell.width().min(u8::MAX as usize) as u8,
        text: cell.str().to_string(),
        foreground: attrs.foreground().into(),
        background: attrs.background().into(),
        underline_color: attrs.underline_color().into(),
        intensity: cell_intensity(attrs),
        underline: cell_underline(attrs),
        italic: attrs.italic(),
        reverse: attrs.reverse(),
        strikethrough: attrs.strikethrough(),
        invisible: attrs.invisible(),
        blink: cell_blink(attrs),
        hyperlink: attrs.hyperlink().map(|link| link.uri().to_string()),
        images: image_frames(attrs),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain_cell(column: u16, text: &str) -> RenderCell {
        RenderCell {
            column,
            width: 1,
            text: text.to_string(),
            foreground: RenderColor::Default,
            background: RenderColor::Default,
            underline_color: RenderColor::Default,
            intensity: CellIntensity::Normal,
            underline: CellUnderline::None,
            italic: false,
            reverse: false,
            strikethrough: false,
            invisible: false,
            blink: CellBlink::None,
            hyperlink: None,
            images: Vec::new(),
        }
    }

    #[test]
    fn compact_cells_merges_adjacent_runs_with_the_same_attributes() {
        let cells = compact_render_cells(vec![
            plain_cell(0, "h"),
            plain_cell(1, "e"),
            plain_cell(2, "l"),
            plain_cell(3, "l"),
            plain_cell(4, "o"),
        ]);
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].column, 0);
        assert_eq!(cells[0].text, "hello");
        assert_eq!(cells[0].width, 5);
    }

    #[test]
    fn compact_cells_do_not_merge_across_attribute_or_column_gaps() {
        let mut red = plain_cell(0, "a");
        red.foreground = RenderColor::Palette(1);
        let mut blue = plain_cell(1, "b");
        blue.foreground = RenderColor::Palette(4);
        let later = plain_cell(4, "c");

        let cells = compact_render_cells(vec![red, blue, later]);
        assert_eq!(cells.len(), 3);
        assert_eq!(cells[0].text, "a");
        assert_eq!(cells[1].text, "b");
        assert_eq!(cells[2].column, 4);
        assert_eq!(cells[2].text, "c");
    }

    #[test]
    fn compact_cells_keep_wide_clusters_and_hyperlink_runs_intact() {
        let mut wide = plain_cell(0, "界");
        wide.width = 2;
        let mut linked = plain_cell(2, "l");
        linked.hyperlink = Some("https://example.com".into());
        let mut i = plain_cell(3, "i");
        i.hyperlink = Some("https://example.com".into());
        let mut n = plain_cell(4, "n");
        n.hyperlink = Some("https://example.com".into());
        let mut k = plain_cell(5, "k");
        k.hyperlink = Some("https://example.com".into());

        let cells = compact_render_cells(vec![wide, linked, i, n, k]);
        assert_eq!(cells.len(), 2);
        assert_eq!(cells[0].text, "界");
        assert_eq!(cells[0].width, 2);
        assert_eq!(cells[1].text, "link");
        assert_eq!(cells[1].width, 4);
        assert_eq!(cells[1].hyperlink.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn compact_cells_shrink_a_full_width_agent_tui_line() {
        let cells = compact_render_cells(
            (0..80)
                .map(|column| {
                    let mut cell = plain_cell(column, " ");
                    cell.background = RenderColor::Palette(4);
                    cell
                })
                .collect(),
        );
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].text, " ".repeat(80));
        assert_eq!(cells[0].width, 80);
        let json = serde_json::to_string(&cells).unwrap();
        assert!(
            json.len() < 200,
            "agent-style space run stayed too large: {} bytes",
            json.len()
        );
    }

    /// The whole point of the sparse encoding: a plain cell (the overwhelming
    /// majority in any real frame) must carry only what actually varies.
    #[test]
    fn a_plain_cell_serializes_to_only_column_and_text() {
        let cell = plain_cell(3, "x");
        let json = serde_json::to_string(&cell).unwrap();
        assert_eq!(json, r#"{"column":3,"text":"x"}"#);
    }

    #[test]
    fn a_sparse_cell_round_trips_through_json() {
        let cell = plain_cell(5, "y");
        let json = serde_json::to_string(&cell).unwrap();
        let decoded: RenderCell = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, cell);
    }

    /// A cell where every attribute differs from its default must still
    /// serialize every field (nothing silently dropped) and round-trip.
    #[test]
    fn a_fully_attributed_cell_still_serializes_every_field_and_round_trips() {
        let cell = RenderCell {
            column: 1,
            width: 2,
            text: "字".to_string(),
            foreground: RenderColor::Palette(3),
            background: RenderColor::Rgba([10, 20, 30, 255]),
            underline_color: RenderColor::Palette(9),
            intensity: CellIntensity::Bold,
            underline: CellUnderline::Curly,
            italic: true,
            reverse: true,
            strikethrough: true,
            invisible: true,
            blink: CellBlink::Slow,
            hyperlink: Some("https://example.com".to_string()),
            images: vec![ImageCellFrame {
                image_id: Some(1),
                placement_id: None,
                z_index: 0,
                top_left: [0.0, 0.0],
                bottom_right: [1.0, 1.0],
                padding: [0, 0, 0, 0],
                format: "rgba8".to_string(),
                mime_type: "application/octet-stream".to_string(),
                width: 4,
                height: 4,
                data_base64: Some("AAAA".to_string()),
                cache_key: "abcd".to_string(),
                animation_frames: Vec::new(),
            }],
        };
        let json = serde_json::to_string(&cell).unwrap();
        let decoded: RenderCell = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, cell);
        for key in [
            "width",
            "foreground",
            "background",
            "underlineColor",
            "intensity",
            "underline",
            "italic",
            "reverse",
            "strikethrough",
            "invisible",
            "blink",
            "hyperlink",
            "images",
        ] {
            assert!(json.contains(key), "expected {key} in {json}");
        }
    }

    #[test]
    fn compact_cells_do_not_merge_blink_with_steady() {
        let mut blinking = plain_cell(0, "X");
        blinking.blink = CellBlink::Slow;
        let steady = plain_cell(1, "Y");
        let cells = compact_render_cells(vec![blinking, steady]);
        assert_eq!(cells.len(), 2);
        assert_eq!(cells[0].blink, CellBlink::Slow);
        assert_eq!(cells[1].blink, CellBlink::None);
    }

    #[test]
    fn anim_rgba8_payload_includes_every_frame() {
        let frame_a = vec![255, 0, 0, 255];
        let frame_b = vec![0, 255, 0, 255];
        let data = wezterm_cell::image::ImageData::with_data(ImageDataType::AnimRgba8 {
            width: 1,
            height: 1,
            durations: vec![
                std::time::Duration::from_millis(40),
                std::time::Duration::from_millis(80),
            ],
            frames: vec![frame_a, frame_b],
            hashes: vec![[0; 32], [1; 32]],
        });
        let payload = image_payload(&data).expect("anim payload");
        assert_eq!(payload.animation_frames.len(), 2);
        assert_eq!(payload.animation_frames[0].duration_ms, 40);
        assert_eq!(payload.animation_frames[1].duration_ms, 80);
        assert!(!payload.data_base64.is_empty());
    }
}
