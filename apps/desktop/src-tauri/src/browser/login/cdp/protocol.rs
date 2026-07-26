use super::super::backend::{BackendFailure, BackendFailureCode};
use serde_json::Value;

const MAX_SESSION_ID_CHARS: usize = 256;

/// Closed production CDP allowlist. No external string can select a method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CdpMethod {
    TargetSetDiscoverTargets,
    TargetSetAutoAttach,
    TargetCreateTarget,
    TargetGetTargetInfo,
    TargetGetTargets,
    TargetAttachToTarget,
    TargetCloseTarget,
    PageEnable,
    PageSetInterceptFileChooserDialog,
    PageSetLifecycleEventsEnabled,
    PageGetFrameTree,
    PageGetNavigationHistory,
    PageNavigate,
    PageCaptureScreenshot,
    AccessibilityEnable,
    AccessibilityGetFullAxTree,
    DomEnable,
    DomFocus,
    DomGetBoxModel,
    InputDispatchMouseEvent,
    InputDispatchKeyEvent,
    InputInsertText,
    NetworkEnable,
    RuntimeEnable,
    FetchEnable,
    FetchContinueRequest,
    FetchFailRequest,
    RuntimeRunIfWaitingForDebugger,
    BrowserSetDownloadBehavior,
    BrowserClose,
}

