use crate::jsonl_watcher::discover_jsonl_path;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

pub const DEFAULT_CONFIG_SOURCE: &str = "ccem";
const STATE_DB_FILE_NAME: &str = "state.sqlite";
const BIND_POLL_TIMEOUT: Duration = Duration::from_secs(20);
const BIND_POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone)]
pub struct SessionProvenanceUpsert {
    pub ccem_session_id: String,
    pub client: String,
    pub env_name: String,
    pub config_source: Option<String>,
    pub working_dir: String,
    pub perm_mode: Option<String>,
    pub launch_mode: String,
    pub started_via: String,
    pub source_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionProvenanceRecord {
    pub ccem_session_id: String,
    pub client: String,
    pub source_session_id: String,
    pub env_name: String,
    pub config_source: Option<String>,
    pub working_dir: String,
    pub perm_mode: Option<String>,
    pub launch_mode: String,
    pub started_via: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn state_db_path() -> PathBuf {
    if let Ok(path) = std::env::var("CCEM_STATE_DB_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    dirs::home_dir()
        .map(|home| home.join(".ccem").join(STATE_DB_FILE_NAME))
        .unwrap_or_else(|| PathBuf::from(".ccem").join(STATE_DB_FILE_NAME))
}

pub fn register_launch(input: SessionProvenanceUpsert) -> Result<(), String> {
    let trimmed_session_id = input.ccem_session_id.trim();
    if trimmed_session_id.is_empty() {
        return Err("Missing ccem session id for provenance registration".to_string());
    }

    let client = input.client.trim().to_lowercase();
    if client.is_empty() {
        return Err("Missing client for provenance registration".to_string());
    }

    let env_name = input.env_name.trim().to_string();
    if env_name.is_empty() {
        return Err("Missing environment name for provenance registration".to_string());
    }

    let working_dir = input.working_dir.trim().to_string();
    if working_dir.is_empty() {
        return Err("Missing working directory for provenance registration".to_string());
    }

    let launch_mode = input.launch_mode.trim().to_string();
    if launch_mode.is_empty() {
        return Err("Missing launch mode for provenance registration".to_string());
    }

    let started_via = input.started_via.trim().to_string();
    if started_via.is_empty() {
        return Err("Missing started_via for provenance registration".to_string());
    }

    let config_source = normalize_optional_text(input.config_source);
    let perm_mode = normalize_optional_text(input.perm_mode);
    let source_session_id = normalize_optional_text(input.source_session_id);
    let now = Utc::now().to_rfc3339();
    let conn = open_db()?;

    conn.execute(
        "INSERT INTO session_provenance (
            ccem_session_id,
            client,
            env_name,
            config_source,
            working_dir,
            perm_mode,
            launch_mode,
            started_via,
            source_session_id,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
        ON CONFLICT(ccem_session_id) DO UPDATE SET
            client = excluded.client,
            env_name = excluded.env_name,
            config_source = COALESCE(excluded.config_source, session_provenance.config_source),
            working_dir = excluded.working_dir,
            perm_mode = COALESCE(excluded.perm_mode, session_provenance.perm_mode),
            launch_mode = excluded.launch_mode,
            started_via = excluded.started_via,
            source_session_id = COALESCE(excluded.source_session_id, session_provenance.source_session_id),
            updated_at = excluded.updated_at",
        params![
            trimmed_session_id,
            client,
            env_name,
            config_source,
            working_dir,
            perm_mode,
            launch_mode,
            started_via,
            source_session_id,
            now,
        ],
    )
    .map_err(|error| format!("Failed to register provenance launch: {}", error))?;

    Ok(())
}

pub fn bind_source_session_id(
    client: &str,
    ccem_session_id: &str,
    source_session_id: &str,
) -> Result<(), String> {
    let client = client.trim().to_lowercase();
    let ccem_session_id = ccem_session_id.trim();
    let source_session_id = source_session_id.trim();

    if client.is_empty() || ccem_session_id.is_empty() || source_session_id.is_empty() {
        return Ok(());
    }

    let conn = open_db()?;
    let updated = conn
        .execute(
            "UPDATE session_provenance
             SET source_session_id = ?1, updated_at = ?2
             WHERE ccem_session_id = ?3 AND client = ?4",
            params![
                source_session_id,
                Utc::now().to_rfc3339(),
                ccem_session_id,
                client,
            ],
        )
        .map_err(|error| format!("Failed to bind provenance source session id: {}", error))?;

    if updated == 0 {
        return Err(format!(
            "No provenance row found for {} ({})",
            ccem_session_id, client
        ));
    }

    Ok(())
}

pub fn find_record_by_ccem_session_id(
    client: &str,
    ccem_session_id: &str,
) -> Result<Option<SessionProvenanceRecord>, String> {
    let client = client.trim().to_lowercase();
    let ccem_session_id = ccem_session_id.trim();
    if client.is_empty() || ccem_session_id.is_empty() {
        return Ok(None);
    }

    let conn = open_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT
                ccem_session_id,
                client,
                source_session_id,
                env_name,
                config_source,
                working_dir,
                perm_mode,
                launch_mode,
                started_via,
                created_at,
                updated_at
             FROM session_provenance
             WHERE client = ?1
               AND ccem_session_id = ?2
             LIMIT 1",
        )
        .map_err(|error| format!("Failed to prepare provenance lookup by ccem session: {}", error))?;

    let mut rows = stmt
        .query(params![client, ccem_session_id])
        .map_err(|error| format!("Failed to query provenance by ccem session: {}", error))?;

    let Some(row) = rows
        .next()
        .map_err(|error| format!("Failed to read provenance by ccem session: {}", error))?
    else {
        return Ok(None);
    };

    Ok(Some(SessionProvenanceRecord {
        ccem_session_id: row.get(0).map_err(|error| format!("Failed to read provenance ccem_session_id: {}", error))?,
        client: row.get(1).map_err(|error| format!("Failed to read provenance client: {}", error))?,
        source_session_id: row
            .get::<_, Option<String>>(2)
            .map_err(|error| format!("Failed to read provenance source_session_id: {}", error))?
            .unwrap_or_default(),
        env_name: row.get(3).map_err(|error| format!("Failed to read provenance env_name: {}", error))?,
        config_source: row.get(4).map_err(|error| format!("Failed to read provenance config_source: {}", error))?,
        working_dir: row.get(5).map_err(|error| format!("Failed to read provenance working_dir: {}", error))?,
        perm_mode: row.get(6).map_err(|error| format!("Failed to read provenance perm_mode: {}", error))?,
        launch_mode: row.get(7).map_err(|error| format!("Failed to read provenance launch_mode: {}", error))?,
        started_via: row.get(8).map_err(|error| format!("Failed to read provenance started_via: {}", error))?,
        created_at: row.get(9).map_err(|error| format!("Failed to read provenance created_at: {}", error))?,
        updated_at: row.get(10).map_err(|error| format!("Failed to read provenance updated_at: {}", error))?,
    }))
}

pub fn list_records_by_client(
    client: &str,
) -> Result<HashMap<String, SessionProvenanceRecord>, String> {
    let client = client.trim().to_lowercase();
    if client.is_empty() {
        return Ok(HashMap::new());
    }

    let conn = open_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT
                ccem_session_id,
                client,
                source_session_id,
                env_name,
                config_source,
                working_dir,
                perm_mode,
                launch_mode,
                started_via,
                created_at,
                updated_at
             FROM session_provenance
             WHERE client = ?1
               AND source_session_id IS NOT NULL
               AND TRIM(source_session_id) != ''
             ORDER BY updated_at ASC",
        )
        .map_err(|error| format!("Failed to prepare provenance lookup: {}", error))?;

    let rows = stmt
        .query_map([client], |row| {
            Ok(SessionProvenanceRecord {
                ccem_session_id: row.get(0)?,
                client: row.get(1)?,
                source_session_id: row.get(2)?,
                env_name: row.get(3)?,
                config_source: row.get(4)?,
                working_dir: row.get(5)?,
                perm_mode: row.get(6)?,
                launch_mode: row.get(7)?,
                started_via: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })
        .map_err(|error| format!("Failed to query provenance records: {}", error))?;

    let mut records = HashMap::new();
    for row in rows {
        let record =
            row.map_err(|error| format!("Failed to read provenance record row: {}", error))?;
        records.insert(record.source_session_id.clone(), record);
    }

    Ok(records)
}

pub fn spawn_claude_source_binding(
    ccem_session_id: String,
    project_dir: String,
    started_at: DateTime<Utc>,
    preferred_session_id: Option<String>,
) {
    if let Some(session_id) = normalize_optional_text(preferred_session_id) {
        let _ = bind_source_session_id("claude", &ccem_session_id, &session_id);
        return;
    }

    thread::spawn(move || {
        let started = Instant::now();
        while started.elapsed() < BIND_POLL_TIMEOUT {
            if let Some(path) = discover_jsonl_path(&project_dir, started_at, None) {
                if let Some(session_id) =
                    read_claude_session_id(&path).or_else(|| path_stem_string(&path))
                {
                    let _ = bind_source_session_id("claude", &ccem_session_id, &session_id);
                    return;
                }
            }

            thread::sleep(BIND_POLL_INTERVAL);
        }
    });
}

pub fn spawn_codex_source_binding(
    ccem_session_id: String,
    project_dir: String,
    started_at: DateTime<Utc>,
    preferred_session_id: Option<String>,
) {
    if let Some(session_id) = normalize_optional_text(preferred_session_id) {
        let _ = bind_source_session_id("codex", &ccem_session_id, &session_id);
        return;
    }

    thread::spawn(move || {
        let started = Instant::now();
        let earliest_modified_at = started_at
            .timestamp_millis()
            .saturating_sub(BIND_POLL_TIMEOUT.as_millis() as i64);

        while started.elapsed() < BIND_POLL_TIMEOUT {
            if let Some(session_id) =
                discover_codex_session_id(&project_dir, earliest_modified_at as u64)
            {
                let _ = bind_source_session_id("codex", &ccem_session_id, &session_id);
                return;
            }

            thread::sleep(BIND_POLL_INTERVAL);
        }
    });
}

fn open_db() -> Result<Connection, String> {
    let path = state_db_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create sqlite state dir: {}", error))?;
    }

    let conn = Connection::open(&path).map_err(|error| {
        format!(
            "Failed to open sqlite state db {}: {}",
            path.display(),
            error
        )
    })?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|error| format!("Failed to configure sqlite busy timeout: {}", error))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS session_provenance (
             ccem_session_id TEXT PRIMARY KEY,
             client TEXT NOT NULL,
             env_name TEXT NOT NULL,
             config_source TEXT,
             working_dir TEXT NOT NULL,
             perm_mode TEXT,
             launch_mode TEXT NOT NULL,
             started_via TEXT NOT NULL,
             source_session_id TEXT,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_session_provenance_client_source
             ON session_provenance (client, source_session_id);
         CREATE INDEX IF NOT EXISTS idx_session_provenance_client_updated
             ON session_provenance (client, updated_at DESC);",
    )
    .map_err(|error| format!("Failed to initialize sqlite provenance schema: {}", error))?;

    Ok(conn)
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn read_claude_session_id(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }

        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(session_id) = value.get("sessionId").and_then(|item| item.as_str()) {
            let trimmed = session_id.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

fn path_stem_string(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn discover_codex_session_id(project_dir: &str, earliest_modified_at: u64) -> Option<String> {
    let sessions_root = codex_sessions_root()?;
    if !sessions_root.exists() {
        return None;
    }

    let mut stack = vec![sessions_root];
    let mut best: Option<(u64, String)> = None;

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }

            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }

            let modified_at = file_modified_at_millis(&path);
            if modified_at < earliest_modified_at {
                continue;
            }

            let Some(session_id) = extract_codex_session_id_from_path(&path) else {
                continue;
            };

            let cwd_matches = read_codex_session_cwd(&path)
                .map(|cwd| project_dirs_match(&cwd, project_dir))
                .unwrap_or(false);
            if !cwd_matches {
                continue;
            }

            match best.as_ref() {
                Some((best_modified_at, _)) if *best_modified_at >= modified_at => {}
                _ => best = Some((modified_at, session_id)),
            }
        }
    }

