//! Handoff regressions with a live helper and the production output/exit handlers.
use super::*;
use std::sync::mpsc;

struct HandoffFixture {
    manager: Arc<NativeRuntimeManager>,
    handle: Arc<NativeSessionHandle>,
    runtime_id: String,
    pump_done: mpsc::Receiver<()>,
    preparations: Arc<AtomicU64>,
    continuations: Arc<AtomicU64>,
}

impl HandoffFixture {
    fn new(name: &str, mode: &str) -> Self {
        let manager = Arc::new(super::tests::manager_with_handle(name));
        manager
            .update_record(name, |record| {
                record.status = "ready".into();
                record.provider_session_id = Some(format!("provider-{name}"));
            })
            .unwrap();
        let handle = manager.handles.lock().unwrap()[name].clone();
        let mut command = StdCommand::new("/usr/bin/python3");
        command.args(["-u", "-c", r#"
import json, sys, time
mode = sys.argv[1]
def output(detail):
    print(json.dumps({'type': 'status', 'status': 'ready', 'detail': detail}), flush=True)
for line in sys.stdin:
    cmd = json.loads(line)
    kind = cmd['type']
    if kind == 'prepare_stop':
        output('ordinary output before prepare ACK')
        print('ordinary stderr before prepare ACK', file=sys.stderr, flush=True)
        if mode == 'slow':
            time.sleep(0.3)
        if mode == 'silent' or (mode == 'silent_finalize' and cmd['finalize']):
            continue
        ready = not (mode == 'reject' or (mode == 'reject_finalize' and cmd['finalize']))
        print(json.dumps({'type': 'teardown_prepared', 'request_id': cmd['request_id'],
                          'ready': ready, 'detail': 'fixture rejected close' if not ready else None}), flush=True)
    elif kind == 'cancel_prepare_stop':
        output('prepare cancelled')
    elif kind == 'prompt':
        output('continued: ' + cmd['text'])
    elif kind == 'stop':
        output('ordinary output before exit')
        if mode == 'ignore_stop':
            continue
        if mode == 'error_stop':
            print(json.dumps({'type': 'status', 'status': 'error', 'detail': 'fixture stop error'}), flush=True)
            continue
        break
"#, mode]);
        let (mut events, child) = spawn_native_helper_process(command).unwrap();
        *handle.child.lock().unwrap() = Some(child);
        let pump_manager = Arc::clone(&manager);
        let pump_handle = Arc::clone(&handle);
        let runtime_id = name.to_owned();
        let pump_runtime = runtime_id.clone();
        let preparations = Arc::new(AtomicU64::new(0));
        let pump_preparations = Arc::clone(&preparations);
        let continuations = Arc::new(AtomicU64::new(0));
        let pump_continuations = Arc::clone(&continuations);
        let (done, pump_done) = mpsc::channel();
        std::thread::spawn(move || {
            tauri::async_runtime::block_on(async {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            for line in drain_helper_output_lines(&mut stdout, &bytes) {
                                if line.contains("teardown_prepared") {
                                    pump_preparations.fetch_add(1, Ordering::SeqCst);
                                }
                                pump_manager
                                    .process_helper_stdout_if_current(
                                        None,
                                        &pump_runtime,
                                        &line,
                                        &pump_handle,
                                    )
                                    .unwrap();
                                if line.contains("continued:") {
                                    pump_continuations.fetch_add(1, Ordering::SeqCst);
                                }
                            }
                        }
                        CommandEvent::Stderr(bytes) => {
                            for line in drain_helper_output_lines(&mut stderr, &bytes) {
                                pump_manager
                                    .append_event_if_current(
                                        &pump_runtime,
                                        SessionEventPayload::StdErrLine { line },
                                        &pump_handle,
                                    )
                                    .unwrap();
                            }
                        }
                        CommandEvent::Terminated(payload) => {
                            pump_manager.flush_helper_output_buffers(
                                None,
                                &pump_runtime,
                                &mut stdout,
                                &mut stderr,
                                &pump_handle,
                            );
                            pump_manager
                                .mark_process_exit(&pump_runtime, payload.code, &pump_handle)
                                .unwrap();
                            break;
                        }
                        CommandEvent::Error(error) => panic!("fixture helper: {error}"),
                        _ => {}
                    }
                }
            });
            let _ = done.send(());
        });
        Self {
            manager,
            handle,
            runtime_id,
            pump_done,
            preparations,
            continuations,
        }
    }

    fn assert_can_continue(&self) {
        assert!(self.handle.alive.load(Ordering::SeqCst));
        assert!(self
            .manager
            .is_current_handle(&self.runtime_id, &self.handle)
            .unwrap());
        assert!(self
            .manager
            .terminal_handoff_preparations
            .lock()
            .unwrap()
            .is_empty());
        self.manager
            .write_to_live_child(
                &self.handle,
                &HelperInputCommand::Prompt {
                    text: "after failed handoff",
                    command_id: None,
                    images: None,
                },
            )
            .unwrap();
        wait_until(|| self.continuations.load(Ordering::SeqCst) > 0);
    }
}

