pub(crate) const MACOS_MINIMUM_MAJOR: i64 = 12;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CefAvailability {
    Available,
    UnsupportedMacOs {
        required_major: i64,
        actual_major: i64,
        actual_minor: i64,
        actual_patch: i64,
    },
    UnsupportedPlatform,
}

pub(crate) fn macos_version_is_supported(major: i64, _minor: i64, _patch: i64) -> bool {
    major >= MACOS_MINIMUM_MAJOR
}

#[cfg(target_os = "macos")]
pub(crate) fn detect() -> CefAvailability {
    use cef_objc2_foundation::NSProcessInfo;

    let version = NSProcessInfo::processInfo().operatingSystemVersion();
    if macos_version_is_supported(
        version.majorVersion as i64,
        version.minorVersion as i64,
        version.patchVersion as i64,
    ) {
        CefAvailability::Available
    } else {
        CefAvailability::UnsupportedMacOs {
            required_major: MACOS_MINIMUM_MAJOR,
            actual_major: version.majorVersion as i64,
            actual_minor: version.minorVersion as i64,
            actual_patch: version.patchVersion as i64,
        }
    }
}

#[cfg(windows)]
pub(crate) fn detect() -> CefAvailability {
    CefAvailability::Available
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(crate) fn detect() -> CefAvailability {
    CefAvailability::UnsupportedPlatform
}
