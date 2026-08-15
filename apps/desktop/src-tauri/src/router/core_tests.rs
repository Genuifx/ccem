use super::*;
use crate::router::types::{
    LaunchAuthKind, LaunchTransport, RouterAuthCapability, RouterProfile, SessionRouterRecord,
};

fn record() -> SessionRouterRecord {
    SessionRouterRecord {
        session_key: "key".into(),
        route_tag_nonce: "nonce".into(),
        default_env: "official".into(),
        bindings: HashMap::from([
            ("subagent:Explore".into(), "glm".into()),
            ("subagent:*".into(), "deepseek".into()),
            ("background".into(), "glm".into()),
        ]),
        allowed_envs: vec!["official".into(), "glm".into(), "deepseek".into()],
        source_profile_id: None,
        profile_revision: None,
        dynamic_routing: true,
        revision: 0,
        router_auth_capability: RouterAuthCapability::Oauth,
        launch_transport: LaunchTransport::Routed,
        launch_auth_kind: LaunchAuthKind::Oauth,
        launch_default_env: "official".into(),
        launch_model_pins: RouterModelPins::default(),
        warnings: Vec::new(),
    }
}

#[test]
fn router_rejects_non_post_before_body_or_auth_processing() {
    let headers = HashMap::from([("authorization".into(), "Bearer must-not-forward".into())]);
    let error = prepare_router_request(
        "runtime",
        &record(),
        "GET",
        "/v1/messages",
        None,
        &headers,
        b"not-json-and-must-not-forward",
        true,
    )
    .expect_err("router must not act as a generic authenticated GET proxy");

    assert_eq!(error.status, 405);
    assert_eq!(error.code, "ROUTER_METHOD_NOT_ALLOWED");
    assert!(!error.message.contains("must-not-forward"));
}

#[test]
fn router_rejects_non_anthropic_endpoint_without_forwarding_raw_body() {
    let headers = HashMap::from([("authorization".into(), "Bearer must-not-forward".into())]);
    let error = prepare_router_request(
        "runtime",
        &record(),
        "POST",
        "/v1/complete",
        None,
        &headers,
        b"raw-body-must-not-forward",
        true,
    )
    .expect_err("router must allow only the two Anthropic JSON endpoints");

    assert_eq!(error.status, 404);
    assert_eq!(error.code, "ROUTER_ENDPOINT_NOT_ALLOWED");
    assert!(!error.message.contains("must-not-forward"));
}

#[test]
fn router_endpoint_allowlist_preserves_trailing_slash_semantics() {
    assert!(validate_anthropic_request("POST", "/v1/messages/").is_ok());
    assert!(validate_anthropic_request("POST", "/v1/messages/count_tokens///").is_ok());
}

#[test]
fn exact_marker_routes_and_is_removed_from_user_block() {
    let mut body = serde_json::json!({
        "model": "claude-sonnet-4-6",
        "messages": [
            {"role":"user","content":[{"type":"text","text":"<system-reminder>x</system-reminder>"}]},
            {"role":"user","content":[{"type":"text","text":"<CCEM-ROUTE nonce=\"nonce\">subagent:Explore</CCEM-ROUTE>\nfind it"}]}
        ]
    });
    let identity = take_authenticated_marker(&mut body, "nonce").unwrap();
    assert_eq!(
        identity,
        Some(RouteIdentity::Logical("subagent:Explore".into()))
    );
    assert_eq!(body["messages"][1]["content"][0]["text"], "find it");
}

#[test]
fn first_authenticated_marker_routes_and_all_matching_markers_are_removed() {
    let mut body = serde_json::json!({
        "model": "claude-sonnet-4-6",
        "messages": [
            {"role":"user","content":"<CCEM-ROUTE nonce=\"nonce\">subagent:Explore</CCEM-ROUTE>\nfirst"},
            {"role":"assistant","content":"leave assistant content alone"},
            {"role":"user","content":[
                {"type":"text","text":"<CCEM-ROUTE nonce=\"nonce\">subagent:Explore</CCEM-ROUTE>\n<CCEM-ROUTE nonce=\"nonce\">subagent:Explore</CCEM-ROUTE>\nsecond"},
                {"type":"text","text":"<CCEM-ROUTE nonce=\"nonce\">subagent:Explore</CCEM-ROUTE>\nthird"}
            ]}
        ]
    });

    let identity = take_authenticated_marker(&mut body, "nonce").unwrap();

    assert_eq!(
        identity,
        Some(RouteIdentity::Logical("subagent:Explore".into()))
    );
    assert_eq!(body["messages"][0]["content"], "first");
    assert_eq!(body["messages"][2]["content"][0]["text"], "second");
    assert_eq!(body["messages"][2]["content"][1]["text"], "third");
    let serialized = serde_json::to_string(&body).unwrap();
    assert!(!serialized.contains("nonce"), "{serialized}");
}

