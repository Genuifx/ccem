//! Link only imported plugin code. Registries, settings, markers and runtime
//! data remain private; old independent copies and wrappers are never removed.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{create_private_dir, sync_directory, validate_no_symlinks, TEMP_SEQUENCE};

const IMPORTS: &str = ".ccem-plugins-import-v1.json";
const LEDGER: &str = ".ccem-plugin-links-v1.json";
const MARKER: &str = ".ccem-plugin-link-v1.json";
const BACKUP: &str = ".ccem-plugin-links-backup-v1";
const INSTALLED: &str = "plugins/installed_plugins.json";
const KNOWN: &str = "plugins/known_marketplaces.json";
const EXCLUDED: &[&str] = &[".in_use", ".orphaned_at", MARKER, ".git"];

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Identity {
    scope: String,
    project_path: Option<String>,
}

impl Identity {
    fn read(value: &Value, explicit: bool) -> Result<Self, String> {
        let scope = value
            .get("scope")
            .and_then(Value::as_str)
            .ok_or("Invalid plugin scope")?;
        let project_path = match value.get("projectPath") {
            None if !explicit => None,
            Some(Value::Null) => None,
            Some(Value::String(path)) => Some(path.clone()),
            _ => return Err("Invalid plugin projectPath".into()),
        };
        match (scope, project_path.as_deref()) {
            ("user", None) => {}
            ("project" | "local", Some(path)) if safe_absolute(Path::new(path)) => {}
            _ => return Err("Invalid plugin installation identity".into()),
        }
        Ok(Self {
            scope: scope.into(),
            project_path,
        })
    }

    fn value(&self) -> Value {
        json!({"scope":self.scope,"projectPath":self.project_path})
    }
}

fn safe_absolute(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
}

fn plugin_parts(id: &str) -> Result<(&str, &str), String> {
    let (name, market) = id.split_once('@').ok_or("Invalid plugin identifier")?;
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
    Ok((name, market))
}

