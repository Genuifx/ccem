use super::*;
use crate::event_bus::SessionEventPayload;

fn wecom_request() -> BindSessionToBotRequest {
    BindSessionToBotRequest {
        runtime_id: "runtime-abcdef".to_string(),
        platform: RemotePlatform::Wecom,
        peer_id: " group-1 ".to_string(),
        thread_id: None,
        bot_id: Some(" webot ".to_string()),
        task_title: Some("Ship binding".to_string()),
        task_summary: Some("Productionize metadata".to_string()),
        send_task_card: true,
    }
}

fn test_binding_info() -> BotBindingInfo {
    let binding_id = "binding".to_string();
    let task_id = "ccem-task-runtime".to_string();
    BotBindingInfo {
        binding_id: binding_id.clone(),
        runtime_id: "runtime-1".to_string(),
        task_id: task_id.clone(),
        platform: RemotePlatform::Weixin,
        peer_id: "peer-1".to_string(),
        thread_id: None,
        bot_id: None,
        task_title: "Task".to_string(),
        task_summary: None,
        project_label: Some("claude-code-env-manager".to_string()),
        send_task_card: true,
        correlation_marker: build_correlation_marker(&binding_id, &task_id),
        task_card_message_id: None,
        delivery_status: BotBindingDeliveryStatus::BoundOnly,
        last_delivery_error: None,
        delivered_at: None,
        connected_at: Utc::now(),
    }
}

#[test]
fn stable_binding_id_uses_wecom_bot_id_as_thread_identity() {
    let request = BindSessionToBotRequest {
        runtime_id: "runtime-abcdef".to_string(),
        platform: RemotePlatform::Wecom,
        peer_id: "user_a".to_string(),
        thread_id: Some("thread_should_not_win".to_string()),
        bot_id: Some("bot_123".to_string()),
        task_title: None,
        task_summary: None,
        send_task_card: true,
    };

    assert_eq!(
        stable_binding_id(&request),
        "botbind-runtime-abcdef-wecom-user_a-bot_123"
    );
}

#[test]
fn binding_record_normalizes_wecom_target_and_adds_delivery_metadata() {
    let manager = BotBindingManager::default();
    let (info, created) = manager
        .ensure_binding_record(
            wecom_request(),
            "runtime-abcdef",
            Some("claude-code-env-manager".to_string()),
        )
        .expect("binding");

    assert!(created);
    assert_eq!(info.peer_id, "group-1");
    assert_eq!(info.bot_id.as_deref(), Some("webot"));
    assert_eq!(info.delivery_status, BotBindingDeliveryStatus::BoundOnly);
    assert_eq!(info.task_card_message_id, None);
    assert_eq!(info.last_delivery_error, None);
    assert_eq!(
        info.project_label.as_deref(),
        Some("claude-code-env-manager")
    );
    assert!(info
        .correlation_marker
        .starts_with("ccem-bot-binding:botbind-runtime-abcdef-wecom-group-1-webot:"));
}

#[test]
fn wecom_binding_requires_target_bot_id() {
    let manager = BotBindingManager::default();
    let mut request = wecom_request();
    request.bot_id = None;

    let error = manager
        .ensure_binding_record(
            request,
            "runtime-abcdef",
            Some("claude-code-env-manager".to_string()),
        )
        .expect_err("missing bot id should fail");

    assert_eq!(error, "bot_id is required for WeCom bot bindings");
}

#[test]
fn delivery_metadata_can_be_marked_delivered_or_failed() {
    let manager = BotBindingManager::default();
    let (info, _) = manager
        .ensure_binding_record(
            wecom_request(),
            "runtime-abcdef",
            Some("claude-code-env-manager".to_string()),
        )
        .expect("binding");

    let pending = manager
        .mark_task_card_delivery_pending(&info.binding_id)
        .expect("pending update");
    assert_eq!(pending.delivery_status, BotBindingDeliveryStatus::Pending);

    let delivered = manager
        .mark_task_card_delivered(&info.binding_id, "msg-123")
        .expect("delivery update");
    assert_eq!(
        delivered.delivery_status,
        BotBindingDeliveryStatus::Delivered
    );
    assert_eq!(delivered.task_card_message_id.as_deref(), Some("msg-123"));
    assert_eq!(delivered.last_delivery_error, None);
    assert!(delivered.delivered_at.is_some());

    let failed = manager
        .mark_task_card_delivery_failed(&info.binding_id, "socket disconnected")
        .expect("failure update");
    assert_eq!(failed.delivery_status, BotBindingDeliveryStatus::Failed);
    assert_eq!(
        failed.last_delivery_error.as_deref(),
        Some("socket disconnected")
    );
}

