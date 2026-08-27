use super::*;
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

const NOW: i64 = 1_786_300_000;

fn temp_root(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "ccem-codex-migration-{name}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos()
    ))
}

fn jwt(claims: JsonValue) -> String {
    let encode = |value: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value);
    format!(
        "{}.{}.signature",
        encode(br#"{"alg":"none"}"#),
        encode(
            serde_json::to_vec(&claims)
                .expect("claims should encode")
                .as_slice()
        )
    )
}

fn auth(plan: &str) -> JsonValue {
    let claims = json!({
        "exp": NOW + 3600,
        "https://api.openai.com/auth": {
            "chatgpt_plan_type": plan,
            "chatgpt_user_id": "user",
            "chatgpt_account_id": "account",
            "chatgpt_account_is_fedramp": false
        }
    });
    json!({
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": null,
        "last_refresh": "2026-08-08T00:00:00Z",
        "tokens": {
            "id_token": jwt(claims.clone()),
            "access_token": jwt(claims),
            "refresh_token": "refresh",
            "account_id": "account"
        }
    })
}

fn fixture(name: &str, config: &str, auth_value: JsonValue) -> (PathBuf, PreflightContext) {
    let root = temp_root(name);
    let codex_home = root.join("codex-home");
    let working_dir = root.join("workspace");
    fs::create_dir_all(&codex_home).expect("create codex home");
    fs::create_dir_all(&working_dir).expect("create workspace");
    fs::write(codex_home.join("config.toml"), config).expect("write config");
    fs::write(
        codex_home.join("auth.json"),
        serde_json::to_vec(&auth_value).expect("encode auth"),
    )
    .expect("write auth");
    let context = PreflightContext {
        codex_home,
        working_dir,
        env_name: "Codex Native".to_string(),
        runtime: PreflightRuntime {
            path: "/opt/codex".to_string(),
            version: "0.147.0-alpha.6.5".to_string(),
            binary_sha256: "runtime-sha".to_string(),
        },
        has_process_auth_override: false,
        has_unknown_codex_env: false,
        managed_preferences_present: false,
        system_layer_paths: Vec::new(),
        now_epoch_seconds: NOW,
    };
    (root, context)
}