fn safe_version(version: &str) -> bool {
    version
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
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
            Err(error) => return Err(format!("Could not read plugin link metadata: {error}")),
        };
        Ok(Self { path, bytes })
    }
    fn value(&self, default: Value) -> Result<Value, String> {
        self.bytes
            .as_ref()
            .map(|bytes| {
                serde_json::from_slice(bytes)
                    .map_err(|_| "Invalid plugin link metadata JSON".into())
            })
            .unwrap_or(Ok(default))
    }
    fn unchanged(&self) -> Result<(), String> {
        if Self::read(self.path.clone())?.bytes != self.bytes {
            return Err("Plugin metadata changed during linking; retry on next preparation".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
enum Entry {
    Local(Identity),
    Managed {
        identity: Identity,
        source: PathBuf,
        install: PathBuf,
        version: String,
    },
}

impl Entry {
    fn identity(&self) -> &Identity {
        match self {
            Self::Local(identity) | Self::Managed { identity, .. } => identity,
        }
    }
    fn value(&self) -> Value {
        let mut value = self.identity().value();
        match self {
            Self::Local(_) => value["local"] = json!(true),
            Self::Managed {
                source,
                install,
                version,
                ..
            } => {
                value["sourcePath"] = json!(source);
                value["installPath"] = json!(install);
                value["version"] = json!(version);
            }
        }
        value
    }
}

type Ledger = BTreeMap<String, Vec<Entry>>;
type Imported = BTreeMap<String, Vec<Identity>>;

fn read_imports(value: Value) -> Result<Imported, String> {
    let object = value.as_object().ok_or("Invalid plugin import ledger")?;
    if object.len() != 2 || object.get("version") != Some(&json!(1)) {
        return Err("Invalid plugin import ledger".into());
    }
    let mut result = BTreeMap::new();
    for (id, rows) in object
        .get("seen")
        .and_then(Value::as_object)
        .ok_or("Invalid plugin import ledger")?
    {
        plugin_parts(id)?;
        let rows = rows
            .as_array()
            .filter(|rows| !rows.is_empty())
            .ok_or("Invalid imported plugin identities")?;
        let mut identities = Vec::new();
        for row in rows {
            if row.as_object().is_none_or(|row| row.len() != 2) {
                return Err("Invalid imported identity fields".into());
            }
            let identity = Identity::read(row, true)?;
            if identities.contains(&identity) {
                return Err("Duplicate imported plugin identity".into());
            }
            identities.push(identity);
        }
        result.insert(id.clone(), identities);
    }
    Ok(result)
}

fn read_ledger(value: Value) -> Result<Ledger, String> {
    let object = value.as_object().ok_or("Invalid plugin links ledger")?;
    if object.len() != 2 || object.get("version") != Some(&json!(1)) {
        return Err("Invalid plugin links ledger".into());
    }
    let mut result = BTreeMap::new();
    for (id, rows) in object
        .get("plugins")
        .and_then(Value::as_object)
        .ok_or("Invalid plugin links ledger")?
    {
        plugin_parts(id)?;
        let rows = rows
            .as_array()
            .filter(|rows| !rows.is_empty())
            .ok_or("Invalid linked plugin identities")?;
        let mut entries: Vec<Entry> = Vec::new();
        for row in rows {
            let identity = Identity::read(row, true)?;
            if entries.iter().any(|entry| entry.identity() == &identity) {
                return Err("Duplicate linked plugin identity".into());
            }
            let fields = row.as_object().ok_or("Invalid linked plugin identity")?;
            let entry = if fields.len() == 3 && fields.get("local") == Some(&json!(true)) {
                Entry::Local(identity)
            } else {
                if fields.len() != 5 {
                    return Err("Invalid managed plugin fields".into());
                }
                let source = row
                    .get("sourcePath")
                    .and_then(Value::as_str)
                    .ok_or("Invalid linked sourcePath")?;
                let install = row
                    .get("installPath")
                    .and_then(Value::as_str)
                    .ok_or("Invalid linked installPath")?;
                let version = row
                    .get("version")
                    .and_then(Value::as_str)
                    .ok_or("Invalid linked version")?;
                if !safe_absolute(Path::new(source))
                    || !safe_absolute(Path::new(install))
                    || !safe_version(version)
                {
                    return Err("Invalid managed plugin path or version".into());
                }
                Entry::Managed {
                    identity,
                    source: source.into(),
                    install: install.into(),
                    version: version.into(),
                }
            };
            entries.push(entry);
        }
        result.insert(id.clone(), entries);
    }
    Ok(result)
}

fn ledger_value(ledger: &Ledger) -> Value {
    let plugins: serde_json::Map<String, Value> = ledger
        .iter()
        .map(|(id, rows)| {
            (
                id.clone(),
                Value::Array(rows.iter().map(Entry::value).collect()),
            )
        })
        .collect();
    json!({"version":1,"plugins":plugins})
}

fn empty_registry() -> Value {
    json!({"version":2,"plugins":{}})
}

fn validate_registry(value: &Value) -> Result<(), String> {
    if value.get("version") != Some(&json!(2)) {
        return Err("Unsupported plugin registry version".into());
    }
    for (id, rows) in value
        .get("plugins")
        .and_then(Value::as_object)
        .ok_or("Invalid plugin registry")?
    {
        plugin_parts(id)?;
        let mut identities = Vec::new();
        for row in rows.as_array().ok_or("Invalid plugin registry rows")? {
            let identity = Identity::read(row, false)?;
            if identities.contains(&identity) {
                return Err("Duplicate plugin registry identity".into());
            }
            identities.push(identity);
        }
    }
    Ok(())
}

fn row<'a>(registry: &'a Value, id: &str, identity: &Identity) -> Option<&'a Value> {
    registry
        .get("plugins")?
        .get(id)?
        .as_array()?
        .iter()
        .find(|row| Identity::read(row, false).ok().as_ref() == Some(identity))
}

fn matches_install(row: &Value, path: &Path, version: &str) -> bool {
    row.get("installPath")
        .and_then(Value::as_str)
        .is_some_and(|value| Path::new(value) == path)
        && row.get("version").and_then(Value::as_str) == Some(version)
}

fn excluded(name: &std::ffi::OsStr) -> bool {
    EXCLUDED
        .iter()
        .any(|excluded| name == std::ffi::OsStr::new(excluded))
}

fn reject_private(path: &Path, root: &Path) -> Result<(), String> {
    let data = root.join("data");
    if path == root
        || !path.starts_with(root)
        || path.starts_with(&data)
        || data
            .canonicalize()
            .ok()
            .is_some_and(|data| path.starts_with(data))
    {
        return Err("Plugin code must stay inside its store and outside runtime data".into());
    }
    Ok(())
}

fn source_code(path: &Path, root: &Path) -> Result<PathBuf, String> {
    if !safe_absolute(path) {
        return Err("Invalid plugin code path".into());
    }
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("Plugin source unavailable: {error}"))?;
    reject_private(&resolved, root)?;
    // Also reject an alias lexically placed in the data namespace.
    if path.starts_with(root) {
        reject_private(path, root)?;
    }
    for candidate in [path, resolved.as_path()] {
        if let Ok(relative) = candidate.strip_prefix(root) {
            if relative.components().any(|part| matches!(part, Component::Normal(name) if [".in_use", ".orphaned_at", MARKER].iter().any(|marker| name == std::ffi::OsStr::new(marker)))) {
                return Err("Plugin runtime markers must remain private".into());
            }
        }
    }
    if resolved.parent() == Some(root) && resolved.is_file() {
        return Err("Plugin store metadata must remain private".into());
    }
    Ok(resolved)
}

