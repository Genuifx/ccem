use super::tools::build_eval_json_script;
use super::{
    browser_label_for_session_id, normalize_browser_session_id, sanitize_bounds, BrowserBounds,
    BrowserManager, BROWSER_LABEL, DEFAULT_BROWSER_SESSION_ID,
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

#[test]
fn preview_runtime_alias_is_fenced_to_one_physical_generation() {
    let browser = BrowserManager::default();
    let first = browser
        .registry
        .snapshot_or_create("physical:1", |generation| {
            browser_label_for_session_id("physical:1", generation)
        })
        .expect("create physical preview session");
    let first_binding = browser
        .bind_preview_alias("runtime-a", "physical:1")
        .expect("bind runtime alias");
    assert_eq!(
        browser
            .resolve_preview_session_id("runtime-a")
            .expect("resolve first binding"),
        "physical:1"
    );

    browser
        .registry
        .remove("physical:1")
        .expect("remove first generation");
    let reopened = browser
        .registry
        .snapshot_or_create("physical:1", |generation| {
            browser_label_for_session_id("physical:1", generation)
        })
        .expect("reopen physical preview session");
    assert!(reopened.generation > first.generation);
    assert_eq!(
        browser
            .resolve_preview_session_id("runtime-a")
            .expect("stale alias falls back to its requested id"),
        "runtime-a"
    );

    let reopened_binding = browser
        .bind_preview_alias("runtime-a", "physical:1")
        .expect("bind reopened generation");
    browser
        .unbind_preview_alias("runtime-a", first_binding.binding_id)
        .expect("late cleanup is a no-op");
    assert_ne!(first_binding.binding_id, reopened_binding.binding_id);
    assert_eq!(
        browser
            .resolve_preview_session_id("runtime-a")
            .expect("new binding survives old cleanup"),
        "physical:1"
    );
}

#[test]
fn stale_agent_route_cannot_cross_explicit_close_and_reopen() {
    let browser = BrowserManager::default();
    let first = browser
        .registry
        .snapshot_or_create("physical:1", |generation| {
            browser_label_for_session_id("physical:1", generation)
        })
        .expect("create first physical generation");
    let first_binding = browser
        .bind_preview_alias("runtime-a", "physical:1")
        .expect("bind first physical generation");
    let mut stale_route = browser
        .capture_preview_route_locked("runtime-a")
        .expect("capture frozen Agent route");
    assert_eq!(stale_route.adopted, Some(first_binding));
    let (_, stale_operation) = browser
        .registry
        .begin_agent_action_expected_generation("physical:1", first.generation, "wait_for")
        .expect("begin first-generation operation");

    browser
        .registry
        .remove("physical:1")
        .expect("explicit close removes first generation");
    browser
        .aliases
        .remove_session("physical:1", first.generation)
        .expect("explicit close retires first binding");
    assert!(browser
        .preview_route_session_locked(&mut stale_route)
        .expect_err("a closed frozen route must not recreate its session")
        .contains("instance changed"));
    assert!(browser
        .registry
        .snapshot("physical:1")
        .expect("snapshot after stale route")
        .is_none());

    let reopened = browser
        .registry
        .snapshot_or_create("physical:1", |generation| {
            browser_label_for_session_id("physical:1", generation)
        })
        .expect("reopen the same physical id");
    assert!(reopened.generation > first.generation);
    let reopened_binding = browser
        .bind_preview_alias("runtime-a", "physical:1")
        .expect("bind reopened generation");
    assert_ne!(
        stale_route
            .adopted
            .as_ref()
            .expect("route remains frozen")
            .binding_id,
        reopened_binding.binding_id,
    );
    assert!(browser
        .resolve_preview_route_locked(&mut stale_route)
        .expect_err("old request cannot adopt reopened binding")
        .contains("instance changed"));
    assert!(browser
        .registry
        .validate_operation(&stale_operation)
        .is_err());
    assert!(browser
        .registry
        .begin_agent_action_expected_generation("physical:1", first.generation, "click",)
        .expect_err("old generation cannot begin on reopened physical id")
        .contains("instance changed"));
    assert_eq!(
        browser
            .resolve_preview_session_id("runtime-a")
            .expect("new requests use reopened generation"),
        "physical:1"
    );
}

#[test]
fn alias_rebind_cancels_work_on_the_previous_physical_instance() {
    let browser = BrowserManager::default();
    let first = browser
        .registry
        .snapshot_or_create("physical:1", |generation| {
            browser_label_for_session_id("physical:1", generation)
        })
        .expect("create first physical instance");
    browser
        .registry
        .snapshot_or_create("physical:2", |generation| {
            browser_label_for_session_id("physical:2", generation)
        })
        .expect("create second physical instance");
    browser
        .bind_preview_alias("runtime-a", "physical:1")
        .expect("bind first instance");
    let captured_cancel_epoch = first.cancel_epoch;
    let (_, old_operation) = browser
        .registry
        .begin_agent_action_expected_generation("physical:1", first.generation, "wait_for")
        .expect("begin work on first instance");

    browser
        .bind_preview_alias("runtime-a", "physical:2")
        .expect("rebind runtime to second instance");

    assert!(browser.registry.validate_operation(&old_operation).is_err());
    assert!(browser
        .registry
        .begin_agent_action_expected_route(
            "physical:1",
            first.generation,
            captured_cancel_epoch,
            "click",
        )
        .expect_err("rebind between route validation and begin cancels the old request")
        .contains("route changed"));
    assert_eq!(
        browser
            .resolve_preview_session_id("runtime-a")
            .expect("new requests resolve to second instance"),
        "physical:2"
    );
}

#[test]
fn agent_first_route_rejects_a_reopen_when_the_first_binding_was_missed() {
    let browser = BrowserManager::default();
    let provisional = browser
        .registry
        .snapshot_or_create("runtime-a", |generation| {
            browser_label_for_session_id("runtime-a", generation)
        })
        .expect("create Agent-first provisional generation");
    let mut waiting_route = browser
        .capture_preview_route_locked("runtime-a")
        .expect("capture route before any UI binding");
    waiting_route.provisional = Some((provisional.session_id.clone(), provisional.generation));

    let first = browser
        .registry
        .snapshot_or_create("physical:1", |generation| {
            browser_label_for_session_id("physical:1", generation)
        })
        .expect("open first UI instance");
    browser
        .bind_preview_alias("runtime-a", "physical:1")
        .expect("bind first UI instance between Agent polls");
    browser
        .registry
        .remove("physical:1")
        .expect("close first UI instance before the next Agent poll");
    browser
        .aliases
        .remove_session("physical:1", first.generation)
        .expect("retire the unseen first binding");

    browser
        .registry
        .snapshot_or_create("physical:2", |generation| {
            browser_label_for_session_id("physical:2", generation)
        })
        .expect("reopen a later UI instance");
    browser
        .bind_preview_alias("runtime-a", "physical:2")
        .expect("bind later reopened instance");

    assert!(browser
        .resolve_preview_route_locked(&mut waiting_route)
        .expect_err("old Agent request must not adopt a later reopened instance")
        .contains("instance changed"));
}

#[test]
fn agent_first_route_adopts_exactly_the_first_binding_once() {
    let browser = BrowserManager::default();
    let provisional = browser
        .registry
        .snapshot_or_create("runtime-a", |generation| {
            browser_label_for_session_id("runtime-a", generation)
        })
        .expect("create Agent-first provisional generation");
    let mut waiting_route = browser
        .capture_preview_route_locked("runtime-a")
        .expect("capture route before the UI opens");
    waiting_route.provisional = Some((provisional.session_id.clone(), provisional.generation));

    browser
        .registry
        .snapshot_or_create("physical:1", |generation| {
            browser_label_for_session_id("physical:1", generation)
        })
        .expect("open first UI instance");
    let first_binding = browser
        .bind_preview_alias("runtime-a", "physical:1")
        .expect("bind first UI instance");

    assert_eq!(
        browser
            .resolve_preview_route_locked(&mut waiting_route)
            .expect("adopt first binding"),
        "physical:1"
    );
    assert_eq!(waiting_route.adopted, Some(first_binding.clone()));

    let idempotent_binding = browser
        .bind_preview_alias("runtime-a", "physical:1")
        .expect("repeat UI binding");
    assert_eq!(idempotent_binding, first_binding);
    assert_eq!(
        browser
            .resolve_preview_route_locked(&mut waiting_route)
            .expect("idempotent bind keeps adopted route valid"),
        "physical:1"
    );
}

#[test]
fn retiring_runtime_agent_control_preserves_the_physical_browser() {
    let browser = BrowserManager::default();
    let physical = browser
        .registry
        .snapshot_or_create("physical:1", |generation| {
            browser_label_for_session_id("physical:1", generation)
        })
        .expect("create physical browser");
    browser
        .registry
        .mark_navigation("physical:1", "https://example.test/".to_string())
        .expect("record browser URL");
    browser
        .registry
        .mark_ready("physical:1")
        .expect("mark browser ready");
    browser
        .registry
        .set_visible("physical:1", true)
        .expect("keep browser visible");
    browser
        .bind_preview_alias("runtime-a", "physical:1")
        .expect("bind runtime alias");
    let (_, operation) = browser
        .registry
        .begin_agent_action_expected_route(
            "physical:1",
            physical.generation,
            physical.cancel_epoch,
            "wait_for",
        )
        .expect("begin in-flight Agent action");

    let retired = browser
        .retire_agent_control_state("runtime-a")
        .expect("retire runtime Agent control")
        .expect("bound physical browser remains registered");

    assert_eq!(retired.session_id, "physical:1");
    assert_eq!(retired.generation, physical.generation);
    assert_eq!(
        retired.current_url.as_deref(),
        Some("https://example.test/")
    );
    assert!(retired.visible);
    assert!(retired.paused);
    assert_eq!(retired.cancel_epoch, operation.cancel_epoch + 1);
    assert!(browser.registry.validate_operation(&operation).is_err());
    assert!(browser
        .registry
        .begin_agent_action("physical:1", "click")
        .expect_err("retired runtime cannot start more Agent work")
        .contains("paused"));
    assert!(browser
        .registry
        .snapshot("physical:1")
        .expect("read retained physical browser")
        .is_some());
}
