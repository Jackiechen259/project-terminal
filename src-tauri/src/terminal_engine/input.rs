use serde::{Deserialize, Serialize};
use wezterm_term::input::{KeyCode, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

/// Semantic keyboard input from the renderer. The renderer sends the
/// browser's key name and modifier state; it never constructs terminal escape
/// sequences itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalKeyEvent {
    pub key: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub location: u8,
    #[serde(default)]
    pub num_lock: bool,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub meta: bool,
}

impl TerminalKeyEvent {
    pub fn modifiers(&self) -> KeyModifiers {
        let mut modifiers = KeyModifiers::NONE;
        if self.shift {
            modifiers |= KeyModifiers::SHIFT;
        }
        if self.alt {
            modifiers |= KeyModifiers::ALT;
        }
        if self.ctrl {
            modifiers |= KeyModifiers::CTRL;
        }
        if self.meta {
            modifiers |= KeyModifiers::SUPER;
        }
        modifiers
    }

    pub fn key_code(&self) -> Option<KeyCode> {
        if let Some(code) = self
            .code
            .as_deref()
            .and_then(|code| numpad_key_code(code, self.num_lock))
        {
            return Some(code);
        }
        let key = match self.key.as_str() {
            "Backspace" => KeyCode::Backspace,
            "Tab" => KeyCode::Tab,
            "Enter" => KeyCode::Enter,
            "Escape" => KeyCode::Escape,
            "Delete" => KeyCode::Delete,
            "Insert" => KeyCode::Insert,
            "Home" => KeyCode::Home,
            "End" => KeyCode::End,
            "PageUp" => KeyCode::PageUp,
            "PageDown" => KeyCode::PageDown,
            "ArrowUp" => KeyCode::UpArrow,
            "ArrowDown" => KeyCode::DownArrow,
            "ArrowLeft" => KeyCode::LeftArrow,
            "ArrowRight" => KeyCode::RightArrow,
            "Clear" => KeyCode::Clear,
            "Pause" => KeyCode::Pause,
            "Numpad0" => KeyCode::Numpad0,
            "Numpad1" => KeyCode::Numpad1,
            "Numpad2" => KeyCode::Numpad2,
            "Numpad3" => KeyCode::Numpad3,
            "Numpad4" => KeyCode::Numpad4,
            "Numpad5" => KeyCode::Numpad5,
            "Numpad6" => KeyCode::Numpad6,
            "Numpad7" => KeyCode::Numpad7,
            "Numpad8" => KeyCode::Numpad8,
            "Numpad9" => KeyCode::Numpad9,
            "Multiply" => KeyCode::Multiply,
            "Add" => KeyCode::Add,
            "Subtract" => KeyCode::Subtract,
            "Decimal" => KeyCode::Decimal,
            "Divide" => KeyCode::Divide,
            "F1" => KeyCode::Function(1),
            "F2" => KeyCode::Function(2),
            "F3" => KeyCode::Function(3),
            "F4" => KeyCode::Function(4),
            "F5" => KeyCode::Function(5),
            "F6" => KeyCode::Function(6),
            "F7" => KeyCode::Function(7),
            "F8" => KeyCode::Function(8),
            "F9" => KeyCode::Function(9),
            "F10" => KeyCode::Function(10),
            "F11" => KeyCode::Function(11),
            "F12" => KeyCode::Function(12),
            "F13" => KeyCode::Function(13),
            "F14" => KeyCode::Function(14),
            "F15" => KeyCode::Function(15),
            "F16" => KeyCode::Function(16),
            "F17" => KeyCode::Function(17),
            "F18" => KeyCode::Function(18),
            "F19" => KeyCode::Function(19),
            "F20" => KeyCode::Function(20),
            "F21" => KeyCode::Function(21),
            "F22" => KeyCode::Function(22),
            "F23" => KeyCode::Function(23),
            "F24" => KeyCode::Function(24),
            "Space" => KeyCode::Char(' '),
            "Unidentified" | "Dead" => return None,
            value => {
                let mut chars = value.chars();
                let ch = chars.next()?;
                if chars.next().is_some() {
                    return None;
                }
                KeyCode::Char(ch)
            }
        };
        Some(key)
    }
}