fn tree_names(path: &Path, exclude: bool) -> Result<BTreeSet<OsString>, String> {
    fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|error| error.to_string())
        })
        .filter(|entry| !matches!(entry, Ok(name) if exclude && excluded(name)))
        .collect()
}

fn validate_source_tree(
    path: &Path,
    root: &Path,
    ancestors: &mut BTreeSet<PathBuf>,
    top: bool,
    protected: &BTreeSet<PathBuf>,
) -> Result<(), String> {
    let resolved = source_code(path, root)?;
    if protected.contains(&resolved) {
        return Err("Registered plugin catalogue metadata must remain private".into());
    }
    if !ancestors.insert(resolved.clone()) {
        return Err("Plugin source symlink cycle".into());
    }
    let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        for name in tree_names(&resolved, top)? {
            validate_source_tree(&resolved.join(name), root, ancestors, false, protected)?;
        }
    } else if !metadata.is_file() || top {
        return Err("Plugin code root must be a directory with ordinary code files".into());
    }
    ancestors.remove(&resolved);
    Ok(())
}

fn same_code(source: &Path, copy: &Path, root: &Path, top: bool) -> Result<bool, String> {
    if validate_no_symlinks(copy).is_err() {
        return Ok(false);
    }
    let source = source_code(source, root)?;
    let left = fs::metadata(&source).map_err(|error| error.to_string())?;
    let right = match fs::symlink_metadata(copy) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if right.file_type().is_symlink() {
        return Ok(false);
    }
    if left.is_file() && right.is_file() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if left.permissions().mode() & 0o111 != right.permissions().mode() & 0o111 {
                return Ok(false);
            }
        }
        return Ok(stable_file(&source)? == stable_file(copy)?);
    }
    if !left.is_dir() || !right.is_dir() {
        return Ok(false);
    }
    let names = tree_names(&source, top)?;
    if names != tree_names(copy, top)? {
        return Ok(false);
    }
    for name in names {
        if !same_code(&source.join(&name), &copy.join(name), root, false)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn stable_file(path: &Path) -> Result<Vec<u8>, String> {
    let mut input = super::open_source_without_symlink(path)?;
    let before = input.metadata().map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut input)
        .take(before.len())
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let after = input.metadata().map_err(|error| error.to_string())?;
    if !before.is_file()
        || bytes.len() as u64 != before.len()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("Plugin code changed during linking".into());
    }
    Ok(bytes)
}

fn alias_path(
    target_root: &Path,
    id: &str,
    version: &str,
    source: &Path,
) -> Result<PathBuf, String> {
    if !safe_version(version) {
        return Err("Invalid official plugin version".into());
    }
    let (name, market) = plugin_parts(id)?;
    let source = source.to_str().ok_or("Plugin source path must be UTF-8")?;
    let suffix = hex::encode(Sha256::digest(source.as_bytes()));
    Ok(target_root
        .join("cache")
        .join(market)
        .join(name)
        .join(format!("{version}.ccem-linked-{}", &suffix[..8])))
}

fn marker_value(source: &Path) -> Value {
    json!({"version":1,"source":source})
}

#[derive(Clone)]
struct Wrapper {
    root: PathBuf,
    source: PathBuf,
    create: bool,
    add: Vec<OsString>,
    remove: Vec<OsString>,
}

impl Wrapper {
    fn changed(&self) -> bool {
        self.create || !self.add.is_empty() || !self.remove.is_empty()
    }
}

#[derive(Default)]
struct Plan {
    observed: BTreeMap<PathBuf, Snapshot>,
    documents: BTreeMap<PathBuf, Value>,
    changes: BTreeMap<PathBuf, Vec<u8>>,
    wrappers: BTreeMap<PathBuf, Wrapper>,
}

