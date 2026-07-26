use std::sync::{Arc, Mutex};

use tauri_plugin_updater::{Update, UpdaterBuilder};

pub struct PendingUpdateStore<T>(Mutex<Option<T>>);

impl<T> Default for PendingUpdateStore<T> {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

impl<T> PendingUpdateStore<T> {
    pub fn replace(&self, update: Option<T>) -> Result<(), String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "Pending update state is unavailable".to_string())?;
        *guard = update;
        Ok(())
    }

    pub fn take(&self) -> Result<T, String> {
        self.0
            .lock()
            .map_err(|_| "Pending update state is unavailable".to_string())?
            .take()
            .ok_or_else(|| "No pending update to install".to_string())
    }

    #[cfg(test)]
    fn is_pending(&self) -> bool {
        self.0.lock().map(|guard| guard.is_some()).unwrap_or(false)
    }
}

pub type PendingAppUpdate = PendingUpdateStore<Update>;

#[derive(Clone, Default)]
pub struct UpdateProgress(Arc<Mutex<(u64, Option<u64>)>>);

impl UpdateProgress {
    pub fn record(&self, chunk_length: u64, content_length: Option<u64>) -> (u64, Option<u64>) {
        match self.0.lock() {
            Ok(mut guard) => {
                guard.0 = guard.0.saturating_add(chunk_length);
                if content_length.is_some() {
                    guard.1 = content_length;
                }
                (guard.0, guard.1)
            }
            Err(_) => (chunk_length, content_length),
        }
    }

    pub fn snapshot(&self) -> (u64, Option<u64>) {
        self.0
            .lock()
            .map(|guard| (guard.0, guard.1))
            .unwrap_or((0, None))
    }
}

pub async fn check_and_store(
    builder: UpdaterBuilder,
    pending: &PendingAppUpdate,
) -> Result<Option<(String, String, Option<String>, Option<String>)>, String> {
    let update = builder
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let metadata = update.as_ref().map(|update| {
        (
            update.version.clone(),
            update.current_version.clone(),
            update.date.map(|date| date.to_string()),
            update.body.clone(),
        )
    });
    pending.replace(update)?;
    Ok(metadata)
}

pub async fn check_without_store(builder: UpdaterBuilder) -> Result<Option<Update>, String> {
    builder
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())
}

pub async fn download_verified_and_install<C, D, V>(
    update: Update,
    on_chunk: C,
    on_download_finish: D,
    on_verified: V,
) -> Result<(), String>
where
    C: FnMut(usize, Option<u64>),
    D: FnOnce(),
    V: FnOnce(&[u8]) -> Result<(), String>,
{
    let bytes = update
        .download(on_chunk, on_download_finish)
        .await
        .map_err(|error| error.to_string())?;
    on_verified(&bytes)?;
    update.install(bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{PendingUpdateStore, UpdateProgress};

    #[test]
    fn pending_state_replaces_and_consumes_exactly_once() {
        let pending = PendingUpdateStore::default();
        assert!(!pending.is_pending());
        pending.replace(Some("2.53.0")).unwrap();
        assert!(pending.is_pending());
        assert_eq!(pending.take().unwrap(), "2.53.0");
        assert!(!pending.is_pending());
        assert_eq!(pending.take().unwrap_err(), "No pending update to install");
    }

    #[test]
    fn progress_is_monotonic_and_keeps_the_latest_known_total() {
        let progress = UpdateProgress::default();
        assert_eq!(progress.record(4, Some(10)), (4, Some(10)));
        assert_eq!(progress.record(3, None), (7, Some(10)));
        assert_eq!(
            progress.record(u64::MAX, Some(u64::MAX)),
            (u64::MAX, Some(u64::MAX))
        );
        assert_eq!(progress.snapshot(), (u64::MAX, Some(u64::MAX)));
    }
}