    best.map(|(_, session_id)| session_id)
}

fn codex_sessions_root() -> Option<PathBuf> {
    let home_dir = dirs::home_dir()?;
    let env_base = std::env::current_dir().unwrap_or_else(|_| home_dir.clone());
    let codex_home = std::env::var("CODEX_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|raw| resolve_path_value(&raw, &home_dir, &env_base))
        .unwrap_or_else(|| home_dir.join(".codex"));
    Some(codex_home.join("sessions"))
}

fn resolve_path_value(raw: &str, home_dir: &Path, relative_base: &Path) -> PathBuf {
    if raw == "~" {
        return home_dir.to_path_buf();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home_dir.join(rest);
    }

    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        relative_base.join(path)
    }
}

fn file_modified_at_millis(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn extract_codex_session_id_from_path(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    if stem.len() < 36 {
        return None;
    }

    let candidate = &stem[stem.len() - 36..];
    looks_like_uuid(candidate).then(|| candidate.to_string())
}

fn looks_like_uuid(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }

    for (idx, ch) in value.chars().enumerate() {
        if matches!(idx, 8 | 13 | 18 | 23) {
            if ch != '-' {
                return false;
            }
            continue;
        }

        if !ch.is_ascii_hexdigit() {
            return false;
        }
    }

    true
}

