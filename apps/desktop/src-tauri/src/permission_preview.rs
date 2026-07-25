const DEFAULT_IGNORABLE_RANGES: &[(u32, u32)] = &[
    (0x00ad, 0x00ad),
    (0x034f, 0x034f),
    (0x061c, 0x061c),
    (0x115f, 0x1160),
    (0x17b4, 0x17b5),
    (0x180b, 0x180f),
    (0x200b, 0x200f),
    (0x202a, 0x202e),
    (0x2060, 0x206f),
    (0x3164, 0x3164),
    (0xfe00, 0xfe0f),
    (0xfeff, 0xfeff),
    (0xffa0, 0xffa0),
    (0xfff0, 0xfff8),
    (0x1bca0, 0x1bca3),
    (0x1d173, 0x1d17a),
    (0xe0000, 0xe0fff),
];

const LOOKALIKE_QUOTE_RANGES: &[(u32, u32)] = &[
    (0x02b9, 0x02bd),
    (0x02cb, 0x02cb),
    (0x2018, 0x201f),
    (0x2032, 0x2037),
    (0x275b, 0x275e),
    (0x301d, 0x301f),
    (0xff02, 0xff02),
    (0xff07, 0xff07),
    (0xff40, 0xff40),
];

fn belongs_to_range(code_point: u32, ranges: &[(u32, u32)]) -> bool {
    ranges
        .iter()
        .any(|(start, end)| (*start..=*end).contains(&code_point))
}

fn should_expose_permission_code_point(code_point: u32) -> bool {
    belongs_to_range(code_point, DEFAULT_IGNORABLE_RANGES)
        || (0x0000..=0x001f).contains(&code_point)
        || (0x007f..=0x009f).contains(&code_point)
        || (0x2028..=0x2029).contains(&code_point)
        || (0xfff9..=0xfffb).contains(&code_point)
        || belongs_to_range(code_point, LOOKALIKE_QUOTE_RANGES)
}

pub(crate) fn format_permission_preview(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }

    let mut tokens = Vec::new();
    let mut display_chars = 0usize;

    for character in text.chars() {
        let code_point = character as u32;
        let token = if should_expose_permission_code_point(code_point) {
            format!("\\u{{{code_point:04X}}}")
        } else {
            character.to_string()
        };
        let token_chars = token.chars().count();
        if display_chars + token_chars <= max_chars {
            display_chars += token_chars;
            tokens.push(token);
            continue;
        }

        if max_chars == 1 {
            return "…".to_string();
        }

        let available_chars = max_chars - 1;
        while display_chars > available_chars {
            if let Some(removed) = tokens.pop() {
                display_chars = display_chars.saturating_sub(removed.chars().count());
            } else {
                break;
            }
        }
        return format!("{}…", tokens.concat());
    }

    tokens.concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_every_default_ignorable_range_boundary() {
        for (start, end) in DEFAULT_IGNORABLE_RANGES {
            for code_point in [*start, *end] {
                let character = char::from_u32(code_point).expect("valid Unicode scalar");
                assert_eq!(
                    format_permission_preview(&character.to_string(), 32),
                    format!("\\u{{{code_point:04X}}}"),
                    "code point U+{code_point:04X} must be visible"
                );
            }
        }
    }

    #[test]
    fn keeps_escape_markers_atomic_at_the_limit() {
        assert_eq!(
            format_permission_preview("ab\u{202e}cd", 11),
            "ab\\u{202E}…"
        );
        assert_eq!(format_permission_preview("abc😀def", 5), "abc😀…");
    }

    #[test]
    fn exposes_line_and_message_structure_controls() {
        assert_eq!(
            format_permission_preview("req\n\r\t\u{0085}\u{2028}\u{2029}id", 200),
            "req\\u{000A}\\u{000D}\\u{0009}\\u{0085}\\u{2028}\\u{2029}id"
        );
    }

    #[test]
    fn preserves_ordinary_text_without_normalization() {
        assert_eq!(
            format_permission_preview("echo \"中文内容\" && cat /tmp/CCEM", 200),
            "echo \"中文内容\" && cat /tmp/CCEM"
        );
        assert_eq!(format_permission_preview("e\u{0301}", 20), "e\u{0301}");
    }
}
