#[cfg(any(target_os = "macos", windows))]
use cef::*;
use serde::Serialize;

pub(crate) const HOST_SHORTCUT_EVENT: &str = "browser_surface_host_shortcut";

const KEY_ENTER: i32 = 0x0D;
const KEY_ESCAPE: i32 = 0x1B;
const KEY_K: i32 = 0x4B;
const KEY_O: i32 = 0x4F;

// cef_event_flags_t values are stable CEF ABI values. Keep the classifier
// independent from the platform bindings so its ownership contract can be
// exercised without creating a browser or loading the CEF framework.
const MODIFIER_SHIFT: u32 = 1 << 1;
const MODIFIER_CONTROL: u32 = 1 << 2;
const MODIFIER_ALT: u32 = 1 << 3;
const MODIFIER_COMMAND: u32 = 1 << 7;
const MODIFIER_ALT_GR: u32 = 1 << 12;
const MODIFIER_REPEAT: u32 = 1 << 13;
const SEMANTIC_MODIFIERS: u32 =
    MODIFIER_SHIFT | MODIFIER_CONTROL | MODIFIER_ALT | MODIFIER_COMMAND | MODIFIER_ALT_GR;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostKeyPhase {
    RawKeyDown,
    KeyDown,
    KeyUp,
    Character,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostPrimaryModifier {
    Command,
    Control,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HostShortcutAction {
    OpenSearch,
    OpenProject,
    Submit,
    Escape,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct HostShortcutEventPayload {
    pub(crate) surface_id: String,
    pub(crate) action: HostShortcutAction,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct HostKeyEvent {
    pub(crate) phase: HostKeyPhase,
    pub(crate) windows_key_code: i32,
    pub(crate) modifiers: u32,
    pub(crate) is_system_key: bool,
    pub(crate) focus_on_editable_field: bool,
}

pub(crate) fn classify_host_shortcut(
    event: HostKeyEvent,
    primary_modifier: HostPrimaryModifier,
) -> Option<HostShortcutAction> {
    if !matches!(
        event.phase,
        HostKeyPhase::RawKeyDown | HostKeyPhase::KeyDown
    ) || event.is_system_key
        || event.modifiers & MODIFIER_REPEAT != 0
    {
        return None;
    }

    let semantic_modifiers = event.modifiers & SEMANTIC_MODIFIERS;
    if event.windows_key_code == KEY_ESCAPE && semantic_modifiers == 0 {
        // Workspace owns bare Escape even when an editor has focus so it can
        // stop a running session, matching the Wry-side Escape contract.
        return Some(HostShortcutAction::Escape);
    }

    // useKeyboardShortcuts deliberately leaves modified keys inside inputs,
    // textareas and contenteditable elements to that editor. CEF exposes the
    // same distinction, so page editing and IME input keep their shortcuts.
    if event.focus_on_editable_field {
        return None;
    }

    let expected_primary = match primary_modifier {
        HostPrimaryModifier::Command => MODIFIER_COMMAND,
        HostPrimaryModifier::Control => MODIFIER_CONTROL,
    };
    if semantic_modifiers != expected_primary {
        return None;
    }

    match event.windows_key_code {
        KEY_K => Some(HostShortcutAction::OpenSearch),
        KEY_O => Some(HostShortcutAction::OpenProject),
        KEY_ENTER => Some(HostShortcutAction::Submit),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
const PLATFORM_PRIMARY_MODIFIER: HostPrimaryModifier = HostPrimaryModifier::Command;
#[cfg(windows)]
const PLATFORM_PRIMARY_MODIFIER: HostPrimaryModifier = HostPrimaryModifier::Control;

#[cfg(any(target_os = "macos", windows))]
fn cef_key_phase(event_type: cef::KeyEventType) -> HostKeyPhase {
    if event_type == cef::KeyEventType::RAWKEYDOWN {
        HostKeyPhase::RawKeyDown
    } else if event_type == cef::KeyEventType::KEYDOWN {
        HostKeyPhase::KeyDown
    } else if event_type == cef::KeyEventType::KEYUP {
        HostKeyPhase::KeyUp
    } else {
        HostKeyPhase::Character
    }
}

#[cfg(any(target_os = "macos", windows))]
cef::wrap_keyboard_handler! {
    pub(crate) struct HostShortcutKeyboardHandler {
        app: tauri::AppHandle,
        surface_id: String,
    }

    impl KeyboardHandler {
        fn on_pre_key_event(
            &self,
            _browser: Option<&mut cef::Browser>,
            event: Option<&cef::KeyEvent>,
            _os_event: *mut u8,
            _is_keyboard_shortcut: Option<&mut ::std::os::raw::c_int>,
        ) -> ::std::os::raw::c_int {
            use tauri::Emitter;

            let Some(event) = event else {
                return 0;
            };
            let Some(action) = classify_host_shortcut(
                HostKeyEvent {
                    phase: cef_key_phase(event.type_),
                    windows_key_code: event.windows_key_code,
                    modifiers: event.modifiers,
                    is_system_key: event.is_system_key != 0,
                    focus_on_editable_field: event.focus_on_editable_field != 0,
                },
                PLATFORM_PRIMARY_MODIFIER,
            ) else {
                return 0;
            };

            if let Err(error) = self.app.emit(
                HOST_SHORTCUT_EVENT,
                HostShortcutEventPayload {
                    surface_id: self.surface_id.clone(),
                    action,
                },
            ) {
                eprintln!(
                    "emit CEF host shortcut failed surface={} action={action:?}: {error}",
                    self.surface_id,
                );
            }
            // These combinations belong to the host. Once classified, consume
            // them even if no frontend listener is present during teardown.
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(windows_key_code: i32, modifiers: u32, focus_on_editable_field: bool) -> HostKeyEvent {
        HostKeyEvent {
            phase: HostKeyPhase::RawKeyDown,
            windows_key_code,
            modifiers,
            is_system_key: false,
            focus_on_editable_field,
        }
    }

    #[test]
    fn routes_only_the_explicit_host_combinations_for_each_platform() {
        for (primary, modifier) in [
            (HostPrimaryModifier::Command, MODIFIER_COMMAND),
            (HostPrimaryModifier::Control, MODIFIER_CONTROL),
        ] {
            assert_eq!(
                classify_host_shortcut(key(KEY_K, modifier, false), primary),
                Some(HostShortcutAction::OpenSearch),
            );
            assert_eq!(
                classify_host_shortcut(key(KEY_O, modifier, false), primary),
                Some(HostShortcutAction::OpenProject),
            );
            assert_eq!(
                classify_host_shortcut(key(KEY_ENTER, modifier, false), primary),
                Some(HostShortcutAction::Submit),
            );
            assert_eq!(
                classify_host_shortcut(key(KEY_ESCAPE, 0, false), primary),
                Some(HostShortcutAction::Escape),
            );
        }
    }

    #[test]
    fn preserves_page_editing_plain_keys_ime_and_non_exact_modifiers() {
        let primary = HostPrimaryModifier::Command;
        for event in [
            key(0x43, MODIFIER_COMMAND, false), // Command+C stays in the page.
            key(KEY_K, MODIFIER_COMMAND, true), // Editable fields own Command+K.
            key(KEY_ENTER, MODIFIER_COMMAND, true),
            key(KEY_K, MODIFIER_COMMAND | MODIFIER_SHIFT, false),
            key(KEY_K, MODIFIER_COMMAND | MODIFIER_ALT, false),
            key(KEY_K, MODIFIER_COMMAND | MODIFIER_CONTROL, false),
            key(KEY_K, MODIFIER_COMMAND | MODIFIER_ALT_GR, false),
            key(KEY_K, MODIFIER_COMMAND | MODIFIER_REPEAT, false),
            key(KEY_ESCAPE, MODIFIER_COMMAND, false),
        ] {
            assert_eq!(classify_host_shortcut(event, primary), None);
        }

        let mut key_up = key(KEY_K, MODIFIER_COMMAND, false);
        key_up.phase = HostKeyPhase::KeyUp;
        assert_eq!(classify_host_shortcut(key_up, primary), None);

        let mut character = key(KEY_K, MODIFIER_COMMAND, false);
        character.phase = HostKeyPhase::Character;
        assert_eq!(classify_host_shortcut(character, primary), None);

        let mut system_key = key(KEY_K, MODIFIER_COMMAND, false);
        system_key.is_system_key = true;
        assert_eq!(classify_host_shortcut(system_key, primary), None);
    }

    #[test]
    fn bare_escape_remains_host_owned_from_editable_fields() {
        assert_eq!(
            classify_host_shortcut(key(KEY_ESCAPE, 0, true), HostPrimaryModifier::Control,),
            Some(HostShortcutAction::Escape),
        );
    }

    #[test]
    fn frontend_event_uses_stable_snake_case_action_names() {
        assert_eq!(
            serde_json::to_value(HostShortcutEventPayload {
                surface_id: "login-4-lease-a".to_string(),
                action: HostShortcutAction::OpenSearch,
            })
            .expect("serialize host shortcut event"),
            serde_json::json!({
                "surface_id": "login-4-lease-a",
                "action": "open_search",
            }),
        );
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn classifier_modifier_bits_match_the_linked_cef_abi() {
        assert_eq!(
            MODIFIER_SHIFT,
            cef::sys::cef_event_flags_t::EVENTFLAG_SHIFT_DOWN.0,
        );
        assert_eq!(
            MODIFIER_CONTROL,
            cef::sys::cef_event_flags_t::EVENTFLAG_CONTROL_DOWN.0,
        );
        assert_eq!(
            MODIFIER_ALT,
            cef::sys::cef_event_flags_t::EVENTFLAG_ALT_DOWN.0,
        );
        assert_eq!(
            MODIFIER_COMMAND,
            cef::sys::cef_event_flags_t::EVENTFLAG_COMMAND_DOWN.0,
        );
        assert_eq!(
            MODIFIER_ALT_GR,
            cef::sys::cef_event_flags_t::EVENTFLAG_ALTGR_DOWN.0,
        );
        assert_eq!(
            MODIFIER_REPEAT,
            cef::sys::cef_event_flags_t::EVENTFLAG_IS_REPEAT.0,
        );
    }
}