impl CdpMethod {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::TargetSetDiscoverTargets => "Target.setDiscoverTargets",
            Self::TargetSetAutoAttach => "Target.setAutoAttach",
            Self::TargetCreateTarget => "Target.createTarget",
            Self::TargetGetTargetInfo => "Target.getTargetInfo",
            Self::TargetGetTargets => "Target.getTargets",
            Self::TargetAttachToTarget => "Target.attachToTarget",
            Self::TargetCloseTarget => "Target.closeTarget",
            Self::PageEnable => "Page.enable",
            Self::PageSetInterceptFileChooserDialog => "Page.setInterceptFileChooserDialog",
            Self::PageSetLifecycleEventsEnabled => "Page.setLifecycleEventsEnabled",
            Self::PageGetFrameTree => "Page.getFrameTree",
            Self::PageGetNavigationHistory => "Page.getNavigationHistory",
            Self::PageNavigate => "Page.navigate",
            Self::PageCaptureScreenshot => "Page.captureScreenshot",
            Self::AccessibilityEnable => "Accessibility.enable",
            Self::AccessibilityGetFullAxTree => "Accessibility.getFullAXTree",
            Self::DomEnable => "DOM.enable",
            Self::DomFocus => "DOM.focus",
            Self::DomGetBoxModel => "DOM.getBoxModel",
            Self::InputDispatchMouseEvent => "Input.dispatchMouseEvent",
            Self::InputDispatchKeyEvent => "Input.dispatchKeyEvent",
            Self::InputInsertText => "Input.insertText",
            Self::NetworkEnable => "Network.enable",
            Self::RuntimeEnable => "Runtime.enable",
            Self::FetchEnable => "Fetch.enable",
            Self::FetchContinueRequest => "Fetch.continueRequest",
            Self::FetchFailRequest => "Fetch.failRequest",
            Self::RuntimeRunIfWaitingForDebugger => "Runtime.runIfWaitingForDebugger",
            Self::BrowserSetDownloadBehavior => "Browser.setDownloadBehavior",
            Self::BrowserClose => "Browser.close",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CdpEventKind {
    TargetCreated,
    TargetAttached,
    TargetInfoChanged,
    TargetDestroyed,
    TargetDetached,
    TargetCrashed,
    FrameNavigated,
    FileChooserOpened,
    ConsoleApiCalled,
    DownloadWillBegin,
    DownloadProgress,
    LoadEventFired,
    LifecycleEvent,
    RequestWillBeSent,
    ResponseReceived,
    LoadingFinished,
    LoadingFailed,
    RequestPaused,
    Other,
}

#[derive(Debug)]
pub(super) struct CdpEvent {
    pub(super) kind: CdpEventKind,
    pub(super) params: Value,
    pub(super) session_id: Option<String>,
}

#[derive(Debug)]
pub(super) enum IncomingFrame {
    Response {
        id: u64,
        result: Result<Value, CdpCommandFailure>,
    },
    Event(CdpEvent),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct CdpCommandFailure;

pub(super) fn classify_frame(value: Value) -> Result<IncomingFrame, BackendFailure> {
    let Some(object) = value.as_object() else {
        return Err(protocol_failure());
    };
    let id = object.get("id").and_then(Value::as_u64);
    let method = object.get("method").and_then(Value::as_str);
    match (id, method) {
        (Some(id), None) if id > 0 => {
            let result = if object.contains_key("error") {
                Err(CdpCommandFailure)
            } else {
                Ok(object.get("result").cloned().unwrap_or(Value::Null))
            };
            Ok(IncomingFrame::Response { id, result })
        }
        (None, Some(method)) if method.len() <= 128 => {
            let session_id = match object.get("sessionId") {
                Some(Value::String(value)) if valid_session_id(value) => Some(value.clone()),
                Some(_) => return Err(protocol_failure()),
                None => None,
            };
            Ok(IncomingFrame::Event(CdpEvent {
                kind: classify_event(method),
                params: object.get("params").cloned().unwrap_or(Value::Null),
                session_id,
            }))
        }
        _ => Err(protocol_failure()),
    }
}

fn valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SESSION_ID_CHARS
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn classify_event(method: &str) -> CdpEventKind {
    match method {
        "Target.targetCreated" => CdpEventKind::TargetCreated,
        "Target.attachedToTarget" => CdpEventKind::TargetAttached,
        "Target.targetInfoChanged" => CdpEventKind::TargetInfoChanged,
        "Target.targetDestroyed" => CdpEventKind::TargetDestroyed,
        "Target.detachedFromTarget" => CdpEventKind::TargetDetached,
        "Target.targetCrashed" | "Inspector.targetCrashed" => CdpEventKind::TargetCrashed,
        "Page.frameNavigated" => CdpEventKind::FrameNavigated,
        "Page.fileChooserOpened" => CdpEventKind::FileChooserOpened,
        "Runtime.consoleAPICalled" => CdpEventKind::ConsoleApiCalled,
        "Browser.downloadWillBegin" => CdpEventKind::DownloadWillBegin,
        "Browser.downloadProgress" => CdpEventKind::DownloadProgress,
        "Page.loadEventFired" => CdpEventKind::LoadEventFired,
        "Page.lifecycleEvent" => CdpEventKind::LifecycleEvent,
        "Network.requestWillBeSent" => CdpEventKind::RequestWillBeSent,
        "Network.responseReceived" => CdpEventKind::ResponseReceived,
        "Network.loadingFinished" => CdpEventKind::LoadingFinished,
        "Network.loadingFailed" => CdpEventKind::LoadingFailed,
        "Fetch.requestPaused" => CdpEventKind::RequestPaused,
        _ => CdpEventKind::Other,
    }
}

pub(super) fn protocol_failure() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::ProtocolViolation,
        "Browser CDP protocol response was invalid.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_method_allowlist_has_only_the_fixed_runtime_resume_and_download_deny_surfaces() {
        let methods = [
            CdpMethod::TargetSetDiscoverTargets,
            CdpMethod::TargetSetAutoAttach,
            CdpMethod::TargetCreateTarget,
            CdpMethod::TargetGetTargets,
            CdpMethod::TargetAttachToTarget,
            CdpMethod::TargetCloseTarget,
            CdpMethod::PageEnable,
            CdpMethod::PageSetInterceptFileChooserDialog,
            CdpMethod::PageSetLifecycleEventsEnabled,
            CdpMethod::PageGetFrameTree,
            CdpMethod::PageGetNavigationHistory,
            CdpMethod::PageNavigate,
            CdpMethod::PageCaptureScreenshot,
            CdpMethod::AccessibilityEnable,
            CdpMethod::AccessibilityGetFullAxTree,
            CdpMethod::DomEnable,
            CdpMethod::DomFocus,
            CdpMethod::DomGetBoxModel,
            CdpMethod::InputDispatchMouseEvent,
            CdpMethod::InputDispatchKeyEvent,
            CdpMethod::InputInsertText,
            CdpMethod::NetworkEnable,
            CdpMethod::RuntimeEnable,
            CdpMethod::FetchEnable,
            CdpMethod::FetchContinueRequest,
            CdpMethod::FetchFailRequest,
            CdpMethod::RuntimeRunIfWaitingForDebugger,
            CdpMethod::BrowserSetDownloadBehavior,
            CdpMethod::BrowserClose,
        ]
        .map(CdpMethod::as_str);
        assert!(methods.contains(&"Browser.setDownloadBehavior"));
        assert_eq!(
            methods
                .iter()
                .copied()
                .filter(|method| method.starts_with("Runtime."))
                .collect::<Vec<_>>(),
            vec!["Runtime.enable", "Runtime.runIfWaitingForDebugger"]
        );
        assert!(!methods
            .iter()
            .any(|method| method.contains("evaluate") || method.contains("callFunction")));
    }