fn read_codex_session_cwd(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }

        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(|item| item.as_str()) != Some("session_meta") {
            continue;
        }

        let cwd = value
            .get("payload")
            .and_then(|payload| payload.get("cwd"))
            .and_then(|cwd| cwd.as_str())?;
        let trimmed = cwd.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    None
}

fn project_dirs_match(left: &str, right: &str) -> bool {
    normalize_project_dir(left) == normalize_project_dir(right)
}

fn normalize_project_dir(value: &str) -> String {
    fs::canonicalize(value)
        .unwrap_or_else(|_| PathBuf::from(value))
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        bind_source_session_id, find_record_by_ccem_session_id, list_records_by_client, register_launch,
        spawn_codex_source_binding, state_db_path, SessionProvenanceUpsert,
    };
    use chrono::Utc;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};
    use std::thread;
    use std::time::Duration;

    fn env_guard() -> &'static Mutex<()> {
        static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
        GUARD.get_or_init(|| Mutex::new(()))
    }

    fn temp_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("ccem-provenance-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    #[test]
    fn register_and_bind_records_can_be_looked_up_by_client() {
        let _guard = env_guard().lock().expect("lock env guard");
        let root = temp_root("register-bind");
        let db_path = root.join("state.sqlite");
        std::env::set_var("CCEM_STATE_DB_PATH", &db_path);

        register_launch(SessionProvenanceUpsert {
            ccem_session_id: "ccem-1".to_string(),
            client: "claude".to_string(),
            env_name: "Kimi".to_string(),
            config_source: Some("ccem".to_string()),
            working_dir: "/tmp/project".to_string(),
            perm_mode: Some("dev".to_string()),
            launch_mode: "external_terminal".to_string(),
            started_via: "desktop".to_string(),
            source_session_id: None,
        })
        .expect("register launch");
        bind_source_session_id("claude", "ccem-1", "native-1").expect("bind source session id");
        let by_ccem = find_record_by_ccem_session_id("claude", "ccem-1")
            .expect("lookup by ccem")
            .expect("record present");
        assert_eq!(by_ccem.source_session_id, "native-1");
        assert!(find_record_by_ccem_session_id("claude", "missing")
            .expect("lookup missing")
            .is_none());


        let records = list_records_by_client("claude").expect("list records");
        let record = records.get("native-1").expect("native lookup");
        assert_eq!(record.env_name, "Kimi");
        assert_eq!(record.config_source.as_deref(), Some("ccem"));
        assert_eq!(record.working_dir, "/tmp/project");

        std::env::remove_var("CCEM_STATE_DB_PATH");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_binding_scans_rollout_files_for_matching_project() {
        let _guard = env_guard().lock().expect("lock env guard");
        let root = temp_root("codex-scan");
        let db_path = root.join("state.sqlite");
        let codex_home = root.join(".codex");
        let sessions_root = codex_home
            .join("sessions")
            .join("2026")
            .join("04")
            .join("17");
        let rollout_path = sessions_root
            .join("rollout-2026-04-17T12-00-00-019d7d58-6c57-76d3-8712-d9126006a5cb.jsonl");

        std::env::set_var("CCEM_STATE_DB_PATH", &db_path);
        std::env::set_var("CODEX_HOME", &codex_home);
        fs::create_dir_all(&sessions_root).expect("create codex sessions root");
        fs::write(
            &rollout_path,
            "{\"timestamp\":\"2026-04-17T12:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/tmp/codex-project\"}}\n",
        )
        .expect("write rollout file");

        register_launch(SessionProvenanceUpsert {
            ccem_session_id: "ccem-codex".to_string(),
            client: "codex".to_string(),
            env_name: "OpenAI".to_string(),
            config_source: Some("ccem".to_string()),
            working_dir: "/tmp/codex-project".to_string(),
            perm_mode: None,
            launch_mode: "interactive".to_string(),
            started_via: "desktop".to_string(),
            source_session_id: None,
        })
        .expect("register codex launch");

        spawn_codex_source_binding(
            "ccem-codex".to_string(),
            "/tmp/codex-project".to_string(),
            Utc::now(),
            None,
        );

        thread::sleep(Duration::from_millis(1200));

        let records = list_records_by_client("codex").expect("list codex records");
        assert!(records.contains_key("019d7d58-6c57-76d3-8712-d9126006a5cb"));
        assert_eq!(state_db_path(), db_path);

        std::env::remove_var("CCEM_STATE_DB_PATH");
        std::env::remove_var("CODEX_HOME");
        let _ = fs::remove_dir_all(root);
    }
}
