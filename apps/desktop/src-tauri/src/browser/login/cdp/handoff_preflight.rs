use super::super::backend::{BackendFailure, BackendFailureCode};
use super::super::policy::NormalizedOrigin;
use super::guard::{
    TrustedHandoffPreflightDenial as TrustedAuditDenial, TrustedHandoffPreflightDenialKind,
};
use super::protocol::CdpMethod;
use super::semantics::SemanticEngine;
use super::transport::{CdpClient, NeverCancelled};
use serde_json::Value;
use std::collections::BTreeSet;
use std::time::Instant;

const MAX_TARGETS: usize = 128;
const MAX_FRAMES: usize = 512;
const MAX_URL_CHARS: usize = 8_192;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HandoffPreflightDenial {
    pub(super) kind: TrustedHandoffPreflightDenialKind,
    pub(super) target_url: Option<String>,
}

pub(super) fn validate_handoff_preflight(
    targets: &Value,
    frame_tree: &Value,
    primary_target: &str,
    expected_origin: &NormalizedOrigin,
) -> Result<(), HandoffPreflightDenial> {
    collect_inventory(targets, frame_tree, primary_target, expected_origin).map(|_| ())
}

fn validate_stable_handoff_preflight(
    first_targets: &Value,
    first_frame_tree: &Value,
    second_targets: &Value,
    second_frame_tree: &Value,
    primary_target: &str,
    expected_origin: &NormalizedOrigin,
) -> Result<(), HandoffPreflightDenial> {
    let first = collect_inventory(
        first_targets,
        first_frame_tree,
        primary_target,
        expected_origin,
    )?;
    let second = collect_inventory(
        second_targets,
        second_frame_tree,
        primary_target,
        expected_origin,
    )?;
    (first == second)
        .then_some(())
        .ok_or_else(invalid_inventory)
}

fn validate_stable_exact_target_handoff_preflight(
    first_target_info: &Value,
    first_frame_tree: &Value,
    second_target_info: &Value,
    second_frame_tree: &Value,
    primary_target: &str,
    expected_origin: &NormalizedOrigin,
) -> Result<(), HandoffPreflightDenial> {
    let exact_inventory = |response: &Value| {
        let target_info = response.get("targetInfo").ok_or_else(invalid_inventory)?;
        if bounded_field(target_info, "targetId", 256).as_deref() != Some(primary_target) {
            // A response for another retained Browser is protocol corruption, not an
            // extra-page finding. Reject it without attributing the sibling URL to this owner.
            return Err(invalid_inventory());
        }
        Ok(serde_json::json!({"targetInfos": [target_info.clone()]}))
    };
    let first_targets = exact_inventory(first_target_info)?;
    let second_targets = exact_inventory(second_target_info)?;
    validate_stable_handoff_preflight(
        &first_targets,
        first_frame_tree,
        &second_targets,
        second_frame_tree,
        primary_target,
        expected_origin,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HandoffInventory {
    primary: PrimaryPageInventory,
    frames: Vec<FrameInventory>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PrimaryPageInventory {
    target_id: String,
    url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct FrameInventory {
    frame_id: String,
    parent_id: Option<String>,
    loader_id: String,
    url: String,
    security_origin: String,
}

fn collect_inventory(
    targets: &Value,
    frame_tree: &Value,
    primary_target: &str,
    expected_origin: &NormalizedOrigin,
) -> Result<HandoffInventory, HandoffPreflightDenial> {
    let primary = validate_targets(targets, primary_target, expected_origin)?;
    let (root_url, frames) = validate_frames(frame_tree, expected_origin)?;
    if root_url != primary.url {
        return Err(invalid_inventory());
    }
    Ok(HandoffInventory { primary, frames })
}

impl SemanticEngine {
    pub(super) fn preflight_handoff(
        &mut self,
        client: &mut CdpClient<'_>,
        expected_origin: &NormalizedOrigin,
        deadline: Instant,
    ) -> Result<(), BackendFailure> {
        let primary_target = self.primary_target.clone().ok_or_else(preflight_failure)?;
        let primary_session = self.primary_session()?;
        let exact_embedded_target = self.uses_exact_embedded_target_scope();
        let target_method = if exact_embedded_target {
            CdpMethod::TargetGetTargetInfo
        } else {
            CdpMethod::TargetGetTargets
        };
        let target_params = || {
            if exact_embedded_target {
                serde_json::json!({"targetId": primary_target})
            } else {
                serde_json::json!({})
            }
        };
        let first_targets = client.call(
            target_method,
            target_params(),
            None,
            deadline,
            &NeverCancelled,
            self,
        )?;
        let first_frames = client.call(
            CdpMethod::PageGetFrameTree,
            serde_json::json!({}),
            Some(&primary_session),
            deadline,
            &NeverCancelled,
            self,
        )?;
        let second_targets = client.call(
            target_method,
            target_params(),
            None,
            deadline,
            &NeverCancelled,
            self,
        )?;
        let second_frames = client.call(
            CdpMethod::PageGetFrameTree,
            serde_json::json!({}),
            Some(&primary_session),
            deadline,
            &NeverCancelled,
            self,
        )?;
        let validation = if exact_embedded_target {
            validate_stable_exact_target_handoff_preflight(
                &first_targets,
                &first_frames,
                &second_targets,
                &second_frames,
                &primary_target,
                expected_origin,
            )
        } else {
            validate_stable_handoff_preflight(
                &first_targets,
                &first_frames,
                &second_targets,
                &second_frames,
                &primary_target,
                expected_origin,
            )
        };
        if let Err(denial) = validation {
            self.guard
                .record_handoff_preflight_denial(TrustedAuditDenial {
                    kind: denial.kind,
                    target_url: denial.target_url.as_deref(),
                })
                .map_err(|_| audit_failure())?;
            return Err(preflight_failure());
        }
        Ok(())
    }
}

fn preflight_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::NavigationFailed,
        "Browser handoff preflight rejected the current page inventory.",
    )
}

fn audit_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::RuntimeUnavailable,
        "Browser handoff preflight audit is unavailable.",
    )
}

