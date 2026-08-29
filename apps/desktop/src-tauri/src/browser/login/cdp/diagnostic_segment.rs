use super::super::backend::{BackendFailure, BackendFailureCode};
use super::protocol::CdpMethod;
use super::semantics::SemanticEngine;
use super::transport::{CdpClient, NeverCancelled};
use rand::{rngs::OsRng, RngCore};
use std::time::Instant;

const SEGMENT_PREFIX: &str = "diag-";
const SEGMENT_RANDOM_BYTES: usize = 16;
const MAX_CDP_SESSION_ID_BYTES: usize = 256;
const DRAIN_BURST: usize = 64;
const MAX_DISABLED_BARRIER_FRAMES: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DiagnosticSegmentError;

/// Owner-thread-only lifecycle gate for handoff-scoped diagnostics.
///
/// The random live id is never returned to an Agent. Reads expose only immutable snapshot ids.
/// Keeping the previous epoch after `stop` prevents an old handoff from reopening a live segment.
pub(super) struct DiagnosticSegmentGate {
    active: Option<ActiveDiagnosticSegment>,
    last_epoch: u64,
}

struct ActiveDiagnosticSegment {
    handoff_epoch: u64,
    primary_cdp_session: String,
    live_id: String,
}

impl DiagnosticSegmentGate {
    pub(super) fn disabled() -> Self {
        Self {
            active: None,
            last_epoch: 0,
        }
    }

    pub(super) fn begin(
        &mut self,
        handoff_epoch: u64,
        primary_cdp_session: &str,
    ) -> Result<(), DiagnosticSegmentError> {
        if self.active.is_some()
            || handoff_epoch == 0
            || handoff_epoch <= self.last_epoch
            || primary_cdp_session.is_empty()
            || primary_cdp_session.len() > MAX_CDP_SESSION_ID_BYTES
            || !primary_cdp_session
                .bytes()
                .all(|byte| byte.is_ascii_graphic())
        {
            return Err(DiagnosticSegmentError);
        }
        let mut random = [0_u8; SEGMENT_RANDOM_BYTES];
        OsRng
            .try_fill_bytes(&mut random)
            .map_err(|_| DiagnosticSegmentError)?;
        self.active = Some(ActiveDiagnosticSegment {
            handoff_epoch,
            primary_cdp_session: primary_cdp_session.to_string(),
            live_id: format!("{SEGMENT_PREFIX}{}", hex::encode(random)),
        });
        self.last_epoch = handoff_epoch;
        Ok(())
    }

    pub(super) fn stop(&mut self) {
        self.active = None;
    }

    pub(super) fn live_id_for(&self, cdp_session: Option<&str>) -> Option<&str> {
        let active = self.active.as_ref()?;
        (cdp_session == Some(active.primary_cdp_session.as_str()))
            .then_some(active.live_id.as_str())
    }

    pub(super) fn active_live_id(&self) -> Option<&str> {
        self.active.as_ref().map(|active| active.live_id.as_str())
    }

    #[cfg(test)]
    pub(super) fn active_epoch(&self) -> Option<u64> {
        self.active.as_ref().map(|active| active.handoff_epoch)
    }
}

impl Default for DiagnosticSegmentGate {
    fn default() -> Self {
        Self::disabled()
    }
}

impl SemanticEngine {
    /// Drain the complete bounded queue while capture is still disabled, configure any targets
    /// discovered by those events, and only then publish the new live segment. A queue that cannot
    /// reach empty within the fixed cap is terminal rather than leaking pre-handoff history.
    pub(super) fn begin_diagnostic_segment_after_barrier(
        &mut self,
        client: &mut CdpClient<'_>,
        handoff_epoch: u64,
        deadline: Instant,
    ) -> Result<(), BackendFailure> {
        let primary_session = self.primary_session()?;
        let barrier = client.call(
            CdpMethod::PageGetFrameTree,
            serde_json::json!({}),
            Some(&primary_session),
            deadline,
            &NeverCancelled,
            self,
        )?;
        if !barrier
            .get("frameTree")
            .is_some_and(serde_json::Value::is_object)
        {
            return Err(diagnostic_barrier_invalid());
        }
        let mut drained = 0;
        loop {
            let remaining = MAX_DISABLED_BARRIER_FRAMES.saturating_sub(drained);
            if remaining == 0 {
                if client.poll_available(self, 1)? != 0 {
                    return Err(diagnostic_barrier_overflow());
                }
                break;
            }
            let handled = client.poll_available(self, remaining.min(DRAIN_BURST))?;
            drained = drained.saturating_add(handled);
            if !self.pending_sessions.is_empty() {
                self.flush_pending_sessions(client, deadline, &NeverCancelled)?;
            }
            if handled == 0 {
                break;
            }
        }
        self.begin_diagnostic_segment(handoff_epoch)
    }

    pub(super) fn begin_diagnostic_segment(
        &mut self,
        handoff_epoch: u64,
    ) -> Result<(), BackendFailure> {
        let primary_session = self.primary_session()?;
        self.network
            .begin_segment(handoff_epoch, &primary_session)?;
        if let Err(error) = self.console.begin_segment(handoff_epoch, &primary_session) {
            self.network.stop_segment();
            return Err(error);
        }
        Ok(())
    }