fn wait_until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !predicate() {
        assert!(Instant::now() < deadline, "condition did not settle");
        std::thread::sleep(Duration::from_millis(10));
    }
}

impl Drop for HandoffFixture {
    fn drop(&mut self) {
        if let Some(child) = self.handle.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        let _ = self.pump_done.recv_timeout(Duration::from_secs(3));
    }
}

#[test]
fn managed_handoff_drains_output_before_both_acks_and_exit() {
    let fixture = HandoffFixture::new("handoff-live-acks", "ready");
    let started = Instant::now();
    let mut launches = 0;
    let result = fixture.manager.run_managed_terminal_handoff(
        &fixture.runtime_id,
        Some(TerminalType::TerminalApp),
        false,
        |handoff| {
            launches += 1;
            assert_eq!(handoff.resume_session_id, "provider-handoff-live-acks");
            Ok(())
        },
        |_| panic!("successful launch should not be rolled back"),
    );
    assert!(result.is_ok(), "handoff failed: {result:?}");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "handoff exhausted a grace timeout"
    );
    assert_eq!(launches, 1);
    assert_eq!(fixture.preparations.load(Ordering::SeqCst), 2);
    assert_eq!(
        fixture
            .manager
            .current_record(&fixture.runtime_id)
            .unwrap()
            .status,
        "handoff"
    );
    assert!(!fixture
        .manager
        .handles
        .lock()
        .unwrap()
        .contains_key(&fixture.runtime_id));
    assert!(fixture
        .manager
        .terminal_handoff_preparations
        .lock()
        .unwrap()
        .is_empty());
}

#[test]
fn managed_handoff_launch_failure_keeps_the_source_usable_and_retryable() {
    let fixture = HandoffFixture::new("handoff-retry", "ready");
    let error = fixture
        .manager
        .run_managed_terminal_handoff(
            &fixture.runtime_id,
            Some(TerminalType::TerminalApp),
            false,
            |_| Err::<(), _>("terminal launch failed".to_string()),
            |_| {},
        )
        .unwrap_err();
    assert_eq!(error, "terminal launch failed");
    fixture.assert_can_continue();
    fixture
        .manager
        .run_managed_terminal_handoff(
            &fixture.runtime_id,
            Some(TerminalType::TerminalApp),
            false,
            |_| Ok(()),
            |_| panic!("retry should succeed"),
        )
        .unwrap();
    assert_eq!(
        fixture
            .manager
            .current_record(&fixture.runtime_id)
            .unwrap()
            .status,
        "handoff"
    );
}

