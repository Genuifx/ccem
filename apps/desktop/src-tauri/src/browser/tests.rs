use super::tools::build_eval_json_script;
use super::{
    browser_label_for_session_id, normalize_browser_session_id, sanitize_bounds, BrowserBounds,
    BROWSER_LABEL, DEFAULT_BROWSER_SESSION_ID,
};

#[test]
fn sanitize_bounds_keeps_browser_renderable() {
    let bounds = sanitize_bounds(BrowserBounds {
        x: -10.0,
        y: -4.0,
        width: 0.0,
        height: -1.0,
    });
    assert_eq!(bounds.x, 0.0);
    assert_eq!(bounds.y, 0.0);
    assert_eq!(bounds.width, 1.0);
    assert_eq!(bounds.height, 1.0);
}

#[test]
fn build_eval_json_script_runs_without_page_eval() {
    let script = build_eval_json_script(
        r#"
        (() => {
          window.scrollBy(0, 100);
          return { ok: true };
        })()
        "#,
    )
    .expect("script");
    assert!(!script.contains("eval("));
    assert!(script.contains("window.scrollBy"));
    assert!(script.contains("JSON.stringify"));
}

#[test]
fn browser_session_ids_default_to_workspace() {
    assert_eq!(
        normalize_browser_session_id(None),
        DEFAULT_BROWSER_SESSION_ID.to_string()
    );
    assert_eq!(
        normalize_browser_session_id(Some("  ")),
        DEFAULT_BROWSER_SESSION_ID.to_string()
    );
    assert_eq!(normalize_browser_session_id(Some("native-a")), "native-a");
}

#[test]
fn browser_labels_are_scoped_per_session() {
    assert_eq!(
        browser_label_for_session_id(DEFAULT_BROWSER_SESSION_ID, 7),
        format!("{BROWSER_LABEL}-g7")
    );
    let first = browser_label_for_session_id("native-a", 1);
    let second = browser_label_for_session_id("native-b", 1);
    assert!(first.starts_with(&format!("{BROWSER_LABEL}-")));
    assert!(second.starts_with(&format!("{BROWSER_LABEL}-")));
    assert_ne!(first, second);
    assert_ne!(first, browser_label_for_session_id("native-a", 2));
}
