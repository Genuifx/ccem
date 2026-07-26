use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const MAX_BROWSER_SESSION_ID_BYTES: usize = 160;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BrowserSessionAliasLease {
    pub alias_session_id: String,
    pub session_id: String,
    pub generation: u64,
    pub binding_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BrowserSessionAliasRoute {
    pub(super) requested_session_id: String,
    pub(super) adopted: Option<BrowserSessionAliasLease>,
    pub(super) captured_revision: u64,
    pub(super) adopted_revision: Option<u64>,
    pub(super) provisional: Option<(String, u64)>,
}

impl BrowserSessionAliasRoute {
    pub(crate) fn new(requested_session_id: &str, snapshot: BrowserSessionAliasSnapshot) -> Self {
        let adopted_revision = snapshot.lease.as_ref().map(|_| snapshot.revision);
        Self {
            requested_session_id: requested_session_id.to_string(),
            adopted: snapshot.lease,
            captured_revision: snapshot.revision,
            adopted_revision,
            provisional: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BrowserSessionAliasBinding {
    session_id: String,
    generation: u64,
    binding_id: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct BrowserSessionAliasEntry {
    revision: u64,
    binding: Option<BrowserSessionAliasBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BrowserSessionAliasSnapshot {
    pub(super) revision: u64,
    pub(super) lease: Option<BrowserSessionAliasLease>,
}

/// Trusted shell bindings from a native Agent runtime id to one concrete Preview Browser
/// generation. The generation fence prevents a retained alias from crossing an explicit
/// close/reopen boundary, while the binding id makes a delayed frontend cleanup a no-op after
/// a newer binding has replaced it.
pub(crate) struct BrowserSessionAliasRegistry {
    entries: Mutex<HashMap<String, BrowserSessionAliasEntry>>,
    next_binding_id: AtomicU64,
}

impl Default for BrowserSessionAliasRegistry {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            next_binding_id: AtomicU64::new(1),
        }
    }
}

impl BrowserSessionAliasRegistry {
    pub(crate) fn bind(
        &self,
        alias_session_id: &str,
        session_id: &str,
        generation: u64,
    ) -> Result<(BrowserSessionAliasLease, Option<BrowserSessionAliasLease>), String> {
        validate_session_id(alias_session_id, "Preview Browser alias")?;
        validate_session_id(session_id, "Preview Browser session")?;
        if generation == 0 {
            return Err("Preview Browser alias generation must be positive.".to_string());
        }

        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Preview Browser alias registry is unavailable.".to_string())?;
        let entry = entries.entry(alias_session_id.to_string()).or_default();
        if let Some(existing) = entry.binding.as_ref() {
            if existing.session_id == session_id && existing.generation == generation {
                return Ok((lease_from_binding(alias_session_id, existing), None));
            }
        }

        let binding_id = self.next_binding_id.fetch_add(1, Ordering::Relaxed);
        if binding_id == 0 {
            return Err("Preview Browser alias binding id is exhausted.".to_string());
        }
        let revision = next_alias_revision(entry.revision)?;
        let replaced = entry.binding.replace(BrowserSessionAliasBinding {
            session_id: session_id.to_string(),
            generation,
            binding_id,
        });
        entry.revision = revision;
        Ok((
            BrowserSessionAliasLease {
                alias_session_id: alias_session_id.to_string(),
                session_id: session_id.to_string(),
                generation,
                binding_id,
            },
            replaced
                .as_ref()
                .map(|binding| lease_from_binding(alias_session_id, binding)),
        ))
    }

    pub(crate) fn current(
        &self,
        alias_session_id: &str,
        current_generation: impl FnOnce(&str) -> Result<Option<u64>, String>,
    ) -> Result<BrowserSessionAliasSnapshot, String> {
        let entry = self
            .entries
            .lock()
            .map_err(|_| "Preview Browser alias registry is unavailable.".to_string())?
            .get(alias_session_id)
            .cloned()
            .unwrap_or_default();
        let Some(binding) = entry.binding.as_ref() else {
            return Ok(BrowserSessionAliasSnapshot {
                revision: entry.revision,
                lease: None,
            });
        };
        if current_generation(&binding.session_id)? == Some(binding.generation) {
            return Ok(BrowserSessionAliasSnapshot {
                revision: entry.revision,
                lease: Some(lease_from_binding(alias_session_id, binding)),
            });
        }

        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Preview Browser alias registry is unavailable.".to_string())?;
        let current = entries.entry(alias_session_id.to_string()).or_default();
        if current.revision == entry.revision && current.binding.as_ref() == Some(binding) {
            current.binding = None;
            current.revision = next_alias_revision(current.revision)?;
        }
        Ok(BrowserSessionAliasSnapshot {
            revision: current.revision,
            lease: current
                .binding
                .as_ref()
                .map(|binding| lease_from_binding(alias_session_id, binding)),
        })
    }

    pub(crate) fn resolve(
        &self,
        alias_session_id: &str,
        current_generation: impl FnOnce(&str) -> Result<Option<u64>, String>,
    ) -> Result<Option<String>, String> {
        self.current(alias_session_id, current_generation)
            .map(|snapshot| snapshot.lease.map(|lease| lease.session_id))
    }

    pub(crate) fn unbind(
        &self,
        alias_session_id: &str,
        binding_id: u64,
    ) -> Result<Option<BrowserSessionAliasLease>, String> {
        validate_session_id(alias_session_id, "Preview Browser alias")?;
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Preview Browser alias registry is unavailable.".to_string())?;
        let Some(entry) = entries.get_mut(alias_session_id) else {
            return Ok(None);
        };
        if let Some(binding) = entry
            .binding
            .as_ref()
            .filter(|binding| binding.binding_id == binding_id)
            .cloned()
        {
            entry.binding = None;
            entry.revision = next_alias_revision(entry.revision)?;
            return Ok(Some(lease_from_binding(alias_session_id, &binding)));
        }
        Ok(None)
    }

    pub(crate) fn remove_session(&self, session_id: &str, generation: u64) -> Result<(), String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Preview Browser alias registry is unavailable.".to_string())?;
        for entry in entries.values_mut() {
            if entry.binding.as_ref().is_some_and(|binding| {
                binding.session_id == session_id && binding.generation == generation
            }) {
                entry.binding = None;
                entry.revision = next_alias_revision(entry.revision)?;
            }
        }
        Ok(())
    }
}

fn next_alias_revision(current: u64) -> Result<u64, String> {
    current
        .checked_add(1)
        .ok_or_else(|| "Preview Browser alias lifecycle revision is exhausted.".to_string())
}

fn lease_from_binding(
    alias_session_id: &str,
    binding: &BrowserSessionAliasBinding,
) -> BrowserSessionAliasLease {
    BrowserSessionAliasLease {
        alias_session_id: alias_session_id.to_string(),
        session_id: binding.session_id.clone(),
        generation: binding.generation,
        binding_id: binding.binding_id,
    }
}

fn validate_session_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_BROWSER_SESSION_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!("{label} id is invalid."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::BrowserSessionAliasRegistry;
    use std::collections::HashMap;

    #[test]
    fn alias_resolves_only_the_bound_physical_generation() {
        let aliases = BrowserSessionAliasRegistry::default();
        let mut generations = HashMap::from([("physical:1".to_string(), 7_u64)]);
        let (lease, replaced) = aliases
            .bind("runtime-a", "physical:1", 7)
            .expect("bind alias");
        assert!(replaced.is_none());

        assert_eq!(
            aliases
                .resolve("runtime-a", |session_id| {
                    Ok(generations.get(session_id).copied())
                })
                .expect("resolve alias"),
            Some("physical:1".to_string())
        );

        generations.insert("physical:1".to_string(), 8);
        assert_eq!(
            aliases
                .resolve("runtime-a", |session_id| {
                    Ok(generations.get(session_id).copied())
                })
                .expect("reject stale generation"),
            None
        );
        assert!(aliases
            .unbind("runtime-a", lease.binding_id)
            .expect("stale binding already retired")
            .is_none());
    }

    #[test]
    fn delayed_unbind_cannot_remove_a_reopened_instance_binding() {
        let aliases = BrowserSessionAliasRegistry::default();
        let (old, _) = aliases
            .bind("runtime-a", "physical:1", 1)
            .expect("old binding");
        let (reopened, replaced) = aliases
            .bind("runtime-a", "physical:2", 2)
            .expect("reopened binding");

        assert_ne!(old.binding_id, reopened.binding_id);
        assert_eq!(replaced, Some(old.clone()));
        assert!(aliases
            .unbind("runtime-a", old.binding_id)
            .expect("old unbind is a no-op")
            .is_none());
        assert_eq!(
            aliases
                .resolve("runtime-a", |session_id| {
                    Ok((session_id == "physical:2").then_some(2))
                })
                .expect("new binding remains"),
            Some("physical:2".to_string())
        );
    }

    #[test]
    fn closing_a_physical_generation_retires_all_of_its_aliases() {
        let aliases = BrowserSessionAliasRegistry::default();
        aliases.bind("runtime-a", "physical:1", 4).unwrap();
        aliases.bind("runtime-b", "physical:1", 4).unwrap();
        aliases
            .remove_session("physical:1", 4)
            .expect("retire physical generation");

        for alias in ["runtime-a", "runtime-b"] {
            assert_eq!(
                aliases
                    .resolve(alias, |_| Ok(Some(4)))
                    .expect("alias removed"),
                None
            );
        }
    }
}