impl Plan {
    fn read(&mut self, path: PathBuf, default: Value) -> Result<Value, String> {
        if let Some(value) = self.documents.get(&path) {
            return Ok(value.clone());
        }
        let snapshot = Snapshot::read(path.clone())?;
        let value = snapshot.value(default)?;
        self.observed.insert(path.clone(), snapshot);
        self.documents.insert(path, value.clone());
        Ok(value)
    }
    fn change(&mut self, path: PathBuf, value: Value) -> Result<(), String> {
        let original = self
            .observed
            .get(&path)
            .ok_or("Unobserved plugin metadata")?
            .value(Value::Null)?;
        self.documents.insert(path.clone(), value.clone());
        if original != value {
            self.changes.insert(path, json_bytes(&value)?);
        }
        Ok(())
    }
    fn changed(&self) -> bool {
        !self.changes.is_empty() || self.wrappers.values().any(Wrapper::changed)
    }
    fn unchanged(&self) -> Result<(), String> {
        for snapshot in self.observed.values() {
            snapshot.unchanged()?;
        }
        Ok(())
    }
    fn wrapper(&mut self, root: &Path, source: &Path) -> Result<Wrapper, String> {
        if let Some(wrapper) = self.wrappers.get(root) {
            if wrapper.source != source {
                return Err("Conflicting plugin link roots".into());
            }
            return Ok(wrapper.clone());
        }
        validate_no_symlinks(root)?;
        let mut wrapper = Wrapper {
            root: root.into(),
            source: source.into(),
            create: false,
            add: vec![],
            remove: vec![],
        };
        let desired = tree_names(source, true)?;
        match fs::symlink_metadata(root) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                wrapper.create = true;
                wrapper.add.extend(desired);
            }
            Err(error) => return Err(error.to_string()),
            Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => {
                return Err("Managed plugin root must be a real directory".into())
            }
            Ok(_) => {
                if self.read(root.join(MARKER), Value::Null)? != marker_value(source) {
                    return Err("Existing plugin link root is not owned by CCEM".into());
                }
                for name in EXCLUDED.iter().filter(|name| **name != MARKER) {
                    validate_no_symlinks(&root.join(name))?;
                }
                let actual = tree_names(root, true)?;
                for name in &actual {
                    let path = root.join(name);
                    let metadata =
                        fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
                    if !metadata.file_type().is_symlink()
                        || fs::read_link(&path).map_err(|error| error.to_string())?
                            != source.join(name)
                    {
                        return Err("Plugin link child was changed locally; left unchanged".into());
                    }
                    if !desired.contains(name) {
                        wrapper.remove.push(name.clone());
                    }
                }
                wrapper.add.extend(desired.difference(&actual).cloned());
            }
        }
        Ok(wrapper)
    }
}

struct Catalogue {
    source_path: PathBuf,
    copied_path: PathBuf,
    target_manifest: PathBuf,
    target_index: usize,
    target_source: Option<PathBuf>,
}

fn relocated(path: &Path, source_root: &Path, target_root: &Path) -> Result<PathBuf, String> {
    if !safe_absolute(path) {
        return Err("Invalid original plugin path".into());
    }
    let resolved = source_code(path, source_root)?;
    let relative = path
        .strip_prefix(source_root)
        .or_else(|_| resolved.strip_prefix(source_root))
        .map_err(|_| "Original plugin path escapes official store")?;
    let destination = target_root.join(relative);
    reject_private(&destination, target_root)?;
    Ok(destination)
}

fn local_source(value: &Value, marketplace: &Path) -> Result<Option<PathBuf>, String> {
    let text = if let Some(text) = value.as_str() {
        Some(text)
    } else if matches!(
        value.get("source").and_then(Value::as_str),
        Some("directory" | "file")
    ) {
        Some(
            value
                .get("path")
                .and_then(Value::as_str)
                .ok_or("Invalid local catalogue source")?,
        )
    } else {
        None
    };
    text.map(|text| {
        let path = Path::new(text);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            marketplace.join(path)
        };
        if !safe_absolute(&path) {
            return Err("Unsafe local catalogue source".into());
        }
        Ok(path)
    })
    .transpose()
}

fn market_location(value: &Value, root: &Path) -> Result<PathBuf, String> {
    let raw = value
        .get("installLocation")
        .and_then(Value::as_str)
        .ok_or("Missing marketplace location")?;
    source_code(Path::new(raw), root)
}

