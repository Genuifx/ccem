use super::tests::test_engine;
use super::*;

#[test]
fn only_the_primary_frame_current_loader_lifecycle_completes_a_load() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(&temp);
    engine.primary_session = Some("primary".to_string());
    engine.configured_sessions.insert("secondary".to_string());
    engine.pending_sessions.push_back("secondary".to_string());
    let (_sender, inbox, _state) = super::super::transport::frame_channel();
    let mut output = Vec::new();
    let mut client = CdpClient::new(&mut output, inbox);

    engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::FrameNavigated,
                params: serde_json::json!({"frame": {
                    "id": "main-frame",
                    "loaderId": "loader-current",
                    "url": "https://allowed.example/current"
                }}),
                session_id: Some("primary".to_string()),
            },
        )
        .unwrap();
    assert_eq!(engine.load_generation, 0);
    for (session_id, frame_id, loader_id) in [
        ("popup", "main-frame", "loader-current"),
        ("primary", "child-frame", "loader-current"),
        ("primary", "main-frame", "loader-stale"),
    ] {
        engine
            .on_event(
                &mut client,
                CdpEvent {
                    kind: CdpEventKind::LifecycleEvent,
                    params: serde_json::json!({
                        "frameId": frame_id,
                        "loaderId": loader_id,
                        "name": "load"
                    }),
                    session_id: Some(session_id.to_string()),
                },
            )
            .unwrap();
    }
    // The legacy load event has no frame/loader identity and therefore cannot authorize a
    // completion for the document currently owned by the Agent.
    engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::LoadEventFired,
                params: serde_json::json!({}),
                session_id: Some("primary".to_string()),
            },
        )
        .unwrap();
    assert_eq!(engine.load_generation, 0);
    engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::LifecycleEvent,
                params: serde_json::json!({
                    "frameId": "main-frame",
                    "loaderId": "loader-current",
                    "name": "load"
                }),
                session_id: Some("primary".to_string()),
            },
        )
        .unwrap();
    assert_eq!(engine.load_generation, 1);

    // Duplicate lifecycle delivery is idempotent for the same committed loader.
    engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::LifecycleEvent,
                params: serde_json::json!({
                    "frameId": "main-frame",
                    "loaderId": "loader-current",
                    "name": "load"
                }),
                session_id: Some("primary".to_string()),
            },
        )
        .unwrap();
    assert_eq!(engine.load_generation, 1);

    engine
        .on_event(
            &mut client,
            CdpEvent {
                kind: CdpEventKind::TargetDetached,
                params: serde_json::json!({"sessionId":"secondary"}),
                session_id: None,
            },
        )
        .unwrap();
    assert!(!engine.configured_sessions.contains("secondary"));
    assert!(!engine
        .pending_sessions
        .iter()
        .any(|value| value == "secondary"));
}

#[test]
fn navigation_or_target_generation_invalidates_old_element_refs() {
    let mut registry = ElementRegistry::new();
    let backend_node_id = u64::MAX;
    let reference = registry.insert(backend_node_id).unwrap();
    assert_eq!(registry.resolve(&reference).unwrap(), backend_node_id);
    registry.invalidate();
    assert_eq!(
        registry.resolve(&reference).unwrap_err().code,
        BackendFailureCode::InvalidSemanticReference
    );
    assert!(!reference.contains(&backend_node_id.to_string()));
}

#[test]
fn box_model_center_uses_only_numeric_dom_geometry() {
    assert_eq!(
        box_center(&serde_json::json!({
            "model": {"content": [0, 0, 10, 0, 10, 20, 0, 20]}
        })),
        Some((5.0, 10.0))
    );
    assert!(box_center(&serde_json::json!({"model":{"content":[0]}})).is_none());
}

#[test]
fn document_interception_distinguishes_redirect_popup_and_iframe() {
    assert_eq!(
        classify_document_surface(Some("primary"), Some("primary"), Some("main"), Some("main")),
        TrustedNavigationSurface::Redirect
    );
    assert_eq!(
        classify_document_surface(Some("popup"), Some("primary"), Some("main"), Some("main")),
        TrustedNavigationSurface::Popup
    );
    assert_eq!(
        classify_document_surface(
            Some("primary"),
            Some("primary"),
            Some("child"),
            Some("main")
        ),
        TrustedNavigationSurface::Iframe
    );
}
