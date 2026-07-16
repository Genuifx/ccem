use super::super::super::control::{HandoffControl, HandoffGrant, LoginBrowserControl};
use super::super::super::network::NetworkRedactionConfig;
use super::super::super::policy::BrowserGrantBinding;
use super::super::guard::{
    TrustedNavigationDecision, TrustedNavigationRequest, TrustedNavigationSurface,
};
use super::super::owner_protocol::OwnerTerminalTermination;
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;

struct DenyRedirectGuard;

struct NoopTermination;

impl OwnerTerminalTermination for NoopTermination {
    fn request_terminal_shutdown(&self) -> Result<(), BackendFailure> {
        Ok(())
    }
}

impl TrustedNavigationGuard for DenyRedirectGuard {
    fn authorize(&self, request: TrustedNavigationRequest<'_>) -> TrustedNavigationDecision {
        if request.surface() != TrustedNavigationSurface::AgentNavigation
            && request.target_url().contains("denied")
        {
            TrustedNavigationDecision::deny("origin_not_granted")
        } else {
            TrustedNavigationDecision::allow("allowed")
        }
    }
}

fn cancellation() -> (Arc<LoginBrowserControl>, OperationCancellation) {
    let binding = BrowserGrantBinding::new_trusted("w", "p", "s", 1).unwrap();
    let control = Arc::new(LoginBrowserControl::new());
    control
        .activate_handoff(HandoffGrant::new_trusted(binding.clone()))
        .unwrap();
    let token = control.begin_operation(&binding, true).unwrap();
    (control, token)
}

fn test_engine(temp: &tempfile::TempDir) -> SemanticEngine {
    SemanticEngine::new(
        Arc::new(DenyRedirectGuard),
        CdpArtifactStore::new(temp.path().join("artifacts")).unwrap(),
        NetworkEventRecorder::new(
            temp.path().join("network"),
            "session-1".to_string(),
            NetworkRedactionConfig::default(),
        )
        .unwrap(),
        ConsoleEventRecorder::new(
            temp.path().join("network"),
            "session-1".to_string(),
            NetworkRedactionConfig::default(),
        )
        .unwrap(),
    )
}

fn write_frame(stream: &mut UnixStream, value: Value) {
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(0);
    stream.write_all(&bytes).unwrap();
    stream.flush().unwrap();
}

fn read_frame(reader: &mut BufReader<UnixStream>) -> Value {
    let mut bytes = Vec::new();
    reader.read_until(0, &mut bytes).unwrap();
    assert_eq!(bytes.pop(), Some(0));
    serde_json::from_slice(&bytes).unwrap()
}

