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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum RenderColor {
    Default,
    Palette(u8),
    Rgba([u8; 4]),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CellIntensity {
    Normal,
    Bold,
    Half,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CellUnderline {
    None,
    Single,
    Double,
    Curly,
    Dotted,
    Dashed,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderCell {
    pub column: u16,
    pub width: u8,
    pub text: String,
    pub foreground: RenderColor,
    pub background: RenderColor,
    pub underline_color: RenderColor,
    pub intensity: CellIntensity,
    pub underline: CellUnderline,
    pub italic: bool,
    pub reverse: bool,
    pub strikethrough: bool,
    pub invisible: bool,
    pub hyperlink: Option<String>,
    pub images: Vec<ImageCellFrame>,
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
    pub sequence: u64,
    pub rows: u16,
    pub cols: u16,
    pub dirty_rows: Vec<RenderRow>,
    pub cursor: CursorState,
    pub scrollback_length: usize,
    pub viewport_top: i64,
    pub viewport_bottom: i64,
    pub alternate_screen: bool,
    pub mouse_reporting: bool,
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
                data_base64: payload.map(|payload| payload.data_base64),
                cache_key: data
                    .hash()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
            }
        })
        .collect()
}

struct ImagePayload {
    format: &'static str,
    mime_type: &'static str,
    width: u32,
    height: u32,
    data_base64: String,
}

fn image_payload(data: &ImageData) -> Option<ImagePayload> {
    fn encoded(
        data: Vec<u8>,
        format: &'static str,
        width: u32,
        height: u32,
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
        })
    }

    match &*data.data() {
        ImageDataType::EncodedFile(bytes) => encoded(bytes.clone(), "encoded", 0, 0),
        ImageDataType::EncodedLease(lease) => lease
            .get_data()
            .ok()
            .and_then(|bytes| encoded(bytes, "encoded", 0, 0)),
        ImageDataType::Rgba8 {
            data,
            width,
            height,
            ..
        } => encoded(data.clone(), "rgba8", *width, *height),
        ImageDataType::AnimRgba8 {
            frames,
            width,
            height,
            ..
        } => frames
            .first()
            .cloned()
            .and_then(|data| encoded(data, "rgba8", *width, *height)),
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
    RenderRow { stable_row, cells }
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
        hyperlink: attrs.hyperlink().map(|link| link.uri().to_string()),
        images: image_frames(attrs),
    }
}