#[test]
fn conflicting_authenticated_markers_fail_closed_after_stripping() {
    let mut body = serde_json::json!({"messages":[
        {"role":"user","content":"<CCEM-ROUTE nonce=\"nonce\">subagent:Explore</CCEM-ROUTE>\nfirst"},
        {"role":"user","content":"<CCEM-ROUTE nonce=\"nonce\">subagent:Plan</CCEM-ROUTE>\nsecond"}
    ]});

    let error = take_authenticated_marker(&mut body, "nonce")
        .expect_err("conflicting authenticated targets must not be routed");

    assert_eq!(error.code, "ROUTER_INVALID_MARKER");
    assert!(!error.message.contains("nonce"));
}

#[test]
fn wrong_nonce_and_mid_body_raw_tag_are_ignored() {
    let mut body = serde_json::json!({"messages":[
        {"role":"user","content":"prefix <CCEM-ROUTE nonce=\"nonce\">subagent:Explore</CCEM-ROUTE>"},
        {"role":"user","content":"<CCEM-ROUTE nonce=\"wrong\">subagent:Explore</CCEM-ROUTE>"}
    ]});
    assert_eq!(take_authenticated_marker(&mut body, "nonce").unwrap(), None);
}

#[test]
fn persisted_session_secrets_must_match_transport_and_marker_grammars() {
    let mut invalid_key = record();
    invalid_key.session_key = "bad/key".into();
    assert_eq!(
        validate_session_router_record(&invalid_key)
            .expect_err("slash must not enter the router path")
            .code,
        "ROUTER_INVALID_SESSION"
    );

    let mut invalid_nonce = record();
    invalid_nonce.route_tag_nonce = "bad\" nonce".into();
    assert_eq!(
        validate_session_router_record(&invalid_nonce)
            .expect_err("nonce must not break the authenticated marker")
            .code,
        "ROUTER_INVALID_SESSION"
    );
}

#[test]
fn explicit_override_requires_dynamic_and_allowlist() {
    let mut record = record();
    record.dynamic_routing = false;
    let error = explicit_environment_decision(&record, "glm".into()).unwrap_err();
    assert_eq!(error.code, "ROUTER_DYNAMIC_DISABLED");
    record.dynamic_routing = true;
    let error = explicit_environment_decision(&record, "kimi".into()).unwrap_err();
    assert_eq!(error.code, "ROUTER_ENV_NOT_ALLOWED");
}

#[test]
fn logical_binding_uses_exact_then_wildcard_then_default() {
    let record = record();
    let exact = resolve_route_decision(
        &record,
        None,
        Some(RouteIdentity::Logical("subagent:Explore".into())),
        Some("model"),
    )
    .unwrap();
    assert_eq!(exact.target_env, "glm");
    let wildcard = resolve_route_decision(
        &record,
        None,
        Some(RouteIdentity::Logical("subagent:Plan".into())),
        Some("model"),
    )
    .unwrap();
    assert_eq!(wildcard.target_env, "deepseek");
    let main = resolve_route_decision(&record, None, None, Some("model")).unwrap();
    assert_eq!(main.target_env, "official");
}

#[test]
fn model_mapping_preserves_launch_env_and_maps_cross_env() {
    let launch = RouterModelPins::default();
    let glm = RouterEnvironment {
        name: "glm".into(),
        base_url: "https://example.invalid".into(),
        auth: EnvironmentAuth::Token("secret".into()),
        pins: RouterModelPins {
            default_opus_model: Some("glm-opus".into()),
            default_sonnet_model: Some("glm-sonnet".into()),
            default_haiku_model: Some("glm-air".into()),
            model: Some("opus".into()),
        },
    };
    assert_eq!(
        resolve_target_model("claude-sonnet-4-6", "official", &launch, &glm, false).unwrap(),
        "glm-sonnet"
    );
    let official = RouterEnvironment {
        name: "official".into(),
        ..glm.clone()
    };
    assert_eq!(
        resolve_target_model("claude-sonnet-4-6", "official", &launch, &official, false).unwrap(),
        "claude-sonnet-4-6"
    );
}

#[test]
fn cross_env_without_compatible_pin_fails_closed() {
    let target = RouterEnvironment {
        name: "official".into(),
        base_url: OFFICIAL_BASE_URL.into(),
        auth: EnvironmentAuth::Token("secret".into()),
        pins: RouterModelPins::default(),
    };
    let error = resolve_target_model(
        "glm-sonnet",
        "glm",
        &RouterModelPins {
            default_sonnet_model: Some("glm-sonnet".into()),
            ..RouterModelPins::default()
        },
        &target,
        false,
    )
    .unwrap_err();
    assert_eq!(error.code, "ROUTER_MODEL_UNRESOLVED");
}

#[test]
fn background_uses_haiku_pin() {
    let target = RouterEnvironment {
        name: "glm".into(),
        base_url: "https://example.invalid".into(),
        auth: EnvironmentAuth::Token("secret".into()),
        pins: RouterModelPins {
            default_haiku_model: Some("glm-air".into()),
            ..RouterModelPins::default()
        },
    };
    assert_eq!(
        resolve_target_model(
            BACKGROUND_MODEL_ALIAS,
            "official",
            &RouterModelPins::default(),
            &target,
            false
        )
        .unwrap(),
        "glm-air"
    );
}