fn validate_targets(
    targets: &Value,
    primary_target: &str,
    expected_origin: &NormalizedOrigin,
) -> Result<PrimaryPageInventory, HandoffPreflightDenial> {
    let infos = targets
        .get("targetInfos")
        .and_then(Value::as_array)
        .filter(|infos| infos.len() <= MAX_TARGETS)
        .ok_or_else(invalid_inventory)?;
    let mut primary_count = 0;
    let mut primary_inventory = None;
    for info in infos {
        let target_type = bounded_field(info, "type", 64).ok_or_else(invalid_inventory)?;
        if target_type != "page" {
            continue;
        }
        let target_id = bounded_field(info, "targetId", 256).ok_or_else(invalid_inventory)?;
        if target_id == primary_target {
            primary_count += 1;
            let url = bounded_field(info, "url", MAX_URL_CHARS).ok_or_else(invalid_inventory)?;
            if info.get("attached").and_then(Value::as_bool) != Some(true) {
                return Err(invalid_inventory());
            }
            if NormalizedOrigin::parse(&url).ok().as_ref() != Some(expected_origin) {
                return Err(HandoffPreflightDenial {
                    kind: TrustedHandoffPreflightDenialKind::TopLevelOrigin,
                    target_url: Some(url),
                });
            }
            primary_inventory = Some(PrimaryPageInventory { target_id, url });
            continue;
        }
        return Err(HandoffPreflightDenial {
            kind: TrustedHandoffPreflightDenialKind::ExtraPage,
            target_url: bounded_field(info, "url", MAX_URL_CHARS),
        });
    }
    if primary_count != 1 {
        return Err(invalid_inventory());
    }
    primary_inventory.ok_or_else(invalid_inventory)
}