    #[test]
    fn incoming_raw_method_never_becomes_an_outgoing_capability() {
        let event = classify_frame(serde_json::json!({
            "method": "Runtime.evaluate",
            "params": {"expression": "secret"}
        }))
        .expect("unknown incoming events are safely ignorable");
        assert!(matches!(
            event,
            IncomingFrame::Event(CdpEvent {
                kind: CdpEventKind::Other,
                ..
            })
        ));
    }

    #[test]
    fn malformed_frames_fail_with_bounded_protocol_error() {
        for frame in [
            serde_json::json!([]),
            serde_json::json!({"id": 0, "result": {}}),
            serde_json::json!({"id": 1, "method": "Page.loadEventFired"}),
            serde_json::json!({"method": "Page.loadEventFired", "sessionId": "\n"}),
        ] {
            let error = classify_frame(frame).expect_err("malformed frame");
            assert_eq!(error.code, BackendFailureCode::ProtocolViolation);
            assert!(error.to_string().len() <= 128);
        }
    }

    #[test]
    fn lifecycle_events_retain_the_flat_session_for_loader_correlation() {
        let frame = classify_frame(serde_json::json!({
            "method": "Page.lifecycleEvent",
            "sessionId": "primary-session",
            "params": {
                "frameId": "main-frame",
                "loaderId": "loader-7",
                "name": "load"
            }
        }))
        .unwrap();
        assert!(matches!(
            frame,
            IncomingFrame::Event(CdpEvent {
                kind: CdpEventKind::LifecycleEvent,
                session_id: Some(session_id),
                ..
            }) if session_id == "primary-session"
        ));
    }

    #[test]
    fn both_production_crash_notifications_are_closed_target_crash_events() {
        let target_crash = classify_frame(serde_json::json!({
            "method": "Target.targetCrashed",
            "params": {
                "targetId": "secondary-target",
                "status": "crashed",
                "errorCode": 5
            }
        }))
        .unwrap();
        assert!(matches!(
            target_crash,
            IncomingFrame::Event(CdpEvent {
                kind: CdpEventKind::TargetCrashed,
                session_id: None,
                ..
            })
        ));

        let inspector_crash = classify_frame(serde_json::json!({
            "method": "Inspector.targetCrashed",
            "sessionId": "primary-session",
            "params": {}
        }))
        .unwrap();
        assert!(matches!(
            inspector_crash,
            IncomingFrame::Event(CdpEvent {
                kind: CdpEventKind::TargetCrashed,
                session_id: Some(session_id),
                ..
            }) if session_id == "primary-session"
        ));
    }

    #[test]
    fn file_chooser_events_are_classified_with_the_flat_target_session() {
        let frame = classify_frame(serde_json::json!({
            "method": "Page.fileChooserOpened",
            "sessionId": "primary-session",
            "params": {
                "frameId": "main-frame",
                "mode": "selectSingle",
                "backendNodeId": 42
            }
        }))
        .unwrap();
        let IncomingFrame::Event(event) = frame else {
            panic!("file chooser notification must be an event");
        };
        assert_eq!(event.kind, CdpEventKind::FileChooserOpened);
        assert_eq!(event.session_id.as_deref(), Some("primary-session"));
    }

    #[test]
    fn console_and_download_events_are_classified_without_promoting_raw_payloads() {
        for (method, expected) in [
            ("Runtime.consoleAPICalled", CdpEventKind::ConsoleApiCalled),
            ("Browser.downloadWillBegin", CdpEventKind::DownloadWillBegin),
            ("Browser.downloadProgress", CdpEventKind::DownloadProgress),
        ] {
            let frame = classify_frame(serde_json::json!({
                "method": method,
                "params": {"guid":"raw-guid","suggestedFilename":"secret.txt"}
            }))
            .unwrap();
            assert!(matches!(
                frame,
                IncomingFrame::Event(CdpEvent { kind, .. }) if kind == expected
            ));
        }
    }
}