#[test]
fn persisted_binding_state_restores_delivery_route_metadata() {
    let path = std::env::temp_dir().join(format!(
        "ccem-bot-binding-test-{}-{}.json",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let _ = std::fs::remove_file(&path);

    let info = {
        let manager = BotBindingManager::with_storage_path_for_test(path.clone());
        let (info, _) = manager
            .ensure_binding_record(
                wecom_request(),
                "runtime-abcdef",
                Some("claude-code-env-manager".to_string()),
            )
            .expect("binding");
        manager
            .mark_task_card_delivered(&info.binding_id, "msg-123")
            .expect("delivery update")
    };

    let restored = BotBindingManager::with_storage_path_for_test(path.clone());
    let restored_info = restored
        .find_binding_for_route(
            RemotePlatform::Wecom,
            Some("webot"),
            "group-1",
            Some(&info.task_id),
            None,
        )
        .expect("restored route");

    assert_eq!(restored_info.binding_id, info.binding_id);
    assert_eq!(
        restored_info.delivery_status,
        BotBindingDeliveryStatus::Delivered
    );
    assert_eq!(
        restored_info.task_card_message_id.as_deref(),
        Some("msg-123")
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn native_relay_claim_dedupes_and_can_be_released_after_restart() {
    let manager = BotBindingManager::default();

    assert!(manager.claim_native_relay("binding-1"));
    assert!(!manager.claim_native_relay("binding-1"));
    manager.release_native_relay("binding-1");
    assert!(manager.claim_native_relay("binding-1"));
}

#[test]
fn route_lookup_matches_quoted_task_or_correlation_marker() {
    let manager = BotBindingManager::default();
    let (info, _) = manager
        .ensure_binding_record(
            wecom_request(),
            "runtime-abcdef",
            Some("claude-code-env-manager".to_string()),
        )
        .expect("binding");
    manager
        .mark_task_card_delivered(&info.binding_id, "msg-123")
        .expect("delivery update");

    let by_task = manager
        .find_binding_for_route(
            RemotePlatform::Wecom,
            Some("webot"),
            "group-1",
            Some(&info.task_id),
            None,
        )
        .expect("route by task id");
    assert_eq!(by_task.binding_id, info.binding_id);

    let by_marker = manager
        .find_binding_for_route(
            RemotePlatform::Wecom,
            Some("webot"),
            "group-1",
            None,
            Some(&info.correlation_marker),
        )
        .expect("route by correlation marker");
    assert_eq!(by_marker.binding_id, info.binding_id);

    let by_message_id = manager
        .find_binding_for_route(
            RemotePlatform::Wecom,
            Some("webot"),
            "group:group-1",
            None,
            Some("msg-123"),
        )
        .expect("route by delivered message id");
    assert_eq!(by_message_id.binding_id, info.binding_id);

    let route_id = bot_binding_route_id(&info);
    let by_route_id = manager
        .find_binding_for_route(
            RemotePlatform::Wecom,
            Some("webot"),
            "group-1",
            None,
            Some(&format!("#{route_id}")),
        )
        .expect("route by short id");
    assert_eq!(by_route_id.binding_id, info.binding_id);

    let by_route_prefix = manager
        .find_binding_for_route(
            RemotePlatform::Wecom,
            Some("webot"),
            "group-1",
            None,
            Some(&format!("ccem:{route_id}")),
        )
        .expect("route by ccem short id");
    assert_eq!(by_route_prefix.binding_id, info.binding_id);

    assert!(manager
        .find_binding_for_route(
            RemotePlatform::Wecom,
            Some("other-bot"),
            "group-1",
            Some(&info.task_id),
            None,
        )
        .is_none());
}

#[test]
fn assistant_chunks_become_event_updates() {
    let summary = formatting::summarize_payload(&SessionEventPayload::AssistantChunk {
        text: "working".to_string(),
    })
    .expect("summary");

    assert_eq!(summary.kind, BotBindingOutboxFrameKind::EventUpdate);
    assert_eq!(summary.title, "Assistant update");
    assert_eq!(summary.text, "working");
}

#[test]
fn inbound_prompt_carries_quoted_task_context() {
    let info = test_binding_info();

    let prompt = format_inbound_prompt(&info, "continue", Some("quoted-task"));
    assert!(prompt.contains("route_id: "));
    assert!(prompt.contains("quoted_task_id: quoted-task"));
    assert!(prompt.contains("correlation_marker: ccem-bot-binding:binding:ccem-task-runtime"));
    assert!(prompt.contains("continue"));
}

#[test]
fn task_card_exposes_short_route_id_without_internal_markers() {
    let info = test_binding_info();
    let card = formatting::format_task_card(&info);
    let route_id = bot_binding_route_id(&info);

    assert!(card.contains(&format!("id: {route_id}")));
    assert!(card.contains("project: claude-code-env-manager"));
    assert!(!card.contains("runtime_id:"));
    assert!(!card.contains("task_id:"));
    assert!(!card.contains("correlation_marker:"));
}

#[test]
fn permission_preview_exposes_controls_and_lookalike_quotes() {
    let hostile = "printf \u{201c}safe\u{201d}\u{202e} ; rm\u{200b} -rf /tmp/demo\u{feff}";

    assert_eq!(
        crate::permission_preview::format_permission_preview(hostile, 1_000),
        "printf \\u{201C}safe\\u{201D}\\u{202E} ; rm\\u{200B} -rf /tmp/demo\\u{FEFF}"
    );
    assert_eq!(
        crate::permission_preview::format_permission_preview(
            "echo \"中文内容\" && cat /tmp/CCEM",
            1_000
        ),
        "echo \"中文内容\" && cat /tmp/CCEM"
    );
    assert_eq!(
        crate::permission_preview::format_permission_preview(
            &crate::permission_preview::format_permission_preview("x\u{202e}y", 1_000),
            1_000
        ),
        crate::permission_preview::format_permission_preview("x\u{202e}y", 1_000)
    );
    assert_eq!(
        crate::permission_preview::format_permission_preview(
            "\u{206a}\u{fe0f}\u{e0100}\u{115f}\u{1160}\u{3164}\u{ffa0}\u{275b}\u{301d}",
            1_000
        ),
        "\\u{206A}\\u{FE0F}\\u{E0100}\\u{115F}\\u{1160}\\u{3164}\\u{FFA0}\\u{275B}\\u{301D}"
    );
}

#[test]
fn permission_prompt_sanitizes_only_its_display_copy() {
    let payload = SessionEventPayload::PermissionRequired {
        request_id: "req-original-1".to_string(),
        tool_use_id: Some("tool-original-1".to_string()),
        tool_name: "Bash\u{202e}".to_string(),
        input_summary: Some("printf \u{201c}safe\u{201d}\u{200b}".to_string()),
    };
    let original = payload.clone();

    let summary = formatting::summarize_payload(&payload).expect("permission summary");

    assert_eq!(summary.kind, BotBindingOutboxFrameKind::PermissionPrompt);
    assert_eq!(summary.title, "Permission required · Bash\\u{202E}");
    assert_eq!(
        summary.text,
        "request_id: req-original-1\nprintf \\u{201C}safe\\u{201D}\\u{200B}"
    );
    assert_eq!(payload, original);
}

#[test]
fn permission_prompt_does_not_split_a_visible_escape_at_its_limit() {
    let payload = SessionEventPayload::PermissionRequired {
        request_id: "req-boundary".to_string(),
        tool_use_id: Some("tool-boundary".to_string()),
        tool_name: "Bash".to_string(),
        input_summary: Some(format!("{}\u{202e}tail", "a".repeat(1177))),
    };

    let summary = formatting::summarize_payload(&payload).expect("permission summary");

    assert!(summary.text.ends_with('…'));
    assert!(!summary.text.ends_with("\\u{202E..."));
    assert!(!summary.text.ends_with("\\u{202E}..."));
    assert!(summary.text.chars().count() <= 1200);
}
