//! Add newly installed official Claude plugins to the independent CCEM profile.
//! A seen plugin is never refreshed: CCEM disables, uninstalls, and updates
//! remain local decisions, even when the official installation changes later.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::{create_private_dir, sync_directory, validate_no_symlinks, TEMP_SEQUENCE};

const LEDGER: &str = ".ccem-plugins-import-v1.json";
const BACKUP: &str = ".ccem-plugins-backup-v1";
const INSTALLED: &str = "plugins/installed_plugins.json";
const MARKETPLACES: &str = "plugins/known_marketplaces.json";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Identity {
    scope: String,
    project_path: Option<String>,
}

impl Identity {
    fn read(value: &Value) -> Result<Self, String> {
        let scope = value
            .get("scope")
            .and_then(Value::as_str)
            .ok_or("Missing plugin scope")?;
        let project_path = match value.get("projectPath") {
            None | Some(Value::Null) => None,
            Some(Value::String(path)) => Some(path.clone()),
            _ => return Err("Invalid plugin project path".into()),
        };
        let identity = Self {
            scope: scope.into(),
            project_path,
        };
        identity.validate()?;
        Ok(identity)
    }

    fn validate(&self) -> Result<(), String> {
        match (self.scope.as_str(), self.project_path.as_deref()) {
            ("user", None) => Ok(()),
            ("project" | "local", Some(path)) if safe_absolute(Path::new(path)) => Ok(()),
            _ => Err("Invalid plugin installation scope or project path".into()),
        }
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    version: u8,
    seen: BTreeMap<String, Vec<Identity>>,
}

#[derive(Clone)]
struct Snapshot {
    path: PathBuf,
    bytes: Option<Vec<u8>>,
}

impl Snapshot {
    fn read(path: PathBuf) -> Result<Self, String> {
        validate_no_symlinks(&path)?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("Could not read plugin metadata: {error}")),
        };
        Ok(Self { path, bytes })
    }

    fn value(&self, default: Value) -> Result<Value, String> {
        match &self.bytes {
            Some(bytes) => {
                serde_json::from_slice(bytes).map_err(|_| "Invalid plugin metadata JSON".into())
            }
            None => Ok(default),
        }
    }

    fn unchanged(&self) -> Result<(), String> {
        if Self::read(self.path.clone())?.bytes != self.bytes {
            return Err(
                "Plugin metadata changed during import; retry on the next preparation".into(),
            );
        }
        Ok(())
    }
}

fn safe_absolute(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
}

fn reject_plugin_data(path: &Path, root: &Path) -> Result<(), String> {
    // Only the store's top-level data directory is mutable plugin state.
    // A plugin's own cache/.../data directory can contain ordinary assets.
    let data = root.join("data");
    if path.starts_with(&data)
        || data
            .canonicalize()
            .ok()
            .is_some_and(|data| path.starts_with(data))
    {
        return Err("Claude plugin runtime data must not be imported".into());
    }
    Ok(())
}

fn marketplace(id: &str) -> Result<&str, String> {
    let (name, market) = id.rsplit_once('@').ok_or("Invalid plugin identifier")?;
    let valid = |value: &str| {
        value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    };
    if !valid(name) || !valid(market) {
        return Err("Invalid plugin identifier".into());
    }
    Ok(market)
}

fn read_ledger(snapshot: &Snapshot) -> Result<Ledger, String> {
    let Some(bytes) = &snapshot.bytes else {
        return Ok(Ledger {
            version: 1,
            seen: BTreeMap::new(),
        });
    };
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| "Invalid CCEM plugin import ledger")?;
    if let Some(seen) = value.get("seen").and_then(Value::as_object) {
        for identities in seen.values() {
            if let Some(identities) = identities.as_array() {
                if identities
                    .iter()
                    .any(|identity| identity.get("projectPath").is_none())
                {
                    return Err("Missing CCEM plugin import projectPath".into());
                }
            }
        }
    }
    let ledger: Ledger =
        serde_json::from_value(value).map_err(|_| "Invalid CCEM plugin import ledger")?;
    if ledger.version != 1 {
        return Err("Unsupported CCEM plugin import ledger".into());
    }
    for (id, identities) in &ledger.seen {
        marketplace(id)?;
        if identities.is_empty() {
            return Err("Empty CCEM plugin import identity list".into());
        }
        for (index, identity) in identities.iter().enumerate() {
            identity.validate()?;
            if identities[..index].contains(identity) {
                return Err("Duplicate CCEM plugin import identity".into());
            }
        }
    }
    Ok(ledger)
}