#[test]
fn managed_handoff_rejection_at_either_ack_rolls_back_only_what_launched() {
    for (mode, expected_launches) in [("reject", 0), ("reject_finalize", 1)] {
        let fixture = HandoffFixture::new(&format!("handoff-{mode}"), mode);
        let launches = AtomicU64::new(0);
        let cleanups = AtomicU64::new(0);
        let error = fixture
            .manager
            .run_managed_terminal_handoff(
                &fixture.runtime_id,
                Some(TerminalType::TerminalApp),
                false,
                |_| {
                    launches.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
                |_| {
                    cleanups.fetch_add(1, Ordering::SeqCst);
                },
            )
            .unwrap_err();
        assert!(error.contains("fixture rejected close"), "{error}");
        assert_eq!(launches.load(Ordering::SeqCst), expected_launches);
        assert_eq!(cleanups.load(Ordering::SeqCst), expected_launches);
        fixture.assert_can_continue();
    }
}

#[test]
fn managed_handoff_timeout_at_either_ack_is_bounded_and_recoverable() {
    for mode in ["silent", "silent_finalize"] {
        let fixture = HandoffFixture::new(&format!("handoff-{mode}"), mode);
        let started = Instant::now();
        let error = fixture
            .manager
            .run_managed_terminal_handoff(
                &fixture.runtime_id,
                Some(TerminalType::TerminalApp),
                false,
                |_| Ok(()),
                |_| {},
            )
            .unwrap_err();
        assert!(error.contains("before the deadline"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(12));
        fixture.assert_can_continue();
    }
}

#[test]
fn handoff_reservation_fences_reconnect_while_the_output_pump_remains_available() {
    let fixture = HandoffFixture::new("handoff-wait-fence", "slow");
    let manager = fixture.manager.clone();
    let runtime = fixture.runtime_id.clone();
    let worker = std::thread::spawn(move || {
        manager.run_managed_terminal_handoff(
            &runtime,
            Some(TerminalType::TerminalApp),
            false,
            |_| Ok(()),
            |_| {},
        )
    });
    wait_until(|| {
        fixture
            .manager
            .terminal_handoff_preparations
            .lock()
            .unwrap()
            .contains_key(&fixture.runtime_id)
    });
    {
        let _coordinator = fixture.manager.reconnect_lock.lock().unwrap();
        let result =
            fixture
                .manager
                .prepare_reconnect_handle_locked(&fixture.runtime_id, false, None);
        assert!(
            matches!(result, Err(ref error) if error.contains("preparing to continue in Terminal"))
        );
        assert!(fixture
            .manager
            .is_current_handle(&fixture.runtime_id, &fixture.handle)
            .unwrap());
    }
    assert!(worker.join().unwrap().is_ok());
}

#[test]
fn old_handoff_ack_cancel_and_exit_cannot_revive_or_remove_a_successor() {
    let fixture = HandoffFixture::new("handoff-stale-owner", "slow");
    let manager = fixture.manager.clone();
    let runtime = fixture.runtime_id.clone();
    let worker = std::thread::spawn(move || {
        manager.run_managed_terminal_handoff(
            &runtime,
            Some(TerminalType::TerminalApp),
            false,
            |_| panic!("stale preparation must not open a terminal"),
            |_: &()| {},
        )
    });
    wait_until(|| {
        fixture
            .manager
            .terminal_handoff_preparations
            .lock()
            .unwrap()
            .contains_key(&fixture.runtime_id)
    });
    let (old_request, successor) = {
        let _coordinator = fixture.manager.reconnect_lock.lock().unwrap();
        let request = fixture
            .manager
            .terminal_handoff_preparations
            .lock()
            .unwrap()[&fixture.runtime_id]
            .request_id
            .clone();
        let mut record = fixture.manager.current_record(&fixture.runtime_id).unwrap();
        record.provider_session_id = Some("successor-session".into());
        let successor = super::tests::native_session_handle_with_generation(record.clone(), 2);
        successor.alive.store(false, Ordering::SeqCst);
        // Fault injection deliberately bypasses the public reconnect fence.
        fixture
            .manager
            .handles
            .lock()
            .unwrap()
            .insert(fixture.runtime_id.clone(), successor.clone());
        fixture
            .manager
            .update_record(&fixture.runtime_id, |entry| *entry = record)
            .unwrap();
        (request, successor)
    };
    assert!(worker.join().unwrap().is_err());
    fixture
        .manager
        .process_helper_stdout_if_current(
            None,
            &fixture.runtime_id,
            &format!(r#"{{"type":"teardown_prepared","request_id":"{old_request}","ready":true}}"#),
            &fixture.handle,
        )
        .unwrap();
    fixture
        .manager
        .mark_process_exit(&fixture.runtime_id, Some(0), &fixture.handle)
        .unwrap();
    fixture
        .manager
        .cancel_terminal_handoff_preparation(&fixture.runtime_id, Some(&old_request));
    assert!(fixture
        .manager
        .is_current_handle(&fixture.runtime_id, &successor)
        .unwrap());
    assert!(!successor.alive.load(Ordering::SeqCst));
    assert_eq!(
        fixture
            .manager
            .current_record(&fixture.runtime_id)
            .unwrap()
            .provider_session_id
            .as_deref(),
        Some("successor-session")
    );
    assert!(successor.teardown_preparations.lock().unwrap().is_empty());
}

#[test]
fn pending_handoff_finishes_off_the_pump_and_ignores_duplicate_session_meta() {
    let fixture = HandoffFixture::new("handoff-deferred", "slow");
    fixture
        .manager
        .update_record(&fixture.runtime_id, |record| {
            record.provider_session_id = None
        })
        .unwrap();
    let pending = fixture
        .manager
        .handoff_to_terminal(&fixture.runtime_id, Some(TerminalType::TerminalApp), false)
        .unwrap();
    assert_eq!(pending.status, NativeHandoffStatus::Pending);
    let metadata = r#"{"type":"session_meta","provider_session_id":"deferred-provider-session"}"#;
    // Use the guarded production handler, not the synchronous test shortcut.
    fixture
        .manager
        .process_helper_stdout_if_current(None, &fixture.runtime_id, metadata, &fixture.handle)
        .unwrap();
    fixture
        .manager
        .process_helper_stdout_if_current(None, &fixture.runtime_id, metadata, &fixture.handle)
        .unwrap();
    wait_until(|| {
        fixture
            .manager
            .current_record(&fixture.runtime_id)
            .unwrap()
            .status
            == "handoff"
    });
    wait_until(|| {
        !fixture
            .manager
            .terminal_handoff_preparations
            .lock()
            .unwrap()
            .contains_key(&fixture.runtime_id)
    });
    assert_eq!(
        fixture.preparations.load(Ordering::SeqCst),
        1,
        "duplicate metadata must not re-send prepare"
    );
    let events = fixture
        .manager
        .replay_events(&fixture.runtime_id, None)
        .unwrap()
        .events;
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(&event.payload,
        SessionEventPayload::Lifecycle { stage, .. } if stage == "handoff"))
            .count(),
        1
    );
}

#[test]
fn pending_handoff_exit_before_session_meta_releases_the_reconnect_fence() {
    let fixture = HandoffFixture::new("handoff-pending-exit", "ready");
    fixture
        .manager
        .update_record(&fixture.runtime_id, |record| {
            record.provider_session_id = None
        })
        .unwrap();
    fixture
        .manager
        .handoff_to_terminal(&fixture.runtime_id, Some(TerminalType::TerminalApp), false)
        .unwrap();
    assert!(fixture
        .manager
        .reject_reconnect_during_handoff(&fixture.runtime_id)
        .is_err());
    fixture
        .handle
        .child
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .kill()
        .unwrap();
    wait_until(|| {
        !fixture
            .manager
            .is_current_handle(&fixture.runtime_id, &fixture.handle)
            .unwrap()
    });
    assert!(fixture
        .manager
        .reject_reconnect_during_handoff(&fixture.runtime_id)
        .is_ok());
    assert!(fixture
        .manager
        .terminal_handoff_preparations
        .lock()
        .unwrap()
        .is_empty());
    assert_eq!(
        fixture
            .manager
            .current_record(&fixture.runtime_id)
            .unwrap()
            .pending_handoff_terminal,
        None
    );
}

#[test]
fn pending_handoff_error_before_session_meta_releases_the_reconnect_fence() {
    let fixture = HandoffFixture::new("handoff-pending-error", "ready");
    fixture
        .manager
        .update_record(&fixture.runtime_id, |record| {
            record.provider_session_id = None
        })
        .unwrap();
    fixture
        .manager
        .handoff_to_terminal(&fixture.runtime_id, Some(TerminalType::TerminalApp), false)
        .unwrap();
    fixture
        .manager
        .process_helper_stdout_if_current(
            None,
            &fixture.runtime_id,
            r#"{"type":"status","status":"error","detail":"fixture initialization failed"}"#,
            &fixture.handle,
        )
        .unwrap();
    assert!(!fixture
        .manager
        .is_current_handle(&fixture.runtime_id, &fixture.handle)
        .unwrap());
    assert!(fixture
        .manager
        .reject_reconnect_during_handoff(&fixture.runtime_id)
        .is_ok());
}

#[test]
fn managed_handoff_retires_only_its_helper_when_stop_does_not_exit() {
    let fixture = HandoffFixture::new("handoff-stop-timeout", "ignore_stop");
    let started = Instant::now();
    fixture
        .manager
        .run_managed_terminal_handoff(
            &fixture.runtime_id,
            Some(TerminalType::TerminalApp),
            false,
            |_| Ok(()),
            |_| panic!("owned helper timeout should still finalize the handoff"),
        )
        .unwrap();
    assert!(started.elapsed() >= NATIVE_STOP_GRACE_PERIOD);
    assert!(started.elapsed() < Duration::from_secs(13));
    assert!(fixture.handle.child.lock().unwrap().is_none());
    assert!(!fixture
        .manager
        .handles
        .lock()
        .unwrap()
        .contains_key(&fixture.runtime_id));
    assert!(fixture
        .manager
        .terminal_handoff_preparations
        .lock()
        .unwrap()
        .is_empty());
}

#[test]
fn managed_handoff_error_during_stop_clears_reservation_and_rolls_back_terminal() {
    let fixture = HandoffFixture::new("handoff-stop-error", "error_stop");
    let cleanups = AtomicU64::new(0);
    let result = fixture.manager.run_managed_terminal_handoff(
        &fixture.runtime_id,
        Some(TerminalType::TerminalApp),
        false,
        |_| Ok(()),
        |_| {
            cleanups.fetch_add(1, Ordering::SeqCst);
        },
    );
    assert!(result.is_err());
    assert_eq!(cleanups.load(Ordering::SeqCst), 1);
    assert!(fixture
        .manager
        .terminal_handoff_preparations
        .lock()
        .unwrap()
        .is_empty());
    assert!(!fixture
        .manager
        .handles
        .lock()
        .unwrap()
        .contains_key(&fixture.runtime_id));
}