#[test]
fn auth_classifier_trims_token_and_restricts_oauth_origin() {
    let token_env = EnvConfig {
        base_url: Some(OFFICIAL_BASE_URL.into()),
        auth_token: Some("  token  ".into()),
        default_opus_model: None,
        default_sonnet_model: None,
        default_haiku_model: None,
        model: None,
        subagent_model: None,
        limit_write_tools: false,
    };
    assert!(matches!(
        environment_from_config("official", &token_env).unwrap().auth,
        EnvironmentAuth::Token(ref token) if token == "token"
    ));
    let mut empty = token_env.clone();
    empty.auth_token = Some("  ".into());
    assert!(matches!(
        environment_from_config("official", &empty).unwrap().auth,
        EnvironmentAuth::RequiresOauth
    ));
    empty.base_url = Some("https://api.anthropic.com/extra".into());
    let error = match environment_from_config("official", &empty) {
        Ok(_) => panic!("non-origin official URL must not classify as OAuth"),
        Err(error) => error,
    };
    assert_eq!(error.code, "ROUTER_AUTH_INVALID");
}

#[test]
fn token_headers_remove_all_old_credentials_and_cookie() {
    let headers = HashMap::from([
        ("Authorization".into(), "Bearer old".into()),
        ("x-api-key".into(), "old-key".into()),
        ("Cookie".into(), "session=secret".into()),
        ("anthropic-beta".into(), "beta".into()),
    ]);
    let rewritten =
        rewrite_request_headers(&headers, &EnvironmentAuth::Token("new".into())).unwrap();
    assert_eq!(
        rewritten.get("authorization").map(String::as_str),
        Some("Bearer new")
    );
    assert!(!rewritten
        .keys()
        .any(|key| key.eq_ignore_ascii_case("cookie")));
    assert!(!rewritten
        .keys()
        .any(|key| key.eq_ignore_ascii_case("x-api-key")));
    assert_eq!(
        rewritten.get("anthropic-beta").map(String::as_str),
        Some("beta")
    );
}

#[test]
fn base_path_and_query_are_preserved_without_traversal() {
    assert_eq!(
        compose_upstream_url(
            "https://example.com/api/anthropic",
            "/v1/messages",
            Some("beta=true")
        )
        .unwrap(),
        "https://example.com/api/anthropic/v1/messages?beta=true"
    );
    assert_eq!(
        compose_upstream_url("https://example.com", "/%2e%2e/secret", None)
            .unwrap_err()
            .code,
        "ROUTER_PATH_INVALID"
    );
}

#[test]
fn compressed_json_request_is_rejected() {
    let error =
        validate_request_encoding(&HashMap::from([("content-encoding".into(), "gzip".into())]))
            .unwrap_err();
    assert_eq!(error.status, 415);
}

#[test]
fn cas_conflict_returns_only_the_current_public_state() {
    let mut current = record();
    current.revision = 7;
    let error =
        apply_session_router_patch(&current, 6, &SessionRouterPatch::default(), false).unwrap_err();
    assert_eq!(error.code, "ROUTER_REVISION_CONFLICT");
    assert_eq!(error.current.as_ref().map(|state| state.revision), Some(7));
    let serialized = serde_json::to_string(&error).unwrap();
    assert!(!serialized.contains(&current.session_key));
    assert!(!serialized.contains(&current.route_tag_nonce));
}

#[test]
fn structurally_invalid_patch_does_not_mutate_current_record() {
    let current = record();
    let patch = SessionRouterPatch {
        bindings: Some(HashMap::from([("not-a-route".into(), "glm".into())])),
        ..SessionRouterPatch::default()
    };
    let error = apply_session_router_patch(&current, 0, &patch, false).unwrap_err();
    assert_eq!(error.code, "ROUTER_INVALID_BINDING");
    assert_eq!(current.revision, 0);
    assert!(current.bindings.contains_key("subagent:Explore"));
}

#[test]
fn config_validation_allows_existing_non_alias_environment_references() {
    let config = RouterConfig {
        bindings: HashMap::from([("background".into(), "Team GLM (legacy)".into())]),
        default_allowed_envs: vec!["Team GLM (legacy)".into()],
        ..RouterConfig::default()
    };
    validate_router_config(&config).unwrap();
    assert!(!is_valid_router_environment_alias("Team GLM (legacy)"));
}

#[test]
fn config_validation_rejects_reserved_profile_ids() {
    for reserved_id in ["default-only", "my-default"] {
        let config = RouterConfig {
            profiles: vec![RouterProfile {
                id: reserved_id.to_string(),
                name: "Must not shadow built-ins".into(),
                revision: 1,
                bindings: HashMap::new(),
                allowed_envs: Vec::new(),
            }],
            ..RouterConfig::default()
        };

        let error =
            validate_router_config(&config).expect_err("reserved profile ids must fail closed");
        assert_eq!(error.code, "ROUTER_PROFILE_INVALID");
        assert!(error.message.contains("reserved"), "{}", error.message);
    }
}