#[test]
fn real_duplex_fixture_conforms_for_ax_refs_input_and_redirect_guard() {
    let temp = tempfile::tempdir().unwrap();
    let (owner_stream, peer_stream) = UnixStream::pair().unwrap();
    let mut owner_reader = owner_stream.try_clone().unwrap();
    let mut owner_writer = owner_stream;
    let mut peer_reader = BufReader::new(peer_stream.try_clone().unwrap());
    let mut peer_writer = peer_stream;
    let (request_tx, request_rx) = mpsc::sync_channel(4);
    let (_transition, transition_inbox) = owner_transition_channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let owner_shutdown = Arc::clone(&shutdown);
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let owner_projection = Arc::new(RwLock::new(ChromiumOwnerProjection::default()));
    let owner = thread::spawn(move || {
        let mut engine = Some(test_engine(&temp));
        let mut ready = Some(ready_tx);
        run_protocol_owner(
            &mut owner_reader,
            &mut owner_writer,
            &mut engine,
            &request_rx,
            &transition_inbox,
            &owner_shutdown,
            &NoopTermination,
            &mut ready,
            &owner_projection,
        )
    });
    let peer = thread::spawn(move || {
        let mut saw_fail_before_continue = false;
        let mut saw_target_close = false;
        let mut sent_popup = false;
        let mut pending_navigation = None;
        let mut methods = Vec::new();
        loop {
            let command = read_frame(&mut peer_reader);
            let id = command["id"].as_u64().unwrap();
            let method = command["method"].as_str().unwrap();
            methods.push(method.to_string());
            let result = match method {
                "Target.createTarget" => serde_json::json!({"targetId":"target-1"}),
                "Target.getTargets" => serde_json::json!({
                    "targetInfos":[{"targetId":"target-1","type":"page","url":"about:blank"}]
                }),
                "Target.attachToTarget" => serde_json::json!({"sessionId":"session-1"}),
                "Page.getNavigationHistory" => serde_json::json!({
                    "currentIndex":0,
                    "entries":[{"url":"about:blank","title":""}]
                }),
                "Accessibility.getFullAXTree" => serde_json::json!({
                    "nodes":[{
                        "nodeId":"ax-internal",
                        "ignored":false,
                        "role":{"value":"button"},
                        "name":{"value":"Continue"},
                        "backendDOMNodeId":4242
                    }]
                }),
                "DOM.getBoxModel" => serde_json::json!({
                    "model":{"content":[0,0,20,0,20,10,0,10]}
                }),
                "Page.captureScreenshot" => serde_json::json!({
                    "data": STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture")
                }),
                "Page.navigate" => {
                    pending_navigation = Some(id);
                    write_frame(
                        &mut peer_writer,
                        serde_json::json!({
                            "method":"Fetch.requestPaused",
                            "sessionId":"session-1",
                            "params":{
                                "requestId":"fetch-1",
                                "resourceType":"Document",
                                "frameId":"main-frame",
                                "request":{"url":"https://denied.example/"}
                            }
                        }),
                    );
                    continue;
                }
                "Fetch.failRequest" => {
                    saw_fail_before_continue = true;
                    serde_json::json!({})
                }
                "Fetch.continueRequest" => panic!("denied redirect was continued"),
                "Target.closeTarget" => {
                    saw_target_close = true;
                    serde_json::json!({"success":true})
                }
                "Browser.close" => {
                    write_frame(&mut peer_writer, serde_json::json!({"id":id,"result":{}}));
                    break;
                }
                _ => serde_json::json!({}),
            };
            write_frame(
                &mut peer_writer,
                serde_json::json!({"id":id,"result":result}),
            );
            if method == "Page.getNavigationHistory" && !sent_popup {
                sent_popup = true;
                write_frame(
                    &mut peer_writer,
                    serde_json::json!({
                        "method":"Target.targetCreated",
                        "params":{"targetInfo":{
                            "targetId":"popup-denied",
                            "type":"page",
                            "url":"https://denied.example/popup"
                        }}
                    }),
                );
            }
            if method == "Fetch.failRequest" {
                let navigation_id = pending_navigation.take().unwrap();
                write_frame(
                    &mut peer_writer,
                    serde_json::json!({"id":navigation_id,"result":{"frameId":"main-frame"}}),
                );
            }
        }
        (saw_fail_before_continue, saw_target_close, methods)
    });
    ready_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    let (_control, token) = cancellation();
    let (response_tx, response_rx) = mpsc::sync_channel(1);
    request_tx
        .send(OwnerRequest::Execute {
            command: SemanticBrowserCommand::ReadPage,
            cancellation: token.clone(),
            deadline: Instant::now() + Duration::from_secs(2),
            response: response_tx,
        })
        .unwrap();
    let page = response_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    let element_ref = match page {
        SemanticBrowserResult::StructuredPage(page) => {
            assert_eq!(page.elements.len(), 1);
            page.elements[0].element_ref.clone()
        }
        other => panic!("unexpected result: {other:?}"),
    };
    assert!(!element_ref.contains("4242"));
    let (response_tx, response_rx) = mpsc::sync_channel(1);
    request_tx
        .send(OwnerRequest::Execute {
            command: SemanticBrowserCommand::Click {
                element_ref: element_ref.clone(),
            },
            cancellation: token.clone(),
            deadline: Instant::now() + Duration::from_secs(2),
            response: response_tx,
        })
        .unwrap();
    response_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    let (response_tx, response_rx) = mpsc::sync_channel(1);
    request_tx
        .send(OwnerRequest::Execute {
            command: SemanticBrowserCommand::Type {
                element_ref: element_ref.clone(),
                text: "typed without evaluate".to_string(),
                replace: true,
            },
            cancellation: token.clone(),
            deadline: Instant::now() + Duration::from_secs(2),
            response: response_tx,
        })
        .unwrap();
    response_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    let (response_tx, response_rx) = mpsc::sync_channel(1);
    request_tx
        .send(OwnerRequest::Execute {
            command: SemanticBrowserCommand::Screenshot,
            cancellation: token.clone(),
            deadline: Instant::now() + Duration::from_secs(2),
            response: response_tx,
        })
        .unwrap();
    match response_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap()
    {
        SemanticBrowserResult::Screenshot(result) => {
            assert!(result.artifact_id.starts_with("shot-"));
            assert_eq!(result.sha256.len(), 64);
        }
        other => panic!("unexpected result: {other:?}"),
    }
    let (response_tx, response_rx) = mpsc::sync_channel(1);
    request_tx
        .send(OwnerRequest::Execute {
            command: SemanticBrowserCommand::Navigate {
                url: "https://allowed.example/".to_string(),
            },
            cancellation: token.clone(),
            deadline: Instant::now() + Duration::from_secs(2),
            response: response_tx,
        })
        .unwrap();
    response_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    let (response_tx, response_rx) = mpsc::sync_channel(1);
    request_tx
        .send(OwnerRequest::Execute {
            command: SemanticBrowserCommand::Click { element_ref },
            cancellation: token,
            deadline: Instant::now() + Duration::from_secs(2),
            response: response_tx,
        })
        .unwrap();
    assert_eq!(
        response_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap_err()
            .code,
        BackendFailureCode::InvalidSemanticReference
    );
    shutdown.store(true, Ordering::Release);
    request_tx.send(OwnerRequest::Shutdown).unwrap();
    owner.join().unwrap().unwrap();
    let (saw_fail, saw_target_close, methods) = peer.join().unwrap();
    assert!(saw_fail);
    assert!(saw_target_close);
    let runtime_methods = methods
        .iter()
        .filter(|method| method.starts_with("Runtime."))
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        runtime_methods,
        std::collections::BTreeSet::from(["Runtime.enable", "Runtime.runIfWaitingForDebugger",])
    );
    assert!(!methods
        .iter()
        .any(|method| method.contains("evaluate") || method.contains("callFunction")));
}