fn catalogue(
    plan: &mut Plan,
    source: &Path,
    target: &Path,
    source_root: &Path,
    target_root: &Path,
    id: &str,
) -> Result<Option<Catalogue>, String> {
    let (name, market) = plugin_parts(id)?;
    let known = plan.read(source.join(KNOWN), json!({}))?;
    let source_location = market_location(
        known.get(market).ok_or("Missing official marketplace")?,
        source_root,
    )?;
    let source_manifest_path = source_code(
        &source_location.join(".claude-plugin/marketplace.json"),
        source_root,
    )?;
    let source_manifest = plan.read(source_manifest_path, Value::Null)?;
    let entries = source_manifest
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or("Invalid official catalogue")?;
    let matching: Vec<_> = entries
        .iter()
        .filter(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
        .collect();
    if matching.len() != 1 {
        return Err("Missing or duplicate official catalogue plugin".into());
    }
    let Some(local) = local_source(
        matching[0]
            .get("source")
            .ok_or("Missing catalogue source")?,
        &source_location,
    )?
    else {
        return Ok(None);
    };
    let copied_path = relocated(&local, source_root, target_root)?;
    let source_path = source_code(&local, source_root)?;
    let known = plan.read(target.join(KNOWN), json!({}))?;
    let target_location = market_location(
        known.get(market).ok_or("Missing CCEM marketplace")?,
        target_root,
    )?;
    validate_no_symlinks(&target_location)?;
    let target_manifest = target_location.join(".claude-plugin/marketplace.json");
    let target_value = plan.read(target_manifest.clone(), Value::Null)?;
    let entries = target_value
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or("Invalid CCEM catalogue")?;
    let matching: Vec<_> = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.get("name").and_then(Value::as_str) == Some(name))
        .collect();
    if matching.len() != 1 {
        return Err("Missing or duplicate CCEM catalogue plugin".into());
    }
    Ok(Some(Catalogue {
        source_path,
        copied_path,
        target_manifest,
        target_index: matching[0].0,
        target_source: local_source(
            matching[0].1.get("source").unwrap_or(&Value::Null),
            &target_location,
        )?,
    }))
}

fn owned_marker(plan: &mut Plan, path: &Path, source: &Path) -> Result<bool, String> {
    validate_no_symlinks(path)?;
    if !path.is_dir() {
        return Ok(false);
    }
    Ok(plan.read(path.join(MARKER), Value::Null)? == marker_value(source))
}

fn published_wrapper(
    plan: &mut Plan,
    path: &Path,
    version: &str,
    id: &str,
    source_root: &Path,
    target_root: &Path,
) -> Result<bool, String> {
    if !safe_absolute(path)
        || !safe_version(version)
        || !path.is_dir()
        || validate_no_symlinks(path).is_err()
    {
        return Ok(false);
    }
    let Some((original_version, _)) = version.rsplit_once(".ccem-linked-") else {
        return Ok(false);
    };
    let marker = plan.read(path.join(MARKER), Value::Null)?;
    let Some(source) = marker
        .get("source")
        .and_then(Value::as_str)
        .map(PathBuf::from)
    else {
        return Ok(false);
    };
    if !safe_absolute(&source)
        || reject_private(&source, source_root).is_err()
        || marker != marker_value(&source)
        || alias_path(target_root, id, original_version, &source)? != path
        || path.file_name().and_then(|name| name.to_str()) != Some(version)
    {
        return Ok(false);
    }
    owned_children_intact(plan, path, &source)
}

fn registered_catalogues(plan: &mut Plan, source: &Path) -> Result<BTreeSet<PathBuf>, String> {
    let known = plan.read(source.join(KNOWN), json!({}))?;
    let known = known.as_object().ok_or("Invalid official marketplaces")?;
    Ok(known
        .values()
        .filter_map(|entry| {
            let location = entry.get("installLocation")?.as_str()?;
            if !safe_absolute(Path::new(location)) {
                return None;
            }
            Path::new(location)
                .join(".claude-plugin/marketplace.json")
                .canonicalize()
                .ok()
        })
        .collect())
}

