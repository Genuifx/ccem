use super::*;
use crate::browser::BrowserToolRequest;
use crate::native_runtime::{resolve_browser_actor_id, BrowserActorLineageRef, NativeProvider};

#[test]
fn resumed_provider_conversation_reuses_provisional_actor_taint_across_native_runtimes() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open");
    let authorize = |action| {
        TrustedUiControlAuthorization::from_trusted_ui(
            &opened.handle,
            action,
            Duration::from_secs(30),
        )
        .unwrap()
    };
    fixture
        .manager
        .handoff_to_agent(authorize(TrustedUiControlAction::HandoffToAgent))
        .expect("first handoff");

    let raw_provider_session_id = "provider-session-raw-must-not-enter-audit";
    let provisional_a = "browser-actor-11111111111111111111111111111111";
    let actor_a = resolve_browser_actor_id(NativeProvider::Claude, None, provisional_a, &[])
        .expect("provisional lineage");
    let actor_b = resolve_browser_actor_id(
        NativeProvider::Claude,
        Some(raw_provider_session_id),
        "browser-actor-22222222222222222222222222222222",
        &[BrowserActorLineageRef {
            provider: NativeProvider::Claude,
            provider_session_id: Some(raw_provider_session_id),
            actor_id: &actor_a,
        }],
    )
    .expect("resumed lineage");
    assert_eq!(
        actor_b, actor_a,
        "resume must reuse the provisional lineage"
    );

    let workspace = fixture.workspace_a.to_string_lossy();
    fixture
        .manager
        .run_agent_tool_if_handed_off(
            &workspace,
            &actor_a,
            "yolo",
            &BrowserToolRequest {
                request_id: "runtime-a-read-origin-a".to_string(),
                tool: "get_url".to_string(),
                args: serde_json::json!({}),
            },
        )
        .expect("runtime A reads origin A")
        .expect("mode 2 selected");

    fixture
        .manager
        .pause_agent(authorize(TrustedUiControlAction::PauseAgent))
        .expect("pause");
    fixture.state.lock().unwrap().current_url = "https://b.example/form".to_string();
    fixture
        .manager
        .handoff_to_agent(authorize(TrustedUiControlAction::HandoffToAgent))
        .expect("origin B handoff");

    let error = fixture
        .manager
        .run_agent_tool_if_handed_off(
            &workspace,
            &actor_b,
            "yolo",
            &BrowserToolRequest {
                request_id: "runtime-b-write-origin-b".to_string(),
                tool: "click".to_string(),
                args: serde_json::json!({"elementRef":"el-submit"}),
            },
        )
        .expect_err("runtime B must retain runtime A's origin-A taint");
    assert!(error.contains("cross_origin_write_blocked"));

    let audit = fs::read_to_string(
        fixture
            .session_root
            .join("sessions")
            .join(&opened.snapshot.session_id)
            .join("audit/actions.jsonl"),
    )
    .expect("audit");
    assert!(!audit.contains(raw_provider_session_id));
    assert!(audit.contains(&actor_a));
    fixture.manager.close(&opened.handle).unwrap();
}

