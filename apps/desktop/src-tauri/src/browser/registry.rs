use super::{BrowserBounds, BrowserControlState, BrowserLifecycleState};
use chrono::Utc;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub(super) struct BrowserSessionState {
    pub session_id: String,
    pub label: String,
    pub bounds: BrowserBounds,
    pub visible: bool,
    pub current_url: Option<String>,
    pub title: Option<String>,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub lifecycle: BrowserLifecycleState,
    pub loading: bool,
    pub last_error: Option<String>,
    pub control: BrowserControlState,
    pub paused: bool,
    pub generation: u64,
    pub navigation_seq: u64,
    pub latest_snapshot: Option<BrowserSnapshotToken>,
    pub workspace_dir: Option<String>,
    pub cancel_epoch: u64,
    pub policy_epoch: u64,
    permission_revision: Option<u64>,
    pub operation_seq: u64,
    pub last_agent_action: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl BrowserSessionState {
    fn new(session_id: &str, label: String, bounds: BrowserBounds, generation: u64) -> Self {
        let now = now_rfc3339();
        Self {
            session_id: session_id.to_string(),
            label,
            bounds,
            visible: false,
            current_url: None,
            title: None,
            can_go_back: false,
            can_go_forward: false,
            lifecycle: BrowserLifecycleState::Creating,
            loading: false,
            last_error: None,
            control: BrowserControlState::User,
            paused: false,
            generation,
            navigation_seq: 0,
            latest_snapshot: None,
            workspace_dir: None,
            cancel_epoch: 0,
            policy_epoch: 0,
            permission_revision: None,
            operation_seq: 0,
            last_agent_action: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    fn touch(&mut self) {
        self.updated_at = now_rfc3339();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct BrowserNavigationToken {
    pub session_id: String,
    pub generation: u64,
    pub navigation_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct BrowserSnapshotToken {
    pub session_id: String,
    pub snapshot_id: String,
    pub generation: u64,
    pub navigation_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct BrowserOperationToken {
    pub session_id: String,
    pub generation: u64,
    pub cancel_epoch: u64,
    pub policy_epoch: u64,
    pub permission_revision: Option<u64>,
    pub operation_seq: u64,
}

pub(super) struct BrowserSessionRegistry {
    sessions: Mutex<HashMap<String, BrowserSessionState>>,
    actors: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    active_session_id: Mutex<String>,
    last_bounds: Mutex<BrowserBounds>,
    next_generation: AtomicU64,
}

impl BrowserSessionRegistry {
    pub fn new(default_session_id: &str) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            actors: Mutex::new(HashMap::new()),
            active_session_id: Mutex::new(default_session_id.to_string()),
            last_bounds: Mutex::new(BrowserBounds::default()),
            next_generation: AtomicU64::new(1),
        }
    }

    pub fn snapshot_or_create(
        &self,
        session_id: &str,
        label: impl FnOnce(u64) -> String,
    ) -> Result<BrowserSessionState, String> {
        if let Some(session) = self.lock_sessions()?.get(session_id).cloned() {
            return Ok(session.clone());
        }

        let bounds = *self
            .last_bounds
            .lock()
            .map_err(|_| "Failed to lock last browser bounds".to_string())?;
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let candidate = BrowserSessionState::new(session_id, label(generation), bounds, generation);
        let mut sessions = self.lock_sessions()?;
        Ok(sessions
            .entry(session_id.to_string())
            .or_insert(candidate)
            .clone())
    }

    pub fn snapshot(&self, session_id: &str) -> Result<Option<BrowserSessionState>, String> {
        Ok(self.lock_sessions()?.get(session_id).cloned())
    }

    pub fn snapshots(&self) -> Result<Vec<BrowserSessionState>, String> {
        Ok(self.lock_sessions()?.values().cloned().collect())
    }

    pub fn active_session_id(&self) -> Result<String, String> {
        self.active_session_id
            .lock()
            .map(|value| value.clone())
            .map_err(|_| "Failed to lock active browser session".to_string())
    }

    pub fn set_active_session(&self, session_id: &str) -> Result<(), String> {
        *self
            .active_session_id
            .lock()
            .map_err(|_| "Failed to lock active browser session".to_string())? =
            session_id.to_string();
        Ok(())
    }

    pub fn is_visible_for_agent(&self, session_id: &str) -> Result<bool, String> {
        let active_session_id = self.active_session_id()?;
        Ok(active_session_id == session_id
            && self
                .lock_sessions()?
                .get(session_id)
                .is_some_and(|session| session.visible && !session.paused))
    }

    pub fn bind_workspace(
        &self,
        session_id: &str,
        workspace_dir: &str,
    ) -> Result<BrowserSessionState, String> {
        self.update(session_id, |session| {
            match session.workspace_dir.as_deref() {
                Some(existing) if existing != workspace_dir => {
                    session.last_error = Some(
                        "Browser session cannot change its workspace artifact scope.".to_string(),
                    );
                }
                Some(_) => {}
                None => session.workspace_dir = Some(workspace_dir.to_string()),
            }
        })
        .and_then(|session| {
            if session.workspace_dir.as_deref() == Some(workspace_dir) {
                Ok(session)
            } else {
                Err("Browser session cannot change its workspace artifact scope.".to_string())
            }
        })
    }

    pub fn set_bounds(
        &self,
        session_id: &str,
        bounds: BrowserBounds,
    ) -> Result<BrowserSessionState, String> {
        *self
            .last_bounds
            .lock()
            .map_err(|_| "Failed to lock last browser bounds".to_string())? = bounds;
        self.update(session_id, |session| {
            session.bounds = bounds;
        })
    }

    pub fn set_visible(
        &self,
        session_id: &str,
        visible: bool,
    ) -> Result<BrowserSessionState, String> {
        self.update(session_id, |session| {
            session.visible = visible;
        })
    }

    pub fn mark_ready(&self, session_id: &str) -> Result<BrowserSessionState, String> {
        self.update(session_id, |session| {
            session.lifecycle = BrowserLifecycleState::Ready;
            session.loading = false;
            session.last_error = None;
        })
    }

    pub fn mark_navigation(
        &self,
        session_id: &str,
        url: String,
    ) -> Result<(BrowserSessionState, BrowserNavigationToken), String> {
        let mut sessions = self.lock_sessions()?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Browser session {session_id} is not registered"))?;
        session.navigation_seq = session.navigation_seq.saturating_add(1);
        session.latest_snapshot = None;
        session.current_url = Some(url);
        session.title = None;
        session.lifecycle = BrowserLifecycleState::Navigating;
        session.loading = true;
        session.last_error = None;
        session.touch();
        let token = BrowserNavigationToken {
            session_id: session_id.to_string(),
            generation: session.generation,
            navigation_seq: session.navigation_seq,
        };
        Ok((session.clone(), token))
    }

    pub fn apply_navigation_metadata(
        &self,
        token: &BrowserNavigationToken,
        url: Option<String>,
        title: Option<String>,
        can_go_back: bool,
        can_go_forward: bool,
    ) -> Result<Option<BrowserSessionState>, String> {
        let mut sessions = self.lock_sessions()?;
        let Some(session) = sessions.get_mut(&token.session_id) else {
            return Ok(None);
        };
        if session.generation != token.generation || session.navigation_seq != token.navigation_seq
        {
            return Ok(None);
        }
        if let Some(url) = url.filter(|value| !value.is_empty()) {
            session.current_url = Some(url);
        }
        if let Some(title) = title.filter(|value| !value.is_empty()) {
            session.title = Some(title);
        }
        session.can_go_back = can_go_back;
        session.can_go_forward = can_go_forward;
        session.lifecycle = BrowserLifecycleState::Interactive;
        session.loading = false;
        session.last_error = None;
        session.touch();
        Ok(Some(session.clone()))
    }

    pub fn apply_title(
        &self,
        session_id: &str,
        generation: u64,
        title: String,
    ) -> Result<Option<BrowserSessionState>, String> {
        let mut sessions = self.lock_sessions()?;
        let Some(session) = sessions.get_mut(session_id) else {
            return Ok(None);
        };
        if session.generation != generation {
            return Ok(None);
        }
        if session.lifecycle != BrowserLifecycleState::Navigating {
            session.title = (!title.trim().is_empty()).then_some(title);
        }
        session.touch();
        Ok(Some(session.clone()))
    }

    pub fn record_metadata(
        &self,
        session_id: &str,
        url: Option<String>,
        title: Option<String>,
    ) -> Result<BrowserSessionState, String> {
        self.update(session_id, |session| {
            if let Some(url) = url.filter(|value| !value.is_empty()) {
                if session.current_url.as_deref() != Some(url.as_str()) {
                    session.navigation_seq = session.navigation_seq.saturating_add(1);
                    session.latest_snapshot = None;
                }
                session.current_url = Some(url);
            }
            if let Some(title) = title.filter(|value| !value.is_empty()) {
                session.title = Some(title);
            }
        })
    }

    pub fn record_interaction_snapshot(
        &self,
        session_id: &str,
        snapshot_id: &str,
    ) -> Result<BrowserSnapshotToken, String> {
        let mut sessions = self.lock_sessions()?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Browser session {session_id} is not registered"))?;
        let token = BrowserSnapshotToken {
            session_id: session_id.to_string(),
            snapshot_id: snapshot_id.to_string(),
            generation: session.generation,
            navigation_seq: session.navigation_seq,
        };
        session.latest_snapshot = Some(token.clone());
        if session.lifecycle == BrowserLifecycleState::Navigating {
            session.lifecycle = BrowserLifecycleState::Interactive;
            session.loading = false;
            session.last_error = None;
        }
        session.touch();
        Ok(token)
    }

    pub fn validate_interaction_snapshot(
        &self,
        session_id: &str,
        snapshot_id: &str,
    ) -> Result<BrowserSnapshotToken, String> {
        let sessions = self.lock_sessions()?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("Browser session {session_id} is not registered"))?;
        let token = session.latest_snapshot.as_ref().ok_or_else(|| {
            "Browser interaction requires a fresh snapshot for the current page.".to_string()
        })?;
        if token.snapshot_id != snapshot_id
            || token.generation != session.generation
            || token.navigation_seq != session.navigation_seq
        {
            return Err(
                "Browser interaction snapshot is stale; capture a new snapshot first.".to_string(),
            );
        }
        Ok(token.clone())
    }

    pub fn mark_crashed(
        &self,
        session_id: &str,
        error: impl Into<String>,
    ) -> Result<Option<BrowserSessionState>, String> {
        let mut sessions = self.lock_sessions()?;
        let Some(session) = sessions.get_mut(session_id) else {
            return Ok(None);
        };
        session.lifecycle = BrowserLifecycleState::Crashed;
        session.loading = false;
        session.visible = false;
        session.last_error = Some(error.into());
        session.latest_snapshot = None;
        session.cancel_epoch = session.cancel_epoch.saturating_add(1);
        session.control = BrowserControlState::User;
        session.touch();
        Ok(Some(session.clone()))
    }

    pub fn mark_error(
        &self,
        session_id: &str,
        error: impl Into<String>,
    ) -> Result<BrowserSessionState, String> {
        let error = error.into();
        self.update(session_id, |session| {
            session.lifecycle = if session.current_url.is_some() {
                BrowserLifecycleState::Interactive
            } else {
                BrowserLifecycleState::Ready
            };
            session.loading = false;
            session.last_error = Some(error);
            if !session.paused {
                session.control = BrowserControlState::User;
            }
        })
    }

    pub fn remove(&self, session_id: &str) -> Result<Option<BrowserSessionState>, String> {
        let removed = {
            let mut sessions = self.lock_sessions()?;
            sessions.remove(session_id).map(|mut session| {
                session.lifecycle = BrowserLifecycleState::Destroyed;
                session.loading = false;
                session.visible = false;
                session.cancel_epoch = session.cancel_epoch.saturating_add(1);
                session.control = BrowserControlState::User;
                session.touch();
                session
            })
        };
        self.actors
            .lock()
            .map_err(|_| "Failed to lock browser session actors".to_string())?
            .remove(session_id);
        Ok(removed)
    }

    pub fn actor(&self, session_id: &str) -> Result<Arc<Mutex<()>>, String> {
        let mut actors = self
            .actors
            .lock()
            .map_err(|_| "Failed to lock browser session actors".to_string())?;
        Ok(actors
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }

    pub fn begin_agent_action(
        &self,
        session_id: &str,
        tool: &str,
    ) -> Result<(BrowserSessionState, BrowserOperationToken), String> {
        self.begin_agent_action_inner(session_id, None, None, tool, None)
    }

    pub fn begin_agent_action_expected_generation(
        &self,
        session_id: &str,
        expected_generation: u64,
        tool: &str,
    ) -> Result<(BrowserSessionState, BrowserOperationToken), String> {
        self.begin_agent_action_inner(session_id, Some(expected_generation), None, tool, None)
    }

    pub fn begin_agent_action_expected_route(
        &self,
        session_id: &str,
        expected_generation: u64,
        expected_cancel_epoch: u64,
        tool: &str,
    ) -> Result<(BrowserSessionState, BrowserOperationToken), String> {
        self.begin_agent_action_inner(
            session_id,
            Some(expected_generation),
            Some(expected_cancel_epoch),
            tool,
            None,
        )
    }

    pub fn begin_agent_action_with_permission(
        &self,
        session_id: &str,
        tool: &str,
        permission_revision: u64,
    ) -> Result<(BrowserSessionState, BrowserOperationToken), String> {
        self.begin_agent_action_inner(session_id, None, None, tool, Some(permission_revision))
    }

    pub fn begin_agent_action_with_permission_expected_generation(
        &self,
        session_id: &str,
        expected_generation: u64,
        tool: &str,
        permission_revision: u64,
    ) -> Result<(BrowserSessionState, BrowserOperationToken), String> {
        self.begin_agent_action_inner(
            session_id,
            Some(expected_generation),
            None,
            tool,
            Some(permission_revision),
        )
    }

    pub fn begin_agent_action_with_permission_expected_route(
        &self,
        session_id: &str,
        expected_generation: u64,
        expected_cancel_epoch: u64,
        tool: &str,
        permission_revision: u64,
    ) -> Result<(BrowserSessionState, BrowserOperationToken), String> {
        self.begin_agent_action_inner(
            session_id,
            Some(expected_generation),
            Some(expected_cancel_epoch),
            tool,
            Some(permission_revision),
        )
    }

    fn begin_agent_action_inner(
        &self,
        session_id: &str,
        expected_generation: Option<u64>,
        expected_cancel_epoch: Option<u64>,
        tool: &str,
        permission_revision: Option<u64>,
    ) -> Result<(BrowserSessionState, BrowserOperationToken), String> {
        let mut sessions = self.lock_sessions()?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Browser session {session_id} is not registered"))?;
        if expected_generation.is_some_and(|expected| session.generation != expected) {
            return Err(
                "Browser action was cancelled because its Preview Browser instance changed."
                    .to_string(),
            );
        }
        if expected_cancel_epoch.is_some_and(|expected| session.cancel_epoch != expected) {
            return Err(
                "Browser action was cancelled because its Preview Browser route changed."
                    .to_string(),
            );
        }
        if session.paused {
            return Err("Browser agent control is paused by the user.".to_string());
        }
        if matches!(
            session.lifecycle,
            BrowserLifecycleState::Crashed | BrowserLifecycleState::Destroyed
        ) {
            return Err(format!(
                "Browser session is {}.",
                session.lifecycle.as_str()
            ));
        }
        if let Some(expected) = permission_revision {
            match session.permission_revision {
                Some(current) if current != expected => {
                    return Err(
                        "Browser permission changed before the Preview action began.".to_string(),
                    )
                }
                None => session.permission_revision = Some(expected),
                Some(_) => {}
            }
        }
        session.operation_seq = session.operation_seq.saturating_add(1);
        session.control = BrowserControlState::Agent;
        session.last_agent_action = Some(tool.to_string());
        session.touch();
        let token = BrowserOperationToken {
            session_id: session_id.to_string(),
            generation: session.generation,
            cancel_epoch: session.cancel_epoch,
            policy_epoch: session.policy_epoch,
            permission_revision,
            operation_seq: session.operation_seq,
        };
        Ok((session.clone(), token))
    }

    pub fn validate_operation(&self, token: &BrowserOperationToken) -> Result<(), String> {
        let sessions = self.lock_sessions()?;
        let session = sessions.get(&token.session_id).ok_or_else(|| {
            "Browser operation was cancelled because the session ended.".to_string()
        })?;
        if session.generation != token.generation
            || session.cancel_epoch != token.cancel_epoch
            || session.policy_epoch != token.policy_epoch
            || token
                .permission_revision
                .is_some_and(|expected| session.permission_revision != Some(expected))
            || session.operation_seq != token.operation_seq
        {
            return Err(
                "Browser operation was cancelled because session policy or lifecycle changed."
                    .to_string(),
            );
        }
        if session.paused {
            return Err(
                "Browser operation was cancelled because agent control is paused.".to_string(),
            );
        }
        Ok(())
    }

    pub fn finish_agent_action(
        &self,
        token: &BrowserOperationToken,
        error: Option<&str>,
    ) -> Result<Option<BrowserSessionState>, String> {
        let mut sessions = self.lock_sessions()?;
        let Some(session) = sessions.get_mut(&token.session_id) else {
            return Ok(None);
        };
        if session.generation != token.generation || session.operation_seq != token.operation_seq {
            return Ok(None);
        }
        if !session.paused {
            session.control = BrowserControlState::User;
        }
        if let Some(error) = error.filter(|_| !session.paused) {
            session.last_error = Some(error.to_string());
        }
        session.touch();
        Ok(Some(session.clone()))
    }

    pub fn set_paused(
        &self,
        session_id: &str,
        paused: bool,
    ) -> Result<BrowserSessionState, String> {
        self.update(session_id, |session| {
            session.paused = paused;
            session.cancel_epoch = session.cancel_epoch.saturating_add(1);
            session.control = if paused {
                BrowserControlState::Paused
            } else {
                BrowserControlState::User
            };
        })
    }

    pub fn bump_policy_epoch(&self, session_id: &str) -> Result<BrowserSessionState, String> {
        self.update(session_id, |session| {
            session.policy_epoch = session.policy_epoch.saturating_add(1);
            session.cancel_epoch = session.cancel_epoch.saturating_add(1);
            if !session.paused {
                session.control = BrowserControlState::User;
            }
        })
    }

    pub fn bump_permission_epoch(
        &self,
        session_id: &str,
        permission_revision: u64,
    ) -> Result<BrowserSessionState, String> {
        self.update(session_id, |session| {
            session.permission_revision = Some(permission_revision);
            session.policy_epoch = session.policy_epoch.saturating_add(1);
            session.cancel_epoch = session.cancel_epoch.saturating_add(1);
            if !session.paused {
                session.control = BrowserControlState::User;
            }
        })
    }

    pub fn invalidate_alias_route(
        &self,
        session_id: &str,
        generation: u64,
    ) -> Result<Option<BrowserSessionState>, String> {
        let mut sessions = self.lock_sessions()?;
        let Some(session) = sessions.get_mut(session_id) else {
            return Ok(None);
        };
        if session.generation != generation {
            return Ok(None);
        }
        session.cancel_epoch = session.cancel_epoch.saturating_add(1);
        if !session.paused {
            session.control = BrowserControlState::User;
        }
        session.touch();
        Ok(Some(session.clone()))
    }

    fn update<F>(&self, session_id: &str, update: F) -> Result<BrowserSessionState, String>
    where
        F: FnOnce(&mut BrowserSessionState),
    {
        let mut sessions = self.lock_sessions()?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Browser session {session_id} is not registered"))?;
        update(session);
        session.touch();
        Ok(session.clone())
    }

    fn lock_sessions(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, BrowserSessionState>>, String> {
        self.sessions
            .lock()
            .map_err(|_| "Failed to lock browser sessions".to_string())
    }
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::BrowserSessionRegistry;
    use crate::browser::{BrowserControlState, BrowserLifecycleState};

    fn registry() -> BrowserSessionRegistry {
        BrowserSessionRegistry::new("workspace")
    }

    #[test]
    fn stale_navigation_metadata_cannot_overwrite_newer_navigation() {
        let registry = registry();
        registry
            .snapshot_or_create("session-a", |_| "browser-a".to_string())
            .expect("create session");
        let (_, first) = registry
            .mark_navigation("session-a", "https://first.test/".to_string())
            .expect("first navigation");
        let (_, second) = registry
            .mark_navigation("session-a", "https://second.test/".to_string())
            .expect("second navigation");

        assert!(registry
            .apply_navigation_metadata(
                &first,
                Some("https://first.test/late".to_string()),
                Some("stale".to_string()),
                false,
                false,
            )
            .expect("apply stale metadata")
            .is_none());
        let current = registry
            .apply_navigation_metadata(
                &second,
                Some("https://second.test/final".to_string()),
                Some("current".to_string()),
                true,
                false,
            )
            .expect("apply current metadata")
            .expect("current session");
        assert_eq!(
            current.current_url.as_deref(),
            Some("https://second.test/final")
        );
        assert_eq!(current.title.as_deref(), Some("current"));
        assert_eq!(current.lifecycle, BrowserLifecycleState::Interactive);
        assert!(!current.loading);
        assert!(current.can_go_back);
    }

    #[test]
    fn title_events_do_not_settle_an_inflight_navigation() {
        let registry = registry();
        let session = registry
            .snapshot_or_create("session-a", |_| "browser-a".to_string())
            .expect("create session");
        registry
            .mark_navigation("session-a", "https://next.test/".to_string())
            .expect("start navigation");

        let after_title = registry
            .apply_title("session-a", session.generation, "stale title".to_string())
            .expect("apply title")
            .expect("session still exists");
        assert_eq!(after_title.lifecycle, BrowserLifecycleState::Navigating);
        assert!(after_title.loading);
        assert!(after_title.title.is_none());
    }

    #[test]
    fn pausing_cancels_an_inflight_agent_operation() {
        let registry = registry();
        registry
            .snapshot_or_create("session-a", |_| "browser-a".to_string())
            .expect("create session");
        registry.mark_ready("session-a").expect("ready");
        let (active, token) = registry
            .begin_agent_action("session-a", "click")
            .expect("begin action");
        assert_eq!(active.control, BrowserControlState::Agent);

        let paused = registry.set_paused("session-a", true).expect("pause");
        assert_eq!(paused.control, BrowserControlState::Paused);
        assert!(registry.validate_operation(&token).is_err());
        assert!(registry
            .begin_agent_action("session-a", "type")
            .expect_err("paused session must reject agent work")
            .contains("paused"));
    }

    #[test]
    fn permission_epoch_change_cancels_an_inflight_agent_operation() {
        let registry = registry();
        registry
            .snapshot_or_create("session-a", |_| "browser-a".to_string())
            .expect("create session");
        registry.mark_ready("session-a").expect("ready");
        let (_, token) = registry
            .begin_agent_action("session-a", "wait_for")
            .expect("begin action");

        let changed = registry
            .bump_policy_epoch("session-a")
            .expect("change policy epoch");
        assert_eq!(changed.policy_epoch, token.policy_epoch + 1);
        assert!(registry.validate_operation(&token).is_err());
    }

    #[test]
    fn interaction_snapshot_is_bound_to_generation_and_navigation() {
        let registry = registry();
        registry
            .snapshot_or_create("session-a", |_| "browser-a".to_string())
            .expect("create session");
        registry.mark_ready("session-a").expect("ready");
        registry
            .mark_navigation("session-a", "https://current.test/".to_string())
            .expect("start navigation");
        let token = registry
            .record_interaction_snapshot("session-a", "snapshot-1")
            .expect("record snapshot");

        let settled = registry
            .snapshot("session-a")
            .expect("snapshot state")
            .expect("registered state");
        assert_eq!(settled.lifecycle, BrowserLifecycleState::Interactive);
        assert!(!settled.loading);

        assert_eq!(
            registry
                .validate_interaction_snapshot("session-a", "snapshot-1")
                .expect("current snapshot"),
            token
        );
        assert!(registry
            .validate_interaction_snapshot("session-a", "snapshot-other")
            .is_err());

        registry
            .mark_navigation("session-a", "https://next.test/".to_string())
            .expect("navigate");
        assert!(registry
            .validate_interaction_snapshot("session-a", "snapshot-1")
            .is_err());
    }

    #[test]
    fn destroy_then_recreate_invalidates_old_generation() {
        let registry = registry();
        let first = registry
            .snapshot_or_create("session-a", |_| "browser-a".to_string())
            .expect("create session");
        registry.mark_ready("session-a").expect("ready");
        let (_, token) = registry
            .begin_agent_action("session-a", "wait_for")
            .expect("begin action");
        let destroyed = registry
            .remove("session-a")
            .expect("remove session")
            .expect("destroyed snapshot");
        assert_eq!(destroyed.lifecycle, BrowserLifecycleState::Destroyed);
        assert!(registry.validate_operation(&token).is_err());

        let second = registry
            .snapshot_or_create("session-a", |_| "browser-a".to_string())
            .expect("recreate session");
        assert!(second.generation > first.generation);
    }

    #[test]
    fn session_actors_are_stable_and_isolated() {
        let registry = registry();
        let first = registry.actor("session-a").expect("first actor");
        let same = registry.actor("session-a").expect("same actor");
        let other = registry.actor("session-b").expect("other actor");
        assert!(std::sync::Arc::ptr_eq(&first, &same));
        assert!(!std::sync::Arc::ptr_eq(&first, &other));
    }

    #[test]
    fn agent_visibility_requires_the_exact_active_unpaused_session() {
        let registry = registry();
        registry
            .snapshot_or_create("session-a", |_| "browser-a".to_string())
            .expect("create a");
        registry
            .snapshot_or_create("session-b", |_| "browser-b".to_string())
            .expect("create b");
        registry.set_visible("session-a", true).expect("show a");
        registry.set_visible("session-b", true).expect("show b");
        registry
            .set_active_session("session-a")
            .expect("activate a");

        assert!(registry
            .is_visible_for_agent("session-a")
            .expect("visible a"));
        assert!(!registry
            .is_visible_for_agent("session-b")
            .expect("hidden b"));
        registry.set_paused("session-a", true).expect("pause a");
        assert!(!registry
            .is_visible_for_agent("session-a")
            .expect("paused a is not controllable"));
    }

    #[test]
    fn artifact_workspace_scope_cannot_change_within_a_session() {
        let registry = registry();
        registry
            .snapshot_or_create("session-a", |_| "browser-a".to_string())
            .expect("create session");

        registry
            .bind_workspace("session-a", "/workspace/a")
            .expect("bind workspace");
        registry
            .bind_workspace("session-a", "/workspace/a")
            .expect("repeat workspace");
        assert!(registry
            .bind_workspace("session-a", "/workspace/b")
            .is_err());
    }
}