fn owned_children_intact(plan: &mut Plan, path: &Path, source: &Path) -> Result<bool, String> {
    if !owned_marker(plan, path, source)? {
        return Ok(false);
    }
    for name in tree_names(path, true)? {
        let child = path.join(&name);
        if !fs::symlink_metadata(&child)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
            || fs::read_link(child).map_err(|error| error.to_string())? != source.join(&name)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn put_entry(ledger: &mut Ledger, id: &str, entry: Entry) {
    let entries = ledger.entry(id.into()).or_default();
    if let Some(old) = entries
        .iter_mut()
        .find(|old| old.identity() == entry.identity())
    {
        *old = entry;
    } else {
        entries.push(entry);
    }
}

fn plan_links(source: &Path, target: &Path) -> Result<Plan, String> {
    let mut plan = Plan::default();
    let imports = read_imports(plan.read(target.join(IMPORTS), json!({"version":1,"seen":{}}))?)?;
    let mut ledger =
        read_ledger(plan.read(target.join(LEDGER), json!({"version":1,"plugins":{}}))?)?;
    if imports.is_empty() {
        return Ok(plan);
    }
    let source_registry = plan.read(source.join(INSTALLED), empty_registry())?;
    let mut target_registry = plan.read(target.join(INSTALLED), empty_registry())?;
    let original_target_registry = target_registry.clone();
    validate_registry(&source_registry)?;
    validate_registry(&target_registry)?;
    let source_root_path = source.join("plugins");
    let target_root_path = target.join("plugins");
    validate_no_symlinks(&source_root_path)?;
    validate_no_symlinks(&target_root_path)?;
    let source_root = super::resolve_existing_parent(&source_root_path)?;
    let target_root = super::resolve_existing_parent(&target_root_path)?;
    if source_root.starts_with(&target_root) || target_root.starts_with(&source_root) {
        return Err("Official and CCEM plugin stores must not overlap".into());
    }
    let protected = registered_catalogues(&mut plan, source)?;
    for (id, entries) in &ledger {
        for entry in entries {
            if let Entry::Managed {
                source,
                install,
                version,
                ..
            } = entry
            {
                reject_private(source, &source_root)?;
                reject_private(install, &target_root)?;
                let original_version = version
                    .rsplit_once(".ccem-linked-")
                    .ok_or("Invalid managed plugin version")?
                    .0;
                if alias_path(&target_root, id, original_version, source)? != *install
                    || install.file_name().and_then(|name| name.to_str()) != Some(version.as_str())
                {
                    return Err("Invalid managed plugin root in ledger".into());
                }
            }
        }
    }

    for (id, identities) in imports {
        for identity in identities {
            let mut previous = ledger
                .get(&id)
                .and_then(|entries| entries.iter().find(|entry| entry.identity() == &identity))
                .cloned();
            if matches!(previous, Some(Entry::Local(_))) {
                continue;
            }
            let Some(local_row) = row(&target_registry, &id, &identity).cloned() else {
                put_entry(&mut ledger, &id, Entry::Local(identity));
                continue;
            };
            let mut previous_matches = match &previous {
                Some(Entry::Managed {
                    source,
                    install,
                    version,
                    ..
                }) => {
                    reject_private(source, &source_root)?;
                    reject_private(install, &target_root)?;
                    let (name, market) = plugin_parts(&id)?;
                    if install.parent()
                        != Some(target_root.join("cache").join(market).join(name).as_path())
                        || install.file_name().and_then(|name| name.to_str())
                            != Some(version.as_str())
                    {
                        return Err("Invalid managed plugin root in ledger".into());
                    }
                    matches_install(&local_row, install, version)
                }
                _ => false,
            };
            // A registry can have been published before its ledger. Recover an
            // owned wrapper before considering later official updates/uninstalls.
            let recovery = match (
                local_row.get("installPath").and_then(Value::as_str),
                local_row.get("version").and_then(Value::as_str),
            ) {
                (Some(path), Some(version)) if !previous_matches => published_wrapper(
                    &mut plan,
                    Path::new(path),
                    version,
                    &id,
                    &source_root,
                    &target_root,
                )?,
                _ => false,
            };
            if recovery {
                let install = PathBuf::from(local_row["installPath"].as_str().unwrap());
                let marker = plan.read(install.join(MARKER), Value::Null)?;
                let recovered = Entry::Managed {
                    identity: identity.clone(),
                    source: PathBuf::from(marker["source"].as_str().unwrap()),
                    install,
                    version: local_row["version"].as_str().unwrap().to_string(),
                };
                put_entry(&mut ledger, &id, recovered.clone());
                previous = Some(recovered);
                previous_matches = true;
            } else if previous.is_some() && !previous_matches {
                put_entry(&mut ledger, &id, Entry::Local(identity));
                continue;
            }
            let Some(official) = row(&source_registry, &id, &identity) else {
                if previous.is_some() && !previous_matches {
                    put_entry(&mut ledger, &id, Entry::Local(identity));
                }
                continue;
            };
            let version = official
                .get("version")
                .and_then(Value::as_str)
                .filter(|version| safe_version(version))
                .ok_or("Invalid official plugin version")?;
            let original_path = Path::new(
                official
                    .get("installPath")
                    .and_then(Value::as_str)
                    .ok_or("Missing official plugin path")?,
            );
            let catalogue =
                match catalogue(&mut plan, source, target, &source_root, &target_root, &id) {
                    Ok(value) => value,
                    Err(error) if error.starts_with("Plugin source unavailable:") => {
                        if previous.is_some() && !previous_matches {
                            put_entry(&mut ledger, &id, Entry::Local(identity));
                        }
                        continue;
                    }
                    Err(error) => return Err(error),
                };
            let code = match &catalogue {
                Some(catalogue) => catalogue.source_path.clone(),
                None => {
                    // Official cache deletion does not uninstall the private row.
                    if !original_path.exists() {
                        if previous.is_some() && !previous_matches {
                            put_entry(&mut ledger, &id, Entry::Local(identity));
                        }
                        continue;
                    }
                    source_code(original_path, &source_root)?
                }
            };
            validate_source_tree(&code, &source_root, &mut BTreeSet::new(), true, &protected)?;
            let alias = alias_path(&target_root, &id, version, &code)?;
            let linked_version = alias
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap()
                .to_string();
            if previous_matches {
                if let Some(Entry::Managed {
                    source, install, ..
                }) = &previous
                {
                    if !owned_children_intact(&mut plan, install, source)? {
                        put_entry(&mut ledger, &id, Entry::Local(identity));
                        continue;
                    }
                }
            }
            if previous.is_none() {
                if !original_path.exists() {
                    continue;
                }
                let copied = relocated(original_path, &source_root, &target_root)?;
                validate_source_tree(
                    original_path,
                    &source_root,
                    &mut BTreeSet::new(),
                    true,
                    &protected,
                )?;
                if !matches_install(&local_row, &copied, version)
                    || !same_code(
                        &source_code(original_path, &source_root)?,
                        &copied,
                        &source_root,
                        true,
                    )?
                {
                    put_entry(&mut ledger, &id, Entry::Local(identity));
                    continue;
                }
            }
            if let Some(catalogue) = &catalogue {
                let current = catalogue.target_source.as_deref();
                let old_alias = match &previous {
                    Some(Entry::Managed { install, .. }) => Some(install.as_path()),
                    _ => None,
                };
                let owned_current = if let Some(current) = current {
                    if let Some(version) = current.file_name().and_then(|name| name.to_str()) {
                        published_wrapper(
                            &mut plan,
                            current,
                            version,
                            &id,
                            &source_root,
                            &target_root,
                        )?
                    } else {
                        false
                    }
                } else {
                    false
                };
                let permitted = if previous.is_some() {
                    current == old_alias || owned_current
                } else {
                    (current == Some(catalogue.copied_path.as_path())
                        && same_code(&code, &catalogue.copied_path, &source_root, true)?)
                        || owned_current
                };
                if !permitted {
                    put_entry(&mut ledger, &id, Entry::Local(identity));
                    continue;
                }
            }
            let wrapper = plan.wrapper(&alias, &code)?;
            plan.wrappers.insert(alias.clone(), wrapper);
            if let Some(catalogue) = catalogue {
                let mut value = plan
                    .documents
                    .get(&catalogue.target_manifest)
                    .unwrap()
                    .clone();
                value["plugins"][catalogue.target_index]["source"] = json!(alias);
                plan.change(catalogue.target_manifest, value)?;
            }
            let rows = target_registry["plugins"][&id].as_array_mut().unwrap();
            let row = rows
                .iter_mut()
                .find(|row| Identity::read(row, false).ok().as_ref() == Some(&identity))
                .unwrap();
            row["installPath"] = json!(alias);
            row["version"] = json!(linked_version);
            put_entry(
                &mut ledger,
                &id,
                Entry::Managed {
                    identity,
                    source: code,
                    install: alias,
                    version: linked_version,
                },
            );
        }
    }
    if target_registry != original_target_registry {
        plan.change(target.join(INSTALLED), target_registry)?;
    }
    if !ledger.is_empty() {
        plan.change(target.join(LEDGER), ledger_value(&ledger))?;
    }
    Ok(plan)
}

pub(super) fn links_pending(source: &Path, target: &Path) -> Result<bool, String> {
    Ok(plan_links(source, target)?.changed())
}

pub(super) fn link_plugins(source: &Path, target: &Path) -> Result<(), String> {
    link_with_check(source, target, || Ok(()))
}

fn link_with_check(
    source: &Path,
    target: &Path,
    before_publish: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut plan = plan_links(source, target)?;
    if !plan.changed() {
        return Ok(());
    }
    before_publish()?;
    plan.unchanged()?;
    let protected = registered_catalogues(&mut plan, source)?;
    for wrapper in plan.wrappers.values() {
        if wrapper.changed() {
            let root = source
                .join("plugins")
                .canonicalize()
                .map_err(|error| error.to_string())?;
            validate_source_tree(
                &wrapper.source,
                &root,
                &mut BTreeSet::new(),
                true,
                &protected,
            )?;
            publish_wrapper(wrapper)?;
        }
    }
    for path in plan.changes.keys() {
        backup(plan.observed.get(path).unwrap(), target)?;
    }
    // Catalogue paths must be usable before installed registry pointers move.
    let installed = target.join(INSTALLED);
    let ledger = target.join(LEDGER);
    let mut paths: Vec<_> = plan
        .changes
        .keys()
        .filter(|path| **path != installed && **path != ledger)
        .cloned()
        .collect();
    if plan.changes.contains_key(&installed) {
        paths.push(installed);
    }
    if plan.changes.contains_key(&ledger) {
        paths.push(ledger);
    }
    for path in paths {
        plan.unchanged()?;
        let bytes = plan.changes.get(&path).unwrap();
        replace_metadata(&path, bytes, &plan)?;
        plan.observed.get_mut(&path).unwrap().bytes = Some(bytes.clone());
    }
    Ok(())
}

fn symlink_code(source: &Path, target: &Path) -> Result<(), String> {
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(source, target);
    #[cfg(windows)]
    let result = if source.is_dir() {
        std::os::windows::fs::symlink_dir(source, target)
    } else {
        std::os::windows::fs::symlink_file(source, target)
    };
    #[cfg(not(any(unix, windows)))]
    let result = Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Plugin code links are unsupported",
    ));
    result.map_err(|error| format!("Could not link plugin code: {error}"))
}