fn numpad_key_code(code: &str, num_lock: bool) -> Option<KeyCode> {
    Some(match code {
        "Numpad0" if num_lock => KeyCode::Numpad0,
        "Numpad1" if num_lock => KeyCode::Numpad1,
        "Numpad2" if num_lock => KeyCode::Numpad2,
        "Numpad3" if num_lock => KeyCode::Numpad3,
        "Numpad4" if num_lock => KeyCode::Numpad4,
        "Numpad5" if num_lock => KeyCode::Numpad5,
        "Numpad6" if num_lock => KeyCode::Numpad6,
        "Numpad7" if num_lock => KeyCode::Numpad7,
        "Numpad8" if num_lock => KeyCode::Numpad8,
        "Numpad9" if num_lock => KeyCode::Numpad9,
        "NumpadDecimal" if num_lock => KeyCode::Decimal,
        "NumpadDivide" => KeyCode::Divide,
        "NumpadMultiply" => KeyCode::Multiply,
        "NumpadSubtract" => KeyCode::Subtract,
        "NumpadAdd" => KeyCode::Add,
        "NumpadEnter" => KeyCode::Enter,
        "NumpadClear" => KeyCode::Clear,
        _ => return None,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMouseEvent {
    pub kind: TerminalMouseEventKind,
    pub button: TerminalMouseButton,
    pub x: u16,
    pub y: i32,
    #[serde(default)]
    pub x_pixel_offset: i16,
    #[serde(default)]
    pub y_pixel_offset: i16,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub ctrl: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalMouseEventKind {
    Press,
    Release,
    Move,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalMouseButton {
    Left,
    Middle,
    Right,
    WheelUp,
    WheelDown,
    WheelLeft,
    WheelRight,
    None,
}

impl TerminalMouseEvent {
    pub fn to_wezterm(&self) -> MouseEvent {
        let mut modifiers = KeyModifiers::NONE;
        if self.shift {
            modifiers |= KeyModifiers::SHIFT;
        }
        if self.alt {
            modifiers |= KeyModifiers::ALT;
        }
        if self.ctrl {
            modifiers |= KeyModifiers::CTRL;
        }

        MouseEvent {
            kind: match self.kind {
                TerminalMouseEventKind::Press => MouseEventKind::Press,
                TerminalMouseEventKind::Release => MouseEventKind::Release,
                TerminalMouseEventKind::Move => MouseEventKind::Move,
            },
            x: self.x as usize,
            y: self.y as i64,
            x_pixel_offset: self.x_pixel_offset as isize,
            y_pixel_offset: self.y_pixel_offset as isize,
            button: match self.button {
                TerminalMouseButton::Left => MouseButton::Left,
                TerminalMouseButton::Middle => MouseButton::Middle,
                TerminalMouseButton::Right => MouseButton::Right,
                TerminalMouseButton::WheelUp => MouseButton::WheelUp(1),
                TerminalMouseButton::WheelDown => MouseButton::WheelDown(1),
                TerminalMouseButton::WheelLeft => MouseButton::WheelLeft(1),
                TerminalMouseButton::WheelRight => MouseButton::WheelRight(1),
                TerminalMouseButton::None => MouseButton::None,
            },
            modifiers,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(key: &str, code: Option<&str>, num_lock: bool) -> TerminalKeyEvent {
        TerminalKeyEvent {
            key: key.into(),
            code: code.map(str::to_string),
            location: 0,
            num_lock,
            shift: false,
            alt: false,
            ctrl: false,
            meta: false,
        }
    }

    #[test]
    fn preserves_physical_numpad_semantics_for_application_keypad_modes() {
        assert_eq!(
            key("1", Some("Numpad1"), true).key_code(),
            Some(KeyCode::Numpad1)
        );
        assert_eq!(
            key("End", Some("Numpad1"), false).key_code(),
            Some(KeyCode::End)
        );
        assert_eq!(
            key("+", Some("NumpadAdd"), false).key_code(),
            Some(KeyCode::Add)
        );
    }
}
