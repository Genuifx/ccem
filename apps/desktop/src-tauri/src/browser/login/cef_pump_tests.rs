use super::cef::pump::{schedule_action, CefExternalPump, ScheduleAction, TIMER_DELAY_PLACEHOLDER};

#[test]
fn cef_external_pump_runs_immediate_work_and_caps_delayed_work() {
    assert_eq!(schedule_action(0, false), ScheduleAction::RunNow);
    assert_eq!(schedule_action(-1, true), ScheduleAction::RunNow);
    assert_eq!(schedule_action(1, false), ScheduleAction::ReplaceTimer(1));
    assert_eq!(
        schedule_action(500, false),
        ScheduleAction::ReplaceTimer(33)
    );
}

#[test]
fn cef_external_pump_does_not_displace_an_existing_fallback_tick() {
    assert_eq!(
        schedule_action(TIMER_DELAY_PLACEHOLDER, true),
        ScheduleAction::KeepTimer
    );
    assert_eq!(
        schedule_action(TIMER_DELAY_PLACEHOLDER, false),
        ScheduleAction::ReplaceTimer(33)
    );
}

#[test]
fn cef_external_pump_has_an_explicit_drain_and_stop_gate() {
    let pump = CefExternalPump::new();
    assert_eq!(pump.phase_name(), "running");

    pump.begin_draining();
    assert_eq!(pump.phase_name(), "draining");

    pump.stop();
    assert_eq!(pump.phase_name(), "stopped");

    // This must be a no-op and must not call into an uninitialized CEF table.
    pump.do_message_loop_work();
}