#[test]
fn agent_provenance_is_monotonic_across_sessions_and_handoffs_with_audited_denials() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open");
    let authorize = |action| {
        TrustedUiControlAuthorization::from_trusted_ui(
            &opened.handle,
            action,
            Duration::from_secs(30),
        )
        .unwrap()
    };
    fixture
        .manager
        .handoff_to_agent(authorize(TrustedUiControlAction::HandoffToAgent))
        .expect("first handoff");
    let workspace = fixture.workspace_a.to_string_lossy();
    let request = |request_id: &str, tool: &str, args: serde_json::Value| BrowserToolRequest {
        request_id: request_id.to_string(),
        tool: tool.to_string(),
        args,
    };

    fixture
        .manager
        .run_agent_tool_if_handed_off(
            &workspace,
            "actor-a",
            "yolo",
            &request("read-a", "get_url", serde_json::json!({})),
        )
        .expect("read origin a")
        .expect("mode 2 selected");
    assert_eq!(fixture.state.lock().unwrap().semantic_effect_count, 1);
    assert!(fixture
        .session_root
        .join("provenance/provenance.json")
        .is_file());

    fixture
        .manager
        .pause_agent(authorize(TrustedUiControlAction::PauseAgent))
        .expect("pause");
    fixture.state.lock().unwrap().current_url = "https://b.example/form".to_string();
    fixture
        .manager
        .handoff_to_agent(authorize(TrustedUiControlAction::HandoffToAgent))
        .expect("second-origin handoff");

    let cross = fixture
        .manager
        .run_agent_tool_if_handed_off(
            &workspace,
            "actor-a",
            "yolo",
            &request(
                "write-cross",
                "click",
                serde_json::json!({"elementRef":"el-submit"}),
            ),
        )
        .expect_err("cross-origin taint must deny");
    assert!(cross.contains("cross_origin_write_blocked"));
    assert_eq!(fixture.state.lock().unwrap().semantic_effect_count, 1);

    fixture
        .manager
        .run_agent_tool_if_handed_off(
            &workspace,
            "actor-a",
            "yolo",
            &request("read-b", "get_url", serde_json::json!({})),
        )
        .expect("read origin b")
        .expect("mode 2 selected");
    let mixed = fixture
        .manager
        .run_agent_tool_if_handed_off(
            &workspace,
            "actor-a",
            "yolo",
            &request(
                "write-mixed",
                "click",
                serde_json::json!({"elementRef":"el-submit"}),
            ),
        )
        .expect_err("mixed provenance must deny");
    assert!(mixed.contains("mixed_provenance_write_blocked"));
    assert_eq!(fixture.state.lock().unwrap().semantic_effect_count, 2);

    fixture
        .manager
        .run_agent_tool_if_handed_off(
            &workspace,
            "actor-b",
            "yolo",
            &request(
                "write-other-actor",
                "click",
                serde_json::json!({"elementRef":"el-submit"}),
            ),
        )
        .expect("actor isolation")
        .expect("mode 2 selected");
    assert_eq!(fixture.state.lock().unwrap().semantic_effect_count, 3);

    let audit_path = fixture
        .session_root
        .join("sessions")
        .join(&opened.snapshot.session_id)
        .join("audit/actions.jsonl");
    let audit = fs::read_to_string(audit_path).expect("durable decision audit");
    assert!(audit.contains("cross_origin_write_blocked"));
    assert!(audit.contains("mixed_provenance_write_blocked"));
    fixture.manager.close(&opened.handle).unwrap();

    let reopened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open second session");
    fixture
        .manager
        .handoff_to_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &reopened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .expect("second-session handoff");
    let persisted = fixture
        .manager
        .run_agent_tool_if_handed_off(
            &workspace,
            "actor-a",
            "yolo",
            &request(
                "write-second-session",
                "click",
                serde_json::json!({"elementRef":"el-submit"}),
            ),
        )
        .expect_err("mixed provenance must survive session close");
    assert!(persisted.contains("mixed_provenance_write_blocked"));
    assert_eq!(fixture.state.lock().unwrap().semantic_effect_count, 3);
    let second_audit = fs::read_to_string(
        fixture
            .session_root
            .join("sessions")
            .join(&reopened.snapshot.session_id)
            .join("audit/actions.jsonl"),
    )
    .expect("second-session durable audit");
    assert!(second_audit.contains("mixed_provenance_write_blocked"));
    fixture.manager.close(&reopened.handle).unwrap();
}

#[test]
fn successful_page_data_is_not_returned_when_provenance_persistence_fails() {
    let fixture = Fixture::new();
    let opened = fixture
        .manager
        .open_default_profile(Fixture::trusted(&fixture.workspace_a))
        .expect("open");
    fixture
        .manager
        .handoff_to_agent(
            TrustedUiControlAuthorization::from_trusted_ui(
                &opened.handle,
                TrustedUiControlAction::HandoffToAgent,
                Duration::from_secs(30),
            )
            .unwrap(),
        )
        .expect("handoff");
    fs::write(
        fixture.session_root.join("provenance/provenance.json"),
        b"{}",
    )
    .expect("corrupt provenance fixture");
    let error = fixture
        .manager
        .run_agent_tool_if_handed_off(
            &fixture.workspace_a.to_string_lossy(),
            "actor-page-read",
            "yolo",
            &BrowserToolRequest {
                request_id: "read-with-corrupt-ledger".to_string(),
                tool: "get_url".to_string(),
                args: serde_json::json!({}),
            },
        )
        .expect_err("page data must not escape without durable provenance");
    assert_eq!(error, "Login Browser provenance state is unavailable.");
    assert_eq!(
        fixture.state.lock().unwrap().semantic_effect_count,
        1,
        "the backend completed, but its page-derived result was withheld"
    );
    fixture.manager.close(&opened.handle).unwrap();
}