fn registry(value: &Value) -> Result<&Map<String, Value>, String> {
    if value.get("version").and_then(Value::as_u64) != Some(2) {
        return Err("Unsupported Claude plugin registry version".into());
    }
    let plugins = value
        .get("plugins")
        .and_then(Value::as_object)
        .ok_or("Invalid Claude plugin registry")?;
    for (id, installs) in plugins {
        marketplace(id)?;
        let installs = installs
            .as_array()
            .ok_or("Invalid plugin installation list")?;
        let mut identities = Vec::new();
        for install in installs {
            let identity = Identity::read(install)?;
            if identities.contains(&identity) {
                return Err("Duplicate plugin installation identity".into());
            }
            identities.push(identity);
        }
    }
    Ok(plugins)
}

fn empty_registry() -> Value {
    json!({"version":2,"plugins":{}})
}

/// A read-only fast path keeps ordinary preparations free of migration writes.
pub(super) fn import_pending(source: &Path, target: &Path) -> Result<bool, String> {
    let ledger = read_ledger(&Snapshot::read(target.join(LEDGER))?)?;
    let installed = Snapshot::read(source.join(INSTALLED))?;
    if installed.bytes.is_none() {
        return Ok(false);
    }
    let installed = installed.value(empty_registry())?;
    for (id, installs) in registry(&installed)? {
        if !ledger.seen.contains_key(id) && !installs.as_array().unwrap().is_empty() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Called under the agent profile's process and filesystem preparation locks.
pub(super) fn import_plugins(source: &Path, target: &Path) -> Result<(), String> {
    import_with_check(source, target, || Ok(()))
}

fn import_with_check(
    source: &Path,
    target: &Path,
    before_publish: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let source_registry = Snapshot::read(source.join(INSTALLED))?;
    let ledger_snapshot = Snapshot::read(target.join(LEDGER))?;
    let mut ledger = read_ledger(&ledger_snapshot)?;
    if source_registry.bytes.is_none() {
        return Ok(());
    }
    let source_value = source_registry.value(empty_registry())?;
    let source_plugins = registry(&source_value)?;
    let mut pending = Vec::new();
    for (id, installs) in source_plugins {
        // The first observed set of scopes is terminal for this plugin id.
        // A later official scope change must not undo a CCEM uninstall.
        if ledger.seen.contains_key(id) {
            continue;
        }
        for install in installs.as_array().unwrap() {
            let identity = Identity::read(install)?;
            pending.push((id.clone(), identity, install.clone()));
        }
    }
    if pending.is_empty() {
        return Ok(());
    }

    let target_registry = Snapshot::read(target.join(INSTALLED))?;
    let mut target_value = target_registry.value(empty_registry())?;
    registry(&target_value)?;
    let source_settings = Snapshot::read(source.join("settings.json"))?;
    let source_settings_value = source_settings.value(json!({}))?;
    let target_settings = Snapshot::read(target.join("settings.json"))?;
    let mut target_settings_value = target_settings.value(json!({}))?;
    for settings in [&source_settings_value, &target_settings_value] {
        if !settings.is_object() {
            return Err("Invalid Claude settings object".into());
        }
        for key in ["enabledPlugins", "extraKnownMarketplaces"] {
            if settings.get(key).is_some_and(|value| !value.is_object()) {
                return Err(format!("Invalid Claude {key} settings"));
            }
        }
    }
    let source_markets = Snapshot::read(source.join(MARKETPLACES))?;
    let source_markets_value = source_markets.value(json!({}))?;
    let target_markets = Snapshot::read(target.join(MARKETPLACES))?;
    let mut target_markets_value = target_markets.value(json!({}))?;
    if !source_markets_value.is_object() || !target_markets_value.is_object() {
        return Err("Invalid known plugin marketplaces".into());
    }

    let source_root = source.join("plugins");
    validate_no_symlinks(&source_root)?;
    let source_root = source_root
        .canonicalize()
        .map_err(|error| format!("Could not inspect source plugins: {error}"))?;
    let target_root = target.join("plugins");
    validate_no_symlinks(&target_root)?;
    let resolved_target = super::resolve_existing_parent(&target_root)?;
    if source_root.starts_with(&resolved_target) || resolved_target.starts_with(&source_root) {
        return Err("Official and CCEM plugin stores must not overlap".into());
    }
    let mut assets = BTreeMap::new();
    let mut asset_edits = BTreeMap::new();
    let mut markets = BTreeSet::new();
    let mut sources = vec![source_registry, source_settings, source_markets];
    let mut targets = vec![
        target_registry.clone(),
        target_settings.clone(),
        target_markets.clone(),
        ledger_snapshot.clone(),
    ];
    let mut changes = Vec::new();
    let new_ids = pending
        .iter()
        .filter(|(id, _, _)| !ledger.seen.contains_key(id))
        .map(|(id, _, _)| id.clone())
        .collect::<BTreeSet<_>>();

    for (id, identity, mut install) in pending {
        let plugins = target_value
            .get_mut("plugins")
            .unwrap()
            .as_object_mut()
            .unwrap();
        let installs = plugins
            .entry(id.clone())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap();
        if !installs
            .iter()
            .any(|existing| Identity::read(existing).ok().as_ref() == Some(&identity))
        {
            let path = install
                .get("installPath")
                .and_then(Value::as_str)
                .ok_or("Missing plugin install path")?;
            let rebased = rebase_path(path, &source_root, &target_root, &mut assets)?;
            install["installPath"] = Value::String(rebased);
            installs.push(install);
            markets.insert(marketplace(&id)?.to_string());
        }
        ledger.seen.entry(id).or_default().push(identity);
    }

    for id in &new_ids {
        let has_user_install = ledger.seen[id]
            .iter()
            .any(|identity| identity.scope == "user");
        if has_user_install {
            if let Some(enabled) = source_settings_value
                .get("enabledPlugins")
                .and_then(|enabled| enabled.get(id))
            {
                if !enabled.is_boolean() {
                    return Err("Invalid plugin enable flag".into());
                }
                merge_setting(
                    &mut target_settings_value,
                    "enabledPlugins",
                    id,
                    enabled.clone(),
                );
            }
        }
        let market = marketplace(id)?;
        if let Some(extra) = source_settings_value
            .get("extraKnownMarketplaces")
            .and_then(|extra| extra.get(market))
        {
            if !target_settings_value
                .get("extraKnownMarketplaces")
                .is_some_and(|extra| extra.get(market).is_some())
            {
                let mut extra = extra.clone();
                rebase_marketplace(&mut extra, &source_root, &target_root, &mut assets)?;
                merge_setting(
                    &mut target_settings_value,
                    "extraKnownMarketplaces",
                    market,
                    extra,
                );
            }
        }
    }
    for market in markets {
        if let Some(existing) = target_markets_value.get(&market) {
            merge_manifest_entries(
                &market,
                existing,
                source_markets_value
                    .get(&market)
                    .ok_or("Missing official plugin marketplace registration")?,
                &new_ids,
                &source_root,
                &target_root,
                &mut assets,
                &mut sources,
                &mut targets,
                &mut changes,
            )?;
        } else {
            if let Some(entry) = source_markets_value.get(&market) {
                let location = marketplace_location(entry, &source_root)?;
                let manifest = source_manifest(&location, &source_root)?;
                let mut value = manifest.value(Value::Null)?;
                let entries = value
                    .get("plugins")
                    .and_then(Value::as_array)
                    .ok_or("Invalid official marketplace manifest")?;
                for id in new_ids
                    .iter()
                    .filter(|id| marketplace(id).ok() == Some(market.as_str()))
                {
                    let name = id.rsplit_once('@').unwrap().0;
                    if !entries
                        .iter()
                        .any(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
                    {
                        return Err("Missing new plugin in official marketplace manifest".into());
                    }
                }
                sources.push(manifest);
                let mut entry = entry.clone();
                rebase_marketplace(&mut entry, &source_root, &target_root, &mut assets)?;
                let original = value.clone();
                let target_location = PathBuf::from(
                    entry
                        .get("installLocation")
                        .and_then(Value::as_str)
                        .ok_or("Missing rebased marketplace location")?,
                );
                rebase_initial_manifest(
                    &mut value,
                    &location,
                    &target_location,
                    &source_root,
                    &target_root,
                    &mut assets,
                )?;
                if original != value {
                    let manifest_target = Path::new(
                        entry
                            .get("installLocation")
                            .and_then(Value::as_str)
                            .ok_or("Missing rebased marketplace location")?,
                    )
                    .join(".claude-plugin/marketplace.json");
                    asset_edits.insert(manifest_target, json_bytes(&value)?);
                }
                target_markets_value[market] = entry;
            } else {
                return Err("Missing official plugin marketplace registration".into());
            }
        }
    }

    for (snapshot, value) in [
        (&target_settings, target_settings_value),
        (&target_markets, target_markets_value),
        (&target_registry, target_value),
    ] {
        // Missing metadata stays missing unless there is actual content to add.
        if snapshot.value(if snapshot.path.ends_with("installed_plugins.json") {
            empty_registry()
        } else {
            json!({})
        })? != value
        {
            changes.push((snapshot.clone(), json_bytes(&value)?));
        }
    }
    changes.push((
        ledger_snapshot,
        json_bytes(&serde_json::to_value(ledger).map_err(|error| error.to_string())?)?,
    ));
    let asset_paths = assets.keys().cloned().collect::<Vec<_>>();
    assets.retain(|path, _| {
        !asset_paths
            .iter()
            .any(|ancestor| path != ancestor && path.starts_with(ancestor))
    });
    let stage = Stage::new(target)?;
    let mut staged_assets = Vec::new();
    for (index, (destination, original)) in assets.into_iter().enumerate() {
        reject_plugin_data(&destination, &target_root)?;
        let staged = stage.path.join(format!("asset-{index}"));
        copy_asset(&original, &staged, &source_root, &mut BTreeSet::new())?;
        for (path, bytes) in &asset_edits {
            if let Ok(relative) = path.strip_prefix(&destination) {
                let edited = staged.join(relative);
                validate_no_symlinks(&edited)?;
                fs::write(&edited, bytes).map_err(|error| error.to_string())?;
                OpenOptions::new()
                    .write(true)
                    .open(&edited)
                    .and_then(|file| file.sync_all())
                    .map_err(|error| error.to_string())?;
            }
        }
        validate_no_symlinks(&destination)?;
        if destination.exists() {
            validate_asset_tree(&destination)?;
            if !same_tree(&staged, &destination)? {
                return Err(
                    "Existing CCEM plugin assets conflict with an import; left unchanged".into(),
                );
            }
        }
        staged_assets.push((staged, destination));
    }
    before_publish()?;
    for snapshot in sources.iter().chain(targets.iter()) {
        snapshot.unchanged()?;
    }
    for (snapshot, _) in &changes {
        backup(snapshot, target)?;
    }
    for (staged, destination) in staged_assets {
        publish_asset(&staged, &destination)?;
    }
    for (snapshot, bytes) in changes {
        for source in &sources {
            source.unchanged()?;
        }
        snapshot.unchanged()?;
        replace_metadata(&snapshot, &bytes, &sources, &targets)?;
        if let Some(target) = targets
            .iter_mut()
            .find(|target| target.path == snapshot.path)
        {
            target.bytes = Some(bytes);
        }
    }
    Ok(())
}

fn marketplace_location(value: &Value, root: &Path) -> Result<PathBuf, String> {
    let path = PathBuf::from(
        value
            .get("installLocation")
            .and_then(Value::as_str)
            .ok_or("Missing plugin marketplace location")?,
    );
    if !safe_absolute(&path) {
        return Err("Plugin marketplace location must stay inside its plugins directory".into());
    }
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin marketplace: {error}"))?;
    let resolved_root = root
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugins root: {error}"))?;
    if !resolved.starts_with(&resolved_root) || resolved == resolved_root {
        return Err("Plugin marketplace location must stay inside its plugins directory".into());
    }
    reject_plugin_data(&path, root)?;
    reject_plugin_data(&resolved, &resolved_root)?;
    Ok(path)
}

fn source_manifest(location: &Path, root: &Path) -> Result<Snapshot, String> {
    let path = location
        .join(".claude-plugin/marketplace.json")
        .canonicalize()
        .map_err(|error| format!("Could not resolve marketplace manifest: {error}"))?;
    if !path.starts_with(root) {
        return Err("Marketplace manifest escapes the official plugins directory".into());
    }
    reject_plugin_data(&path, root)?;
    Snapshot::read(path)
}

fn merge_manifest_entries(
    market: &str,
    existing: &Value,
    official: &Value,
    new_ids: &BTreeSet<String>,
    source_root: &Path,
    target_root: &Path,
    assets: &mut BTreeMap<PathBuf, PathBuf>,
    sources: &mut Vec<Snapshot>,
    targets: &mut Vec<Snapshot>,
    changes: &mut Vec<(Snapshot, Vec<u8>)>,
) -> Result<(), String> {
    let source_location = marketplace_location(official, source_root)?;
    let target_location = marketplace_location(existing, target_root)?;
    validate_no_symlinks(&target_location)?;
    let source = source_manifest(&source_location, source_root)?;
    let target = Snapshot::read(target_location.join(".claude-plugin/marketplace.json"))?;
    let source_value = source.value(Value::Null)?;
    let mut target_value = target.value(Value::Null)?;
    let official_plugins = source_value
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or("Invalid official marketplace manifest")?;
    let target_plugins = target_value
        .get_mut("plugins")
        .and_then(Value::as_array_mut)
        .ok_or("Invalid CCEM marketplace manifest")?;
    let before = target_plugins.len();
    for id in new_ids {
        let (name, plugin_market) = id.rsplit_once('@').unwrap();
        if plugin_market != market
            || target_plugins
                .iter()
                .any(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
        {
            continue;
        }
        let mut entry = official_plugins
            .iter()
            .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
            .ok_or("Missing new plugin in official marketplace manifest")?
            .clone();
        rebase_catalogue_entry(
            &mut entry,
            &source_location,
            &target_location,
            source_root,
            target_root,
            assets,
        )?;
        target_plugins.push(entry);
    }
    targets.push(target.clone());
    if target_plugins.len() != before {
        changes.push((target, json_bytes(&target_value)?));
    }
    sources.push(source);
    Ok(())
}

fn merge_setting(settings: &mut Value, section: &str, key: &str, value: Value) {
    settings
        .as_object_mut()
        .unwrap()
        .entry(section)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .unwrap()
        .entry(key)
        .or_insert(value);
}

fn rebase_path(
    path: &str,
    source: &Path,
    target: &Path,
    assets: &mut BTreeMap<PathBuf, PathBuf>,
) -> Result<String, String> {
    let path = Path::new(path);
    if !safe_absolute(path) {
        return Err("Plugin asset path must be absolute without '..'".into());
    }
    reject_plugin_data(path, source)?;
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin assets: {error}"))?;
    if !resolved.starts_with(source) {
        return Err("Plugin asset symlink escapes the official plugins directory".into());
    }
    reject_plugin_data(&resolved, source)?;
    // Windows canonical roots have a verbatim prefix; registries commonly keep
    // ordinary drive paths. Resolve the suffix without rejecting that alias.
    let relative = path
        .strip_prefix(source)
        .or_else(|_| resolved.strip_prefix(source))
        .map_err(|_| "Plugin asset path is outside the official plugins directory")?;
    if relative.as_os_str().is_empty() {
        return Err("Plugin asset path cannot be the plugins root".into());
    }
    let destination = target.join(relative);
    reject_plugin_data(&destination, target)?;
    validate_no_symlinks(&destination)?;
    assets.insert(destination.clone(), path.to_path_buf());
    Ok(destination.to_string_lossy().into_owned())
}

fn rebase_marketplace(
    value: &mut Value,
    source: &Path,
    target: &Path,
    assets: &mut BTreeMap<PathBuf, PathBuf>,
) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            let local_source = matches!(
                object.get("source").and_then(Value::as_str),
                Some("directory" | "file")
            );
            for (key, value) in object {
                if matches!(key.as_str(), "installLocation" | "installPath")
                    || (key == "path" && local_source)
                {
                    if let Value::String(path) = value {
                        *path = rebase_path(path, source, target, assets)?;
                        continue;
                    }
                }
                rebase_marketplace(value, source, target, assets)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                rebase_marketplace(value, source, target, assets)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn rebase_initial_manifest(
    value: &mut Value,
    from: &Path,
    to: &Path,
    source: &Path,
    target: &Path,
    assets: &mut BTreeMap<PathBuf, PathBuf>,
) -> Result<(), String> {
    let plugins = value
        .get_mut("plugins")
        .and_then(Value::as_array_mut)
        .ok_or("Invalid official marketplace manifest")?;
    for plugin in plugins {
        rebase_catalogue_entry(plugin, from, to, source, target, assets)?;
    }
    Ok(())
}

fn rebase_catalogue_entry(
    entry: &mut Value,
    from: &Path,
    to: &Path,
    source: &Path,
    target: &Path,
    assets: &mut BTreeMap<PathBuf, PathBuf>,
) -> Result<(), String> {
    let entry = entry
        .as_object_mut()
        .ok_or("Invalid marketplace plugin entry")?;
    let local = match entry.get_mut("source") {
        Some(value @ Value::String(_)) => Some(value),
        Some(Value::Object(object))
            if matches!(
                object.get("source").and_then(Value::as_str),
                Some("directory" | "file")
            ) =>
        {
            Some(
                object
                    .get_mut("path")
                    .ok_or("Missing local marketplace source path")?,
            )
        }
        _ => None,
    };
    if let Some(local) = local {
        let path = local
            .as_str()
            .ok_or("Invalid local marketplace source path")?;
        if Path::new(path).is_absolute() {
            *local = Value::String(rebase_path(path, source, target, assets)?);
        } else {
            let original = from.join(path);
            let destination = to.join(path);
            if !safe_absolute(&original) || !safe_absolute(&destination) {
                return Err("Invalid local marketplace plugin source".into());
            }
            let resolved = original
                .canonicalize()
                .map_err(|error| format!("Could not resolve local plugin source: {error}"))?;
            if !resolved.starts_with(source) {
                return Err("Local marketplace plugin source escapes plugins directory".into());
            }
            reject_plugin_data(&original, source)?;
            reject_plugin_data(&resolved, source)?;
            reject_plugin_data(&destination, target)?;
            validate_no_symlinks(&destination)?;
            assets.insert(destination, original);
        }
    }
    // Remote source.path fields are repository-relative, not local file paths.
    for (key, value) in entry {
        if key != "source" {
            rebase_marketplace(value, source, target, assets)?;
        }
    }
    Ok(())
}

struct Stage {
    path: PathBuf,
}
impl Stage {
    fn new(target: &Path) -> Result<Self, String> {
        create_private_dir(target)?;
        let path = target.join(format!(
            ".ccem-plugins-stage-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).map_err(|error| format!("Could not stage plugin import: {error}"))?;
        create_private_dir(&path)?;
        Ok(Self { path })
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn copy_asset(
    source: &Path,
    target: &Path,
    root: &Path,
    ancestors: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    reject_plugin_data(source, root)?;
    let resolved = source
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin asset: {error}"))?;
    if !resolved.starts_with(root) {
        return Err("Plugin asset symlink escapes the official plugins directory".into());
    }
    reject_plugin_data(&resolved, root)?;
    if !ancestors.insert(resolved.clone()) {
        return Err("Plugin asset symlink cycle".into());
    }
    let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        create_private_dir(target)?;
        for entry in fs::read_dir(&resolved).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            copy_asset(
                &entry.path(),
                &target.join(entry.file_name()),
                root,
                ancestors,
            )?;
        }
    } else if metadata.is_file() {
        let mut input = super::open_source_without_symlink(&resolved)?;
        let opened = input.metadata().map_err(|error| error.to_string())?;
        if !opened.is_file() {
            return Err("Plugin asset changed during import".into());
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(target).map_err(|error| error.to_string())?;
        let copied = io::copy(
            &mut Read::by_ref(&mut input).take(opened.len()),
            &mut output,
        )
        .map_err(|error| format!("Could not copy plugin asset: {error}"))?;
        let after = input.metadata().map_err(|error| error.to_string())?;
        if copied != opened.len()
            || after.len() != opened.len()
            || after.modified().ok() != opened.modified().ok()
        {
            return Err("Plugin asset changed during import".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                target,
                fs::Permissions::from_mode(0o600 | (opened.permissions().mode() & 0o111)),
            )
            .map_err(|error| error.to_string())?;
        }
        output.sync_all().map_err(|error| error.to_string())?;
    } else {
        return Err("Unsupported plugin asset file type".into());
    }
    ancestors.remove(&resolved);
    Ok(())
}

fn validate_asset_tree(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Existing CCEM plugin assets cannot contain symlinks".into());
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            validate_asset_tree(&entry.map_err(|error| error.to_string())?.path())?;
        }
    } else if !metadata.is_file() {
        return Err("Unsupported existing CCEM plugin asset file type".into());
    }
    Ok(())
}

fn same_tree(left: &Path, right: &Path) -> Result<bool, String> {
    validate_no_symlinks(right)?;
    let left_meta = fs::metadata(left).map_err(|error| error.to_string())?;
    let right_meta = fs::symlink_metadata(right).map_err(|error| error.to_string())?;
    if left_meta.is_file() && right_meta.is_file() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if left_meta.permissions().mode() & 0o111 != right_meta.permissions().mode() & 0o111 {
                return Ok(false);
            }
        }
        return Ok(fs::read(left).map_err(|error| error.to_string())?
            == fs::read(right).map_err(|error| error.to_string())?);
    }
    if !left_meta.is_dir() || !right_meta.is_dir() {
        return Ok(false);
    }
    let entries = |path| -> Result<BTreeSet<_>, String> {
        fs::read_dir(path)
            .map_err(|error| error.to_string())?
            .map(|entry| {
                entry
                    .map(|entry| entry.file_name())
                    .map_err(|error| error.to_string())
            })
            .collect()
    };
    let left_entries = entries(left)?;
    for entry in left_entries {
        validate_no_symlinks(&right.join(&entry))?;
        if right.join(&entry).exists() && !same_tree(&left.join(&entry), &right.join(entry))? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn publish_asset(staged: &Path, destination: &Path) -> Result<(), String> {
    validate_no_symlinks(destination)?;
    if destination.exists() {
        if !same_tree(staged, destination)? {
            return Err("Plugin assets changed during import".into());
        }
        if staged.is_dir() {
            for entry in fs::read_dir(staged).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                publish_asset(&entry.path(), &destination.join(entry.file_name()))?;
            }
        }
        return Ok(());
    }
    create_private_dir(destination.parent().ok_or("Missing plugin asset parent")?)?;
    if staged.is_file() {
        match fs::hard_link(staged, destination) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if !same_tree(staged, destination)? {
                    return Err("Plugin asset appeared during import".into());
                }
            }
            Err(error) => return Err(format!("Could not publish plugin asset: {error}")),
        }
    } else {
        fs::rename(staged, destination)
            .map_err(|error| format!("Could not publish plugin assets: {error}"))?;
    }
    sync_directory(destination.parent().unwrap())
}

fn json_bytes(value: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn backup(snapshot: &Snapshot, target: &Path) -> Result<(), String> {
    let Some(bytes) = &snapshot.bytes else {
        return Ok(());
    };
    let relative = match snapshot.path.strip_prefix(target) {
        Ok(relative) => relative.to_path_buf(),
        Err(_) => snapshot
            .path
            .canonicalize()
            .map_err(|error| error.to_string())?
            .strip_prefix(target.canonicalize().map_err(|error| error.to_string())?)
            .map_err(|_| "Invalid plugin backup path")?
            .to_path_buf(),
    };
    let path = target.join(BACKUP).join(relative);
    validate_no_symlinks(&path)?;
    if path.exists() {
        return Ok(());
    }
    super::publish_bytes(&path, bytes)
}

fn replace_metadata(
    snapshot: &Snapshot,
    bytes: &[u8],
    sources: &[Snapshot],
    targets: &[Snapshot],
) -> Result<(), String> {
    let parent = snapshot
        .path
        .parent()
        .ok_or("Missing plugin metadata parent")?;
    create_private_dir(parent)?;
    let temp = parent.join(format!(
        ".ccem-plugins-{}-{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|error| error.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        for metadata in sources.iter().chain(targets.iter()) {
            metadata.unchanged()?;
        }
        snapshot.unchanged()?;
        fs::rename(&temp, &snapshot.path)
            .map_err(|error| format!("Could not publish plugin metadata: {error}"))?;
        sync_directory(parent)
    })();
    let _ = fs::remove_file(&temp);
    result
}

#[cfg(test)]
#[path = "agent_plugins_tests.rs"]
mod tests;