fn validate_frames(
    result: &Value,
    expected_origin: &NormalizedOrigin,
) -> Result<(String, Vec<FrameInventory>), HandoffPreflightDenial> {
    let root = result.get("frameTree").ok_or_else(invalid_inventory)?;
    let mut stack = vec![(root, None::<String>, true)];
    let mut seen = BTreeSet::new();
    let mut frame_count = 0;
    let mut inventory = Vec::new();
    let mut root_url = None;
    while let Some((tree, expected_parent, is_root)) = stack.pop() {
        frame_count += 1;
        if frame_count > MAX_FRAMES {
            return Err(invalid_inventory());
        }
        let frame = tree.get("frame").ok_or_else(invalid_inventory)?;
        let frame_id = bounded_field(frame, "id", 256).ok_or_else(invalid_inventory)?;
        if !seen.insert(frame_id.clone()) {
            return Err(invalid_inventory());
        }
        match expected_parent.as_deref() {
            None if frame.get("parentId").is_some() => return Err(invalid_inventory()),
            Some(parent) if bounded_field(frame, "parentId", 256).as_deref() != Some(parent) => {
                return Err(invalid_inventory())
            }
            _ => {}
        }
        let url = bounded_field(frame, "url", MAX_URL_CHARS).ok_or_else(invalid_inventory)?;
        let url_fragment = match frame.get("urlFragment") {
            None => None,
            Some(Value::String(fragment))
                if !fragment.is_empty()
                    && fragment.starts_with('#')
                    && fragment.chars().take(MAX_URL_CHARS + 1).count() <= MAX_URL_CHARS
                    && !fragment.chars().any(char::is_control) =>
            {
                Some(fragment.as_str())
            }
            Some(_) => return Err(invalid_inventory()),
        };
        let document_url = match url_fragment {
            Some(fragment)
                if url.chars().count().saturating_add(fragment.chars().count())
                    <= MAX_URL_CHARS =>
            {
                format!("{url}{fragment}")
            }
            Some(_) => return Err(invalid_inventory()),
            None => url.clone(),
        };
        let loader_id = bounded_field(frame, "loaderId", 256).ok_or_else(invalid_inventory)?;
        let security_origin =
            bounded_field(frame, "securityOrigin", MAX_URL_CHARS).ok_or_else(invalid_inventory)?;
        let inherited = !is_root && matches!(url.as_str(), "about:blank" | "about:srcdoc");
        let allowed = (NormalizedOrigin::parse(&url)
            .map(|origin| &origin == expected_origin)
            .unwrap_or(false)
            || inherited)
            && NormalizedOrigin::parse(&security_origin)
                .map(|origin| &origin == expected_origin)
                .unwrap_or(false);
        if !allowed {
            return Err(HandoffPreflightDenial {
                kind: if is_root {
                    TrustedHandoffPreflightDenialKind::TopLevelOrigin
                } else {
                    TrustedHandoffPreflightDenialKind::ChildFrameOrigin
                },
                target_url: Some(document_url),
            });
        }
        inventory.push(FrameInventory {
            frame_id: frame_id.clone(),
            parent_id: expected_parent.clone(),
            loader_id,
            url: document_url,
            security_origin,
        });
        if is_root {
            root_url = inventory.last().map(|frame| frame.url.clone());
        }
        let children = match tree.get("childFrames") {
            None | Some(Value::Null) => continue,
            Some(children) => children.as_array().ok_or_else(invalid_inventory)?,
        };
        if children.len() > MAX_FRAMES.saturating_sub(frame_count) {
            return Err(invalid_inventory());
        }
        stack.extend(
            children
                .iter()
                .map(|child| (child, Some(frame_id.clone()), false)),
        );
    }
    inventory.sort();
    Ok((root_url.ok_or_else(invalid_inventory)?, inventory))
}

fn bounded_field(value: &Value, key: &str, maximum: usize) -> Option<String> {
    let value = value.get(key)?.as_str()?;
    (!value.is_empty()
        && value.chars().take(maximum + 1).count() <= maximum
        && !value.chars().any(char::is_control))
    .then(|| value.to_string())
}