#[test]
fn exact_personal_chatgpt_models_are_affected() {
    for (model, replacement) in [
        (AFFECTED_MODEL, TERRA_REPLACEMENT),
        (AFFECTED_MINI_MODEL, LUNA_REPLACEMENT),
    ] {
        let (root, context) = fixture(
            model,
            &format!("model = \"{model}\"\ncli_auth_credentials_store = \"file\"\n"),
            auth("plus"),
        );
        let evaluation = evaluate(context);
        assert_eq!(evaluation.result.status, "affected");
        assert_eq!(evaluation.result.model, Some(model));
        assert_eq!(evaluation.result.replacement, Some(replacement));
        assert_eq!(
            evaluation.result.proof_token.as_deref().map(str::len),
            Some(64)
        );
        assert_eq!(evaluation.runtime_path.as_deref(), Some("/opt/codex"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    let (root, mut context) = fixture("v0139", "model = \"gpt-5.4\"\n", auth("free"));
    context.runtime.version = "0.139.0".to_string();
    assert_eq!(evaluate(context).result.status, "affected");
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn default_near_match_and_replacement_models_are_unknown() {
    for config in [
        "model_reasoning_effort = \"high\"\n",
        "model = \" gpt-5.4 \"\n",
        "model = \"GPT-5.4\"\n",
        "model = \"gpt-5.6-terra\"\n",
    ] {
        let (root, context) = fixture("model-unknown", config, auth("plus"));
        assert_eq!(evaluate(context).result.status, "unknown");
        fs::remove_dir_all(root).expect("remove fixture");
    }
}

#[test]
fn auth_overrides_and_non_file_storage_are_unknown() {
    let (root, mut context) = fixture("auth-override", "model = \"gpt-5.4\"\n", auth("plus"));
    context.has_process_auth_override = true;
    assert_eq!(evaluate(context.clone()).result.status, "unknown");
    context.has_process_auth_override = false;
    context.has_unknown_codex_env = true;
    assert_eq!(evaluate(context).result.status, "unknown");
    fs::remove_dir_all(root).expect("remove fixture");

    for store in ["keyring", "auto"] {
        let (root, context) = fixture(
            store,
            &format!("model = \"gpt-5.4\"\ncli_auth_credentials_store = \"{store}\"\n"),
            auth("plus"),
        );
        assert_eq!(evaluate(context).result.status, "unknown");
        fs::remove_dir_all(root).expect("remove fixture");
    }
}

#[test]
fn windows_environment_keys_follow_case_insensitive_runtime_semantics() {
    for key in ["codex_api_key", "CoDeX_AcCeSs_ToKeN", "openai_api_key"] {
        assert!(is_process_auth_override_key(key, true));
        assert!(!is_process_auth_override_key(key, false));
    }
    assert!(!is_unknown_codex_environment_key("codex_home", true));
    assert!(is_unknown_codex_environment_key("CoDeX_FuTuRe", true));
    assert!(!is_unknown_codex_environment_key("CoDeX_FuTuRe", false));
}

#[test]
fn managed_workspace_and_expired_auth_are_unknown() {
    for plan in ["team", "business", "enterprise", "edu"] {
        let (root, context) = fixture(plan, "model = \"gpt-5.4\"\n", auth(plan));
        assert_eq!(evaluate(context).result.status, "unknown");
        fs::remove_dir_all(root).expect("remove fixture");
    }

    let mut expired = auth("plus");
    let expired_claims = json!({
        "exp": NOW - 1,
        "https://api.openai.com/auth": {
            "chatgpt_plan_type": "plus",
            "chatgpt_user_id": "user",
            "chatgpt_account_id": "account"
        }
    });
    expired["tokens"]["id_token"] = json!(jwt(expired_claims.clone()));
    expired["tokens"]["access_token"] = json!(jwt(expired_claims));
    let (root, context) = fixture("expired", "model = \"gpt-5.4\"\n", expired);
    assert_eq!(evaluate(context).result.status, "unknown");
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn alternative_or_malformed_auth_shapes_are_unknown() {
    let mut cases = Vec::new();
    let mut api_key_mode = auth("plus");
    api_key_mode["auth_mode"] = json!("apikey");
    cases.push(api_key_mode);
    let mut bedrock = auth("plus");
    bedrock["bedrock_api_key"] = json!("secret");
    cases.push(bedrock);
    let mut missing_refresh_time = auth("plus");
    missing_refresh_time
        .as_object_mut()
        .expect("auth object")
        .remove("last_refresh");
    cases.push(missing_refresh_time);
    let mut account_mismatch = auth("plus");
    account_mismatch["tokens"]["account_id"] = json!("different");
    cases.push(account_mismatch);
    let mut malformed_fedramp = auth("plus");
    let claims = json!({
        "exp": NOW + 3600,
        "https://api.openai.com/auth": {
            "chatgpt_plan_type": "plus",
            "chatgpt_user_id": "user",
            "chatgpt_account_id": "account",
            "chatgpt_account_is_fedramp": "false"
        }
    });
    malformed_fedramp["tokens"]["id_token"] = json!(jwt(claims));
    cases.push(malformed_fedramp);

    for (index, auth_value) in cases.into_iter().enumerate() {
        let (root, context) = fixture(
            &format!("auth-shape-{index}"),
            "model = \"gpt-5.4\"\n",
            auth_value,
        );
        assert_eq!(evaluate(context).result.status, "unknown");
        fs::remove_dir_all(root).expect("remove fixture");
    }
}

#[test]
fn provider_profile_project_and_managed_surfaces_are_unknown() {
    let configs = [
        "model = \"gpt-5.4\"\nmodel_provider = \"custom\"\n",
        "model = \"gpt-5.4\"\nprofile = \"work\"\n",
        "model = \"gpt-5.4\"\nforced_chatgpt_workspace_id = \"workspace\"\n",
        "model = \"gpt-5.4\"\n[model_providers.openai]\nname = \"fake\"\n",
        "model = \"gpt-5.4\"\nproject_root_markers = [\".root\"]\n",
        "model = \"gpt-5.4\"\nexperimental_thread_config_endpoint = \"https://example.com\"\n",
        "model = \"gpt-5.4\"\nfuture_auth_override = true\n",
    ];
    for config in configs {
        let (root, context) = fixture("config-surface", config, auth("plus"));
        assert_eq!(evaluate(context).result.status, "unknown");
        fs::remove_dir_all(root).expect("remove fixture");
    }

    let (root, mut context) = fixture("managed", "model = \"gpt-5.4\"\n", auth("plus"));
    context.managed_preferences_present = true;
    assert_eq!(evaluate(context.clone()).result.status, "unknown");
    context.managed_preferences_present = false;
    let managed_file = root.join("managed.toml");
    fs::write(&managed_file, "model = \"gpt-5.6-terra\"\n").expect("write managed");
    context.system_layer_paths = vec![managed_file];
    assert_eq!(evaluate(context).result.status, "unknown");
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn project_config_is_unknown_but_user_config_is_not_double_counted() {
    let (root, context) = fixture("project", "model = \"gpt-5.4\"\n", auth("plus"));
    fs::create_dir_all(context.working_dir.join(".codex")).expect("create project config dir");
    fs::write(
        context.working_dir.join(".codex/config.toml"),
        "model = \"gpt-5.6-terra\"\n",
    )
    .expect("write project config");
    assert_eq!(evaluate(context).result.status, "unknown");
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn unsupported_runtime_and_post_deadline_are_unknown() {
    let (root, mut context) = fixture("runtime", "model = \"gpt-5.4\"\n", auth("plus"));
    for version in ["0.140.0", "0.146.0", "0.147.0-alpha.6.4", "0.148.0"] {
        context.runtime.version = version.to_string();
        assert_eq!(evaluate(context.clone()).result.status, "unknown");
    }
    context.runtime.version = "0.147.0-alpha.6.5".to_string();
    context.now_epoch_seconds = 1_788_220_800;
    assert_eq!(evaluate(context).result.status, "unknown");
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn proof_binds_runtime_and_atomic_create_requires_exact_token() {
    let (root, context) = fixture("proof", "model = \"gpt-5.4\"\n", auth("plus"));
    let first = evaluate(context.clone());
    let token = first
        .result
        .proof_token
        .clone()
        .expect("affected result should have proof");
    assert_eq!(
        require_matching_proof(evaluate(context.clone()), None),
        Ok(None),
        "a failed or unknown preflight must not block session creation"
    );
    assert_eq!(
        require_matching_proof(first, Some(&token)),
        Ok(Some("/opt/codex".to_string()))
    );

    let changed = evaluate(PreflightContext {
        runtime: PreflightRuntime {
            binary_sha256: "changed-runtime".to_string(),
            ..context.runtime.clone()
        },
        ..context
    });
    assert_ne!(changed.result.proof_token.as_deref(), Some(token.as_str()));
    assert_eq!(
        require_matching_proof(changed, Some(&token)),
        Err(PREFLIGHT_CHANGED_ERROR.to_string())
    );
    fs::remove_dir_all(root).expect("remove fixture");
}

#[cfg(unix)]
#[test]
fn symlinked_auth_or_config_is_unknown() {
    use std::os::unix::fs::symlink;

    let (root, context) = fixture("symlink", "model = \"gpt-5.4\"\n", auth("plus"));
    let config_path = context.codex_home.join("config.toml");
    let target = context.codex_home.join("real-config.toml");
    fs::rename(&config_path, &target).expect("move config");
    symlink(&target, &config_path).expect("link config");
    assert_eq!(evaluate(context).result.status, "unknown");
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn detector_source_has_no_process_network_or_write_dependencies() {
    let source = include_str!("codex_migration.rs");
    let forbidden = [
        ["tauri_plugin", "_shell"].concat(),
        ["std::process::", "Command"].concat(),
        ["req", "west"].concat(),
        ["config::read_", "config"].concat(),
        ["resolve_codex_", "path"].concat(),
        ["File::", "create"].concat(),
    ];
    for forbidden in forbidden {
        assert!(
            !source.contains(&forbidden),
            "detector must not contain forbidden dependency {forbidden}"
        );
    }

    let desktop_source = include_str!("lib.rs");
    let verify = desktop_source
        .find("runtime_path_for_verified_launch")
        .expect("create command should verify proof");
    let resolve = desktop_source
        .find("resolve_codex_runtime(&env_name)")
        .expect("create command should resolve runtime");
    let create = desktop_source
        .find("native_state.create_session")
        .expect("create command should create session");
    assert!(verify < resolve && resolve < create);
}

#[test]
fn preflight_reads_do_not_change_fixture_files() {
    let (root, context) = fixture("read-only", "model = \"gpt-5.4\"\n", auth("pro"));
    let config_path = context.codex_home.join("config.toml");
    let auth_path = context.codex_home.join("auth.json");
    let before = (
        fs::read(&config_path).unwrap(),
        fs::read(&auth_path).unwrap(),
    );
    assert_eq!(evaluate(context).result.status, "affected");
    let after = (
        fs::read(&config_path).unwrap(),
        fs::read(&auth_path).unwrap(),
    );
    assert_eq!(before, after);
    fs::remove_dir_all(root).expect("remove fixture");
}