#[test]
fn active_wait_cancellation_reaches_owner_in_under_one_second() {
    let temp = tempfile::tempdir().unwrap();
    let (owner_stream, peer_stream) = UnixStream::pair().unwrap();
    let mut owner_reader = owner_stream.try_clone().unwrap();
    let mut owner_writer = owner_stream;
    let mut peer_reader = BufReader::new(peer_stream.try_clone().unwrap());
    let mut peer_writer = peer_stream;
    let (request_tx, request_rx) = mpsc::sync_channel(4);
    let (_transition, transition_inbox) = owner_transition_channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let owner_shutdown = Arc::clone(&shutdown);
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let owner_projection = Arc::new(RwLock::new(ChromiumOwnerProjection::default()));
    let owner = thread::spawn(move || {
        let mut engine = Some(test_engine(&temp));
        let mut ready = Some(ready_tx);
        run_protocol_owner(
            &mut owner_reader,
            &mut owner_writer,
            &mut engine,
            &request_rx,
            &transition_inbox,
            &owner_shutdown,
            &NoopTermination,
            &mut ready,
            &owner_projection,
        )
    });
    let peer = thread::spawn(move || loop {
        let command = read_frame(&mut peer_reader);
        let id = command["id"].as_u64().unwrap();
        let result = match command["method"].as_str().unwrap() {
            "Target.createTarget" => serde_json::json!({"targetId":"target-1"}),
            "Target.getTargets" => serde_json::json!({
                "targetInfos":[{"targetId":"target-1","type":"page","url":"about:blank"}]
            }),
            "Target.attachToTarget" => serde_json::json!({"sessionId":"session-1"}),
            "Page.getNavigationHistory" => serde_json::json!({
                "currentIndex":0,
                "entries":[{"url":"about:blank","title":""}]
            }),
            "Browser.close" => {
                write_frame(&mut peer_writer, serde_json::json!({"id":id,"result":{}}));
                break;
            }
            _ => serde_json::json!({}),
        };
        write_frame(
            &mut peer_writer,
            serde_json::json!({"id":id,"result":result}),
        );
    });
    ready_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    let (control, token) = cancellation();
    let (response_tx, response_rx) = mpsc::sync_channel(1);
    request_tx
        .send(OwnerRequest::Execute {
            command: SemanticBrowserCommand::WaitFor {
                condition: super::super::super::backend::SemanticWaitCondition::LoadComplete,
                timeout_millis: 5_000,
            },
            cancellation: token,
            deadline: Instant::now() + Duration::from_secs(5),
            response: response_tx,
        })
        .unwrap();
    std::thread::sleep(Duration::from_millis(25));
    let started = Instant::now();
    control.cancel_active();
    assert_eq!(
        response_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap_err()
            .code,
        BackendFailureCode::Cancelled
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    shutdown.store(true, Ordering::Release);
    request_tx.send(OwnerRequest::Shutdown).unwrap();
    owner.join().unwrap().unwrap();
    peer.join().unwrap();
}

#[test]
fn screenshot_fixture_payload_is_bounded_png_base64() {
    let png = b"\x89PNG\r\n\x1a\nfixture";
    let encoded = STANDARD.encode(png);
    assert!(encoded.len() < 128);
}