    /// Stop before acknowledging pause, takeover, or close. Immutable snapshots remain readable
    /// through their existing opaque ids, while the live segment becomes unreachable.
    pub(super) fn stop_diagnostic_segment(&mut self) {
        self.console.stop_segment();
        self.network.stop_segment();
    }
}

fn diagnostic_barrier_overflow() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::ProtocolViolation,
        "Browser diagnostic handoff barrier exceeded its fixed event limit.",
    )
}

fn diagnostic_barrier_invalid() -> BackendFailure {
    BackendFailure::new(
        BackendFailureCode::ProtocolViolation,
        "Browser diagnostic handoff round-trip returned an invalid frame tree.",
    )
}

#[cfg(test)]
mod tests {
    use super::super::semantics::tests::{inbox_with_frames, test_engine};
    use super::super::transport::{frame_channel, FrameEnvelope, ReaderState};
    use super::*;
    use std::io::Write;
    use std::sync::mpsc::SyncSender;
    use std::sync::Arc;

    struct BarrierWriter {
        bytes: Vec<u8>,
        sender: SyncSender<FrameEnvelope>,
        state: Arc<ReaderState>,
        pre_handoff_events: usize,
        responded: bool,
    }

    impl BarrierWriter {
        fn enqueue(&self, value: serde_json::Value) {
            let byte_len = serde_json::to_vec(&value).unwrap().len();
            assert!(self.state.reserve_bytes(byte_len, usize::MAX));
            self.sender.send(FrameEnvelope { value, byte_len }).unwrap();
        }
    }

    impl Write for BarrierWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes.extend_from_slice(bytes);
            if !self.responded && self.bytes.last() == Some(&0) {
                let command: serde_json::Value =
                    serde_json::from_slice(&self.bytes[..self.bytes.len() - 1]).unwrap();
                self.enqueue(serde_json::json!({
                    "id":command["id"],
                    "result":{"frameTree":{"frame":{
                        "id":"root",
                        "loaderId":"loader",
                        "url":"https://allowed.example",
                        "securityOrigin":"https://allowed.example"
                    }}}
                }));
                // Keep these frames behind the round-trip response. That proves the explicit
                // disabled-capture drain handles more than one 64-frame burst after `call`
                // returns; placing them first would let `call` consume them and make this test
                // accidentally green without exercising the post-response barrier.
                for index in 0..self.pre_handoff_events {
                    self.enqueue(serde_json::json!({
                        "method":"Runtime.consoleAPICalled",
                        "sessionId":"primary",
                        "params":{"type":"log","args":[{"type":"string","value":format!("manual-{index}")}]}
                    }));
                }
                self.responded = true;
            }
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn gate_is_disabled_opaque_primary_only_and_epoch_monotonic() {
        let mut gate = DiagnosticSegmentGate::disabled();
        assert!(gate.active_live_id().is_none());
        gate.begin(7, "primary-session").unwrap();
        let first = gate.active_live_id().unwrap().to_string();
        assert!(first.starts_with(SEGMENT_PREFIX));
        assert_eq!(first.len(), SEGMENT_PREFIX.len() + SEGMENT_RANDOM_BYTES * 2);
        assert!(!first.contains("primary-session"));
        assert_eq!(gate.active_epoch(), Some(7));
        assert_eq!(
            gate.live_id_for(Some("primary-session")),
            Some(first.as_str())
        );
        assert!(gate.live_id_for(Some("secondary-session")).is_none());
        assert!(gate.live_id_for(None).is_none());

        gate.stop();
        assert!(gate.begin(7, "primary-session").is_err());
        gate.begin(8, "primary-session").unwrap();
        assert_ne!(gate.active_live_id(), Some(first.as_str()));
    }

    #[test]
    fn begin_barrier_drops_more_than_one_idle_burst_before_enabling_capture() {
        let temp = tempfile::tempdir().unwrap();
        let mut engine = test_engine(&temp);
        engine.primary_session = Some("primary".to_string());
        let (sender, inbox, state) = frame_channel();
        let mut output = BarrierWriter {
            bytes: Vec::new(),
            sender,
            state,
            pre_handoff_events: 65,
            responded: false,
        };
        let mut client = CdpClient::new(&mut output, inbox);

        engine
            .begin_diagnostic_segment_after_barrier(
                &mut client,
                1,
                Instant::now() + std::time::Duration::from_secs(1),
            )
            .unwrap();
        assert_eq!(engine.console.read().unwrap().event_count, 0);

        let post_handoff = [serde_json::json!({
            "method":"Runtime.consoleAPICalled",
            "sessionId":"primary",
            "params":{"type":"log","args":[{"type":"string","value":"agent-visible"}]}
        })];
        let mut post_output = Vec::new();
        let mut post_client = CdpClient::new(&mut post_output, inbox_with_frames(post_handoff));
        assert_eq!(post_client.poll_available(&mut engine, 1).unwrap(), 1);
        assert_eq!(engine.console.read().unwrap().event_count, 1);
    }
}
