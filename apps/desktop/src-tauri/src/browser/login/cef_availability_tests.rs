use super::cef::availability::{macos_version_is_supported, MACOS_MINIMUM_MAJOR};

#[test]
fn cef_150_mode_two_requires_macos_twelve_without_raising_the_shell_floor() {
    assert_eq!(MACOS_MINIMUM_MAJOR, 12);
    assert!(!macos_version_is_supported(10, 15, 7));
    assert!(!macos_version_is_supported(11, 7, 10));
    assert!(macos_version_is_supported(12, 0, 0));
    assert!(macos_version_is_supported(15, 4, 1));
}