fn invalid_inventory() -> HandoffPreflightDenial {
    HandoffPreflightDenial {
        kind: TrustedHandoffPreflightDenialKind::InvalidInventory,
        target_url: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::login::cdp::artifacts::CdpArtifactStore;
    use crate::browser::login::cdp::console_events::ConsoleEventRecorder;
    use crate::browser::login::cdp::guard::{
        TrustedNavigationDecision, TrustedNavigationGuard, TrustedNavigationRequest,
        TrustedSecurityAuditFailure,
    };
    use crate::browser::login::cdp::network_events::NetworkEventRecorder;
    use crate::browser::login::network::NetworkRedactionConfig;
    use std::io::Cursor;
    use std::sync::Arc;
    use std::time::Duration;

    struct AuditedAllow;

    impl TrustedNavigationGuard for AuditedAllow {
        fn authorize(&self, _request: TrustedNavigationRequest<'_>) -> TrustedNavigationDecision {
            TrustedNavigationDecision::allow("allowed")
        }

        fn record_handoff_preflight_denial(
            &self,
            _denial: TrustedAuditDenial<'_>,
        ) -> Result<(), TrustedSecurityAuditFailure> {
            Ok(())
        }
    }

    fn origin() -> NormalizedOrigin {
        NormalizedOrigin::parse("https://allowed.example").unwrap()
    }

    fn targets(extra: Option<(&str, &str)>) -> Value {
        let mut infos = vec![serde_json::json!({
            "targetId":"primary-target",
            "type":"page",
            "url":"https://allowed.example/login",
            "attached":true
        })];
        if let Some((target_id, url)) = extra {
            infos.push(serde_json::json!({
                "targetId":target_id,
                "type":"page",
                "url":url,
                "attached":true
            }));
        }
        serde_json::json!({"targetInfos":infos})
    }

    fn exact_target_info(target_id: &str, url: &str, attached: bool) -> Value {
        serde_json::json!({
            "targetInfo": {
                "targetId": target_id,
                "type": "page",
                "url": url,
                "attached": attached
            }
        })
    }

    fn frames(children: Vec<Value>) -> Value {
        serde_json::json!({
            "frameTree":{
                "frame":{
                    "id":"root",
                    "loaderId":"loader-root",
                    "url":"https://allowed.example/login",
                    "securityOrigin":"https://allowed.example"
                },
                "childFrames":children
            }
        })
    }

    fn child(id: &str, url: &str, children: Vec<Value>) -> Value {
        child_of(id, "root", url, children)
    }

    fn child_of(id: &str, parent: &str, url: &str, children: Vec<Value>) -> Value {
        let security_origin = if matches!(url, "about:blank" | "about:srcdoc") {
            "https://allowed.example"
        } else if url.starts_with("https://allowed.example") {
            "https://allowed.example"
        } else {
            url
        };
        serde_json::json!({
            "frame":{
                "id":id,
                "parentId":parent,
                "loaderId":format!("loader-{id}"),
                "url":url,
                "securityOrigin":security_origin
            },
            "childFrames":children
        })
    }

    #[test]
    fn unique_primary_with_same_origin_and_inherited_frames_is_allowed() {
        let tree = frames(vec![
            child("same", "https://allowed.example/embed", vec![]),
            child(
                "blank",
                "about:blank",
                vec![child_of("srcdoc", "blank", "about:srcdoc", vec![])],
            ),
        ]);
        assert!(
            validate_handoff_preflight(&targets(None), &tree, "primary-target", &origin()).is_ok()
        );
    }

    #[test]
    fn extra_page_is_denied_even_when_same_origin() {
        let error = validate_handoff_preflight(
            &targets(Some(("popup", "https://allowed.example/popup?private=1"))),
            &frames(vec![]),
            "primary-target",
            &origin(),
        )
        .unwrap_err();
        assert_eq!(error.kind, TrustedHandoffPreflightDenialKind::ExtraPage);
        assert_eq!(
            error.target_url.as_deref(),
            Some("https://allowed.example/popup?private=1")
        );
    }

    #[test]
    fn cross_origin_and_opaque_child_frames_fail_closed() {
        for url in [
            "https://denied.example/private?token=raw",
            "data:text/html,private",
            "blob:https://allowed.example/private-id",
            "about:blank#not-exact",
        ] {
            let error = validate_handoff_preflight(
                &targets(None),
                &frames(vec![child("denied", url, vec![])]),
                "primary-target",
                &origin(),
            )
            .unwrap_err();
            assert_eq!(
                error.kind,
                TrustedHandoffPreflightDenialKind::ChildFrameOrigin
            );
        }
    }

    #[test]
    fn target_and_frame_top_level_origin_must_both_match_the_grant() {
        let wrong_target = serde_json::json!({"targetInfos":[{
            "targetId":"primary-target","type":"page","url":"https://race.example/private",
            "attached":true
        }]});
        let wrong_frame = serde_json::json!({"frameTree":{
            "frame":{
                "id":"root",
                "loaderId":"loader-race",
                "url":"https://race.example/private",
                "securityOrigin":"https://race.example"
            }
        }});
        for (targets, frames) in [(wrong_target, frames(vec![])), (targets(None), wrong_frame)] {
            let error = validate_handoff_preflight(&targets, &frames, "primary-target", &origin())
                .unwrap_err();
            assert_eq!(
                error.kind,
                TrustedHandoffPreflightDenialKind::TopLevelOrigin
            );
            assert_eq!(
                error.target_url.as_deref(),
                Some("https://race.example/private")
            );
        }
    }

    #[test]
    fn target_or_frame_change_between_samples_fails_closed() {
        let first_targets = targets(None);
        let mut changed_targets = targets(None);
        changed_targets["targetInfos"][0]["url"] =
            Value::String("https://allowed.example/after-race".to_string());
        assert!(validate_stable_handoff_preflight(
            &first_targets,
            &frames(vec![]),
            &changed_targets,
            &frames(vec![]),
            "primary-target",
            &origin(),
        )
        .is_err());

        let first_frames = frames(vec![]);
        let mut changed_frames = frames(vec![]);
        changed_frames["frameTree"]["frame"]["loaderId"] =
            Value::String("loader-after-race".to_string());
        assert!(validate_stable_handoff_preflight(
            &targets(None),
            &first_frames,
            &targets(None),
            &changed_frames,
            "primary-target",
            &origin(),
        )
        .is_err());
    }

    #[test]
    fn exact_target_preflight_fails_closed_for_wrong_identity_detachment_origin_and_races() {
        let valid_target =
            exact_target_info("primary-target", "https://allowed.example/login", true);
        let valid_frames = frames(vec![]);

        let wrong_identity = validate_stable_exact_target_handoff_preflight(
            &exact_target_info(
                "sibling-target",
                "https://allowed.example/private-sibling",
                true,
            ),
            &valid_frames,
            &valid_target,
            &valid_frames,
            "primary-target",
            &origin(),
        )
        .unwrap_err();
        assert_eq!(
            wrong_identity.kind,
            TrustedHandoffPreflightDenialKind::InvalidInventory
        );
        assert!(
            wrong_identity.target_url.is_none(),
            "a sibling Browser URL must not be attributed to this exact owner"
        );

        let detached = validate_stable_exact_target_handoff_preflight(
            &exact_target_info("primary-target", "https://allowed.example/login", false),
            &valid_frames,
            &valid_target,
            &valid_frames,
            "primary-target",
            &origin(),
        )
        .unwrap_err();
        assert_eq!(
            detached.kind,
            TrustedHandoffPreflightDenialKind::InvalidInventory
        );
        assert!(detached.target_url.is_none());

        let wrong_origin = validate_stable_exact_target_handoff_preflight(
            &exact_target_info("primary-target", "https://denied.example/private", true),
            &valid_frames,
            &valid_target,
            &valid_frames,
            "primary-target",
            &origin(),
        )
        .unwrap_err();
        assert_eq!(
            wrong_origin.kind,
            TrustedHandoffPreflightDenialKind::TopLevelOrigin
        );

        let changed_target =
            exact_target_info("primary-target", "https://allowed.example/after-race", true);
        let mut changed_frames = frames(vec![]);
        changed_frames["frameTree"]["frame"]["url"] =
            Value::String("https://allowed.example/after-race".to_string());
        let unstable = validate_stable_exact_target_handoff_preflight(
            &valid_target,
            &valid_frames,
            &changed_target,
            &changed_frames,
            "primary-target",
            &origin(),
        )
        .unwrap_err();
        assert_eq!(
            unstable.kind,
            TrustedHandoffPreflightDenialKind::InvalidInventory
        );
        assert!(unstable.target_url.is_none());
    }

    #[test]
    fn detached_primary_or_mismatched_security_origin_fails_closed() {
        let mut detached = targets(None);
        detached["targetInfos"][0]["attached"] = Value::Bool(false);
        let detached_error =
            validate_handoff_preflight(&detached, &frames(vec![]), "primary-target", &origin())
                .unwrap_err();
        assert_eq!(
            detached_error.kind,
            TrustedHandoffPreflightDenialKind::InvalidInventory
        );

        let mut wrong_security_origin = frames(vec![child(
            "same-url",
            "https://allowed.example/embed",
            vec![],
        )]);
        wrong_security_origin["frameTree"]["childFrames"][0]["frame"]["securityOrigin"] =
            Value::String("https://opaque-or-denied.example".to_string());
        let security_error = validate_handoff_preflight(
            &targets(None),
            &wrong_security_origin,
            "primary-target",
            &origin(),
        )
        .unwrap_err();
        assert_eq!(
            security_error.kind,
            TrustedHandoffPreflightDenialKind::ChildFrameOrigin
        );
    }

    #[test]
    fn cdp_frame_fragment_is_reconstructed_before_target_stability_comparison() {
        let mut fragment_target = targets(None);
        fragment_target["targetInfos"][0]["url"] =
            Value::String("https://allowed.example/login#ccem-proof".to_string());
        let mut fragment_frame = frames(vec![]);
        fragment_frame["frameTree"]["frame"]["urlFragment"] =
            Value::String("#ccem-proof".to_string());
        assert!(validate_handoff_preflight(
            &fragment_target,
            &fragment_frame,
            "primary-target",
            &origin(),
        )
        .is_ok());

        fragment_frame["frameTree"]["frame"]["urlFragment"] =
            Value::String("missing-leading-hash".to_string());
        assert!(validate_handoff_preflight(
            &fragment_target,
            &fragment_frame,
            "primary-target",
            &origin(),
        )
        .is_err());
    }

    #[test]
    fn malformed_or_unbounded_inventory_fails_closed() {
        for (targets, frames) in [
            (serde_json::json!({}), frames(vec![])),
            (targets(None), serde_json::json!({"frameTree":{}})),
            (
                targets(None),
                frames(vec![child("large", &"x".repeat(MAX_URL_CHARS + 1), vec![])]),
            ),
        ] {
            let error = validate_handoff_preflight(&targets, &frames, "primary-target", &origin())
                .unwrap_err();
            assert_eq!(
                error.kind,
                TrustedHandoffPreflightDenialKind::InvalidInventory
            );
            assert!(error.target_url.is_none());
        }
    }

    #[test]
    fn owner_preflight_uses_only_target_inventory_and_primary_frame_tree() {
        let temp = tempfile::tempdir().unwrap();
        let mut engine = SemanticEngine::new(
            Arc::new(AuditedAllow),
            CdpArtifactStore::new(temp.path().join("artifacts")).unwrap(),
            NetworkEventRecorder::new(
                temp.path().join("logs"),
                "session".to_string(),
                NetworkRedactionConfig::default(),
            )
            .unwrap(),
            ConsoleEventRecorder::new(
                temp.path().join("logs"),
                "session".to_string(),
                NetworkRedactionConfig::default(),
            )
            .unwrap(),
        );
        engine.primary_target = Some("primary-target".to_string());
        engine.primary_session = Some("primary-session".to_string());
        let (sender, inbox, state) = super::super::transport::frame_channel();
        let mut input = Vec::new();
        for frame in [
            serde_json::json!({"id":1,"result":targets(None)}),
            serde_json::json!({"id":2,"result":frames(vec![])}),
            serde_json::json!({"id":3,"result":targets(None)}),
            serde_json::json!({"id":4,"result":frames(vec![])}),
        ] {
            input.extend_from_slice(&serde_json::to_vec(&frame).unwrap());
            input.push(0);
        }
        super::super::transport::run_frame_reader(&mut Cursor::new(input), sender, state);
        let mut output = Vec::new();
        let mut client = CdpClient::new(&mut output, inbox);

        engine
            .preflight_handoff(
                &mut client,
                &origin(),
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();

        let commands = output
            .split(|byte| *byte == 0)
            .filter(|frame| !frame.is_empty())
            .map(|frame| serde_json::from_slice::<Value>(frame).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(commands.len(), 4);
        assert_eq!(commands[0]["method"], "Target.getTargets");
        assert!(commands[0].get("sessionId").is_none());
        assert_eq!(commands[1]["method"], "Page.getFrameTree");
        assert_eq!(commands[1]["sessionId"], "primary-session");
        assert_eq!(commands[2]["method"], "Target.getTargets");
        assert!(commands[2].get("sessionId").is_none());
        assert_eq!(commands[3]["method"], "Page.getFrameTree");
        assert_eq!(commands[3]["sessionId"], "primary-session");
    }

    #[test]
    fn embedded_owner_preflight_scopes_inventory_to_its_exact_cef_page() {
        let temp = tempfile::tempdir().unwrap();
        let mut engine = SemanticEngine::new_for_existing_target(
            Arc::new(AuditedAllow),
            CdpArtifactStore::new(temp.path().join("artifacts")).unwrap(),
            NetworkEventRecorder::new(
                temp.path().join("logs"),
                "session-embedded".to_string(),
                NetworkRedactionConfig::default(),
            )
            .unwrap(),
            ConsoleEventRecorder::new(
                temp.path().join("logs"),
                "session-embedded".to_string(),
                NetworkRedactionConfig::default(),
            )
            .unwrap(),
        );
        engine.primary_target = Some("primary-target".to_string());
        engine.primary_session = Some("primary-session".to_string());
        let target_info = serde_json::json!({
            "targetInfo": {
                "targetId": "primary-target",
                "type": "page",
                "url": "https://allowed.example/login",
                "attached": true
            }
        });
        let (sender, inbox, state) = super::super::transport::frame_channel();
        let mut input = Vec::new();
        for frame in [
            serde_json::json!({"id":1,"result":target_info}),
            serde_json::json!({"id":2,"result":frames(vec![])}),
            serde_json::json!({"id":3,"result":target_info}),
            serde_json::json!({"id":4,"result":frames(vec![])}),
        ] {
            input.extend_from_slice(&serde_json::to_vec(&frame).unwrap());
            input.push(0);
        }
        super::super::transport::run_frame_reader(&mut Cursor::new(input), sender, state);
        let mut output = Vec::new();
        let mut client = CdpClient::new(&mut output, inbox);

        engine
            .preflight_handoff(
                &mut client,
                &origin(),
                Instant::now() + Duration::from_secs(1),
            )
            .expect("another retained Browser in the Profile is outside this exact CEF page");

        let commands = output
            .split(|byte| *byte == 0)
            .filter(|frame| !frame.is_empty())
            .map(|frame| serde_json::from_slice::<Value>(frame).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(commands.len(), 4);
        assert_eq!(commands[0]["method"], "Target.getTargetInfo");
        assert_eq!(commands[0]["params"]["targetId"], "primary-target");
        assert_eq!(commands[1]["method"], "Page.getFrameTree");
        assert_eq!(commands[1]["sessionId"], "primary-session");
        assert_eq!(commands[2]["method"], "Target.getTargetInfo");
        assert_eq!(commands[2]["params"]["targetId"], "primary-target");
        assert_eq!(commands[3]["method"], "Page.getFrameTree");
        assert_eq!(commands[3]["sessionId"], "primary-session");
    }
}