fn publish_wrapper(wrapper: &Wrapper) -> Result<(), String> {
    validate_no_symlinks(&wrapper.root)?;
    if wrapper.create {
        if fs::symlink_metadata(&wrapper.root).is_ok() {
            return Err("Plugin link root appeared during preparation".into());
        }
        let parent = wrapper.root.parent().ok_or("Missing plugin link parent")?;
        create_private_dir(parent)?;
        let temporary = parent.join(format!(
            ".ccem-link-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&temporary).map_err(|error| error.to_string())?;
        let result = (|| {
            create_private_dir(&temporary)?;
            super::publish_bytes(
                &temporary.join(MARKER),
                &json_bytes(&marker_value(&wrapper.source))?,
            )?;
            for name in &wrapper.add {
                symlink_code(&wrapper.source.join(name), &temporary.join(name))?;
            }
            if fs::symlink_metadata(&wrapper.root).is_ok() {
                return Err("Plugin link root appeared during preparation".into());
            }
            fs::rename(&temporary, &wrapper.root).map_err(|error| error.to_string())?;
            sync_directory(parent)
        })();
        let _ = fs::remove_dir_all(&temporary);
        return result;
    }
    if Snapshot::read(wrapper.root.join(MARKER))?.value(Value::Null)?
        != marker_value(&wrapper.source)
    {
        return Err("Plugin link marker changed during preparation".into());
    }
    for name in &wrapper.remove {
        let path = wrapper.root.join(name);
        if fs::read_link(&path).map_err(|error| error.to_string())? != wrapper.source.join(name) {
            return Err("Plugin link child changed during preparation".into());
        }
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    for name in &wrapper.add {
        symlink_code(&wrapper.source.join(name), &wrapper.root.join(name))?;
    }
    sync_directory(&wrapper.root)
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
    let path = target.join(BACKUP).join(
        snapshot
            .path
            .strip_prefix(target)
            .map_err(|_| "Invalid plugin link backup path")?,
    );
    validate_no_symlinks(&path)?;
    if !path.exists() {
        super::publish_bytes(&path, bytes)?;
    }
    Ok(())
}

fn replace_metadata(path: &Path, bytes: &[u8], plan: &Plan) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing plugin link metadata parent")?;
    create_private_dir(parent)?;
    let temp = parent.join(format!(
        ".ccem-plugin-links-{}-{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|error| error.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        plan.unchanged()?;
        fs::rename(&temp, path).map_err(|error| error.to_string())?;
        sync_directory(parent)
    })();
    let _ = fs::remove_file(temp);
    result
}

#[cfg(test)]
#[path = "agent_plugin_links_tests.rs"]
mod tests;
