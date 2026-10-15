use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

use crate::{agent_home, config};

/// Cached user PATH — login shell is expensive on macOS (1-3s),
/// only resolve once per process lifetime.
static USER_PATH: OnceLock<String> = OnceLock::new();

// ============================================
// Types
// ============================================

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillUiMetadata {
    pub display_name: Option<String>,
    pub short_description: Option<String>,
    pub brand_color: Option<String>,
    pub composer_icon: Option<String>,
    pub logo: Option<String>,
    pub default_prompt: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    pub name: String,
    pub description: String,
    pub path: String,
    pub scope: String,          // "global" | "project" | "plugin"
    pub agents: Vec<String>,    // ["Claude Code", "Codex"]
    pub source: Option<String>, // plugin: marketplace name, skills: "skills.sh"
    pub version: Option<String>,
    pub id: String,
    pub provider: Option<String>,
    pub skill_file: Option<String>,
    pub display_name: Option<String>,
    pub invocation_label: Option<String>,
    pub plugin_name: Option<String>,
    pub plugin_marketplace: Option<String>,
    pub disabled: bool,
    pub visibility: Option<String>,
    pub implicit_allowed: bool,
    pub ui_metadata: Option<SkillUiMetadata>,
    pub diagnostics: Vec<String>,
    #[serde(default)]
    pub managed_by_ccem: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CuratedSkill {
    pub name: String,
    pub package_id: String,
    pub skill_name: String,
    pub description: String,
    pub category: String,     // "official" | "popular" | "community"
    pub install_type: String, // "skills" | "plugin"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CcemAgentSkillTarget {
    pub agent: String,
    pub path: String,
    pub installed: bool,
    pub up_to_date: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CcemAgentSkillStatus {
    pub name: String,
    pub installed: bool,
    pub up_to_date: bool,
    pub targets: Vec<CcemAgentSkillTarget>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SelectedSkillContent {
    pub skill_file: String,
    pub directory: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub content: String,
    pub resource_hints: Vec<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone)]
struct SkillMetadata {
    name: Option<String>,
    description: Option<String>,
    ui_metadata: Option<SkillUiMetadata>,
    diagnostics: Vec<String>,
}

#[derive(Debug, Clone)]
struct SkillScanOptions {
    scope: String,
    agents: Vec<String>,
    source: Option<String>,
    version: Option<String>,
    provider: Option<String>,
    plugin_name: Option<String>,
    plugin_marketplace: Option<String>,
    disabled: bool,
    visibility: Option<String>,
    implicit_allowed: bool,
    diagnostics: Vec<String>,
}

#[derive(Debug, Clone)]
struct CodexConfig {
    disabled_skill_paths: HashSet<PathBuf>,
    disabled_plugins: HashSet<String>,
}

#[derive(Debug, Default)]
struct SkillScanState {
    visited_dirs: HashSet<PathBuf>,
    seen_skill_files: HashSet<PathBuf>,
    visited_dir_count: usize,
}

const MAX_SKILL_SCAN_DEPTH: usize = 6;
const MAX_SKILL_SCAN_DIRS: usize = 2000;
const CCEM_AGENT_SKILL_NAME: &str = "ccem";
const CCEM_AGENT_SKILL_CONTENT: &str =
    include_str!("../../../../packages/agent-skills/ccem/SKILL.md");
const SKILL_SCAN_SKIP_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".parcel-cache",
    "coverage",
];

// ============================================
// Helpers
// ============================================

/// Get the user's full PATH from their interactive login shell (cached).
/// macOS GUI apps don't inherit shell PATH, so we need to source it.
/// Uses `-li` (login + interactive) to ensure .zshrc is loaded — needed for
/// nvm, fnm, volta and other version managers that only init in .zshrc.
fn get_user_path() -> &'static str {
    USER_PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let output = Command::new(&shell)
            .args(["-li", "-c", "echo $PATH"])
            .output();

        match output {
            Ok(out) if out.status.success() => {
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            }
            _ => std::env::var("PATH").unwrap_or_default(),
        }
    })
}

fn yaml_mapping_value<'a>(
    mapping: &'a serde_yaml::Mapping,
    key: &str,
) -> Option<&'a serde_yaml::Value> {
    mapping.get(serde_yaml::Value::String(key.to_string()))
}

fn yaml_value_to_string(value: &serde_yaml::Value) -> Option<String> {
    match value {
        serde_yaml::Value::String(value) => Some(value.trim().to_string()),
        serde_yaml::Value::Number(value) => Some(value.to_string()),
        serde_yaml::Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
    .filter(|value| !value.is_empty())
}

fn parse_ui_metadata(value: &serde_yaml::Value) -> Option<SkillUiMetadata> {
    let mapping = value.as_mapping()?;
    let metadata = SkillUiMetadata {
        display_name: yaml_mapping_value(mapping, "displayName")
            .or_else(|| yaml_mapping_value(mapping, "display_name"))
            .and_then(yaml_value_to_string),
        short_description: yaml_mapping_value(mapping, "shortDescription")
            .or_else(|| yaml_mapping_value(mapping, "short_description"))
            .and_then(yaml_value_to_string),
        brand_color: yaml_mapping_value(mapping, "brandColor")
            .or_else(|| yaml_mapping_value(mapping, "brand_color"))
            .and_then(yaml_value_to_string),
        composer_icon: yaml_mapping_value(mapping, "composerIcon")
            .or_else(|| yaml_mapping_value(mapping, "composer_icon"))
            .and_then(yaml_value_to_string),
        logo: yaml_mapping_value(mapping, "logo").and_then(yaml_value_to_string),
        default_prompt: yaml_mapping_value(mapping, "defaultPrompt")
            .or_else(|| yaml_mapping_value(mapping, "default_prompt"))
            .and_then(yaml_value_to_string),
    };

    if metadata.display_name.is_none()
        && metadata.short_description.is_none()
        && metadata.brand_color.is_none()
        && metadata.composer_icon.is_none()
        && metadata.logo.is_none()
        && metadata.default_prompt.is_none()
    {
        None
    } else {
        Some(metadata)
    }
}

fn extract_frontmatter(content: &str) -> Option<String> {
    let trimmed = content.trim_start_matches('\u{feff}').trim_start();
    let mut lines = trimmed.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }

    let mut frontmatter = Vec::new();
    for line in lines {
        let marker = line.trim();
        if marker == "---" || marker == "..." {
            return Some(frontmatter.join("\n"));
        }
        frontmatter.push(line);
    }

    None
}

fn parse_lenient_frontmatter(frontmatter: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut description = None;

    for line in frontmatter.lines() {
        let line = line.trim();
        let Some((raw_key, raw_value)) = line.split_once(':') else {
            continue;
        };
        let key = raw_key.trim().to_ascii_lowercase();
        let value = raw_value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim()
            .to_string();
        if value.is_empty() || value == "|" || value == ">" {
            continue;
        }
        match key.as_str() {
            "name" => name = Some(value),
            "description" => description = Some(value),
            _ => {}
        }
    }

    (name, description)
}

fn parse_skill_metadata(content: &str) -> SkillMetadata {
    let Some(frontmatter) = extract_frontmatter(content) else {
        return SkillMetadata {
            name: None,
            description: None,
            ui_metadata: None,
            diagnostics: Vec::new(),
        };
    };

    match serde_yaml::from_str::<serde_yaml::Value>(&frontmatter) {
        Ok(serde_yaml::Value::Mapping(mapping)) => {
            let name = yaml_mapping_value(&mapping, "name").and_then(yaml_value_to_string);
            let description =
                yaml_mapping_value(&mapping, "description").and_then(yaml_value_to_string);
            let ui_metadata = yaml_mapping_value(&mapping, "ui")
                .or_else(|| yaml_mapping_value(&mapping, "uiMetadata"))
                .or_else(|| yaml_mapping_value(&mapping, "ui_metadata"))
                .and_then(parse_ui_metadata);

            SkillMetadata {
                name,
                description,
                ui_metadata,
                diagnostics: Vec::new(),
            }
        }
        Ok(_) => {
            let (name, description) = parse_lenient_frontmatter(&frontmatter);
            SkillMetadata {
                name,
                description,
                ui_metadata: None,
                diagnostics: vec![
                    "Frontmatter is not a YAML mapping; used lenient parser".to_string()
                ],
            }
        }
        Err(error) => {
            let (name, description) = parse_lenient_frontmatter(&frontmatter);
            SkillMetadata {
                name,
                description,
                ui_metadata: None,
                diagnostics: vec![format!("YAML frontmatter parse failed: {}", error)],
            }
        }
    }
}

/// Parse YAML frontmatter from SKILL.md content.
/// Returns (name, description) if frontmatter exists.
fn parse_skill_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let metadata = parse_skill_metadata(content);
    (metadata.name, metadata.description)
}

fn default_skill_scan_options(
    scope: &str,
    agents: &[String],
    source: Option<&str>,
) -> SkillScanOptions {
    SkillScanOptions {
        scope: scope.to_string(),
        agents: agents.to_vec(),
        source: source.map(|s| s.to_string()),
        version: None,
        provider: None,
        plugin_name: None,
        plugin_marketplace: None,
        disabled: false,
        visibility: Some("native".to_string()),
        implicit_allowed: true,
        diagnostics: Vec::new(),
    }
}

fn is_hidden_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.'))
}

fn is_skipped_scan_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| SKILL_SCAN_SKIP_DIR_NAMES.contains(&name))
}

fn is_scannable_dir(path: &Path, file_type: &std::fs::FileType) -> bool {
    if file_type.is_dir() {
        return true;
    }
    file_type.is_symlink()
        && std::fs::metadata(path)
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false)
}

fn skill_identity(skill: &InstalledSkill) -> PathBuf {
    let skill_file = skill
        .skill_file
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(&skill.path).join("SKILL.md"));
    normalized_existing_or_raw(&skill_file)
}

fn build_installed_skill_from_dir(
    path: &Path,
    options: &SkillScanOptions,
) -> Option<InstalledSkill> {
    if is_hidden_dir(path) {
        return None;
    }

    let skill_md = path.join("SKILL.md");
    if std::fs::symlink_metadata(&skill_md).is_err() {
        return None;
    }

    let dir_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string();

    let (base_name, description, mut diagnostics, ui_metadata) =
        match std::fs::read_to_string(&skill_md) {
            Ok(content) => {
                let metadata = parse_skill_metadata(&content);
                (
                    metadata.name.unwrap_or_else(|| dir_name.clone()),
                    metadata.description.unwrap_or_default(),
                    metadata.diagnostics,
                    metadata.ui_metadata,
                )
            }
            Err(error) => (
                dir_name.clone(),
                String::new(),
                vec![format!("Failed to read SKILL.md: {}", error)],
                None,
            ),
        };

    diagnostics.extend(options.diagnostics.clone());

    let should_namespace_claude_plugin = options.provider.as_deref() == Some("claude")
        && options.scope == "plugin"
        && options.plugin_name.is_some();
    let invocation_label = if should_namespace_claude_plugin {
        format!(
            "{}:{}",
            options.plugin_name.as_deref().unwrap_or("plugin"),
            base_name
        )
    } else {
        base_name.clone()
    };
    let name = if should_namespace_claude_plugin {
        invocation_label.clone()
    } else {
        base_name.clone()
    };
    let skill_file = skill_md.to_string_lossy().to_string();
    let provider_key = options.provider.as_deref().unwrap_or("skill");
    let id = format!("{}:{}", provider_key, skill_file);

    Some(InstalledSkill {
        name,
        description,
        path: path.to_string_lossy().to_string(),
        scope: options.scope.clone(),
        agents: options.agents.clone(),
        source: options.source.clone(),
        version: options.version.clone(),
        id,
        provider: options.provider.clone(),
        skill_file: Some(skill_file),
        display_name: Some(base_name),
        invocation_label: Some(invocation_label),
        plugin_name: options.plugin_name.clone(),
        plugin_marketplace: options.plugin_marketplace.clone(),
        disabled: options.disabled,
        visibility: options.visibility.clone(),
        implicit_allowed: options.implicit_allowed,
        ui_metadata,
        diagnostics,
        managed_by_ccem: false,
    })
}

fn scan_skills_dir_with_options(dir: &Path, options: &SkillScanOptions) -> Vec<InstalledSkill> {
    let mut state = SkillScanState::default();
    scan_skills_dir_with_state(dir, options, &mut state, 0)
}

fn scan_skills_dir_with_state(
    dir: &Path,
    options: &SkillScanOptions,
    state: &mut SkillScanState,
    depth: usize,
) -> Vec<InstalledSkill> {
    let mut skills = Vec::new();

    if depth > MAX_SKILL_SCAN_DEPTH || state.visited_dir_count >= MAX_SKILL_SCAN_DIRS {
        return skills;
    }

    let dir_identity = normalized_existing_or_raw(dir);
    if !state.visited_dirs.insert(dir_identity) {
        return skills;
    }
    state.visited_dir_count += 1;

    if let Some(skill) = build_installed_skill_from_dir(dir, options) {
        if state.seen_skill_files.insert(skill_identity(&skill)) {
            skills.push(skill);
        }
        return skills;
    }

    if depth == MAX_SKILL_SCAN_DEPTH {
        return skills;
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return skills,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if is_hidden_dir(&path) || is_skipped_scan_dir(&path) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !is_scannable_dir(&path, &file_type) {
            continue;
        }

        skills.extend(scan_skills_dir_with_state(&path, options, state, depth + 1));
    }

    skills
}

/// Scan a directory for skills (each subdirectory with SKILL.md).
fn scan_skills_dir(
    dir: &Path,
    scope: &str,
    agents: &[String],
    source: Option<&str>,
) -> Vec<InstalledSkill> {
    scan_skills_dir_with_options(dir, &default_skill_scan_options(scope, agents, source))
}

fn home_relative(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home.join(rest);
    }
    PathBuf::from(path)
}

fn normalized_existing_or_raw(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn is_path_disabled(path: &Path, disabled_paths: &HashSet<PathBuf>) -> bool {
    let normalized = normalized_existing_or_raw(path);
    disabled_paths.iter().any(|disabled_path| {
        normalized.starts_with(disabled_path) || path.starts_with(disabled_path)
    })
}

fn read_codex_config(home: &Path, codex_home: &Path) -> CodexConfig {
    let config_path = codex_home.join("config.toml");
    let content = match std::fs::read_to_string(config_path) {
        Ok(content) => content,
        Err(_) => {
            return CodexConfig {
                disabled_skill_paths: HashSet::new(),
                disabled_plugins: HashSet::new(),
            };
        }
    };
    let parsed = match content.parse::<toml::Value>() {
        Ok(parsed) => parsed,
        Err(_) => {
            let mut disabled_skill_paths = HashSet::new();
            let mut disabled_plugins = HashSet::new();
            extend_codex_disabled_skill_paths_lenient(&content, home, &mut disabled_skill_paths);
            extend_codex_disabled_plugins_lenient(&content, &mut disabled_plugins);
            return CodexConfig {
                disabled_skill_paths,
                disabled_plugins,
            };
        }
    };

    let mut disabled_skill_paths = HashSet::new();
    if let Some(configs) = parsed
        .get("skills")
        .and_then(|skills| skills.get("config"))
        .and_then(|config| config.as_array())
    {
        for item in configs {
            let enabled = item
                .get("enabled")
                .and_then(|enabled| enabled.as_bool())
                .unwrap_or(true);
            if enabled {
                continue;
            }
            let raw_path = item
                .get("path")
                .or_else(|| item.get("skill"))
                .or_else(|| item.get("directory"))
                .or_else(|| item.get("file"))
                .and_then(|path| path.as_str());
            if let Some(raw_path) = raw_path {
                let expanded = home_relative(raw_path, home);
                disabled_skill_paths.insert(expanded.clone());
                disabled_skill_paths.insert(normalized_existing_or_raw(&expanded));
            }
        }
    }
    extend_codex_disabled_skill_paths_lenient(&content, home, &mut disabled_skill_paths);

    let mut disabled_plugins = HashSet::new();
    if let Some(plugins) = parsed.get("plugins").and_then(|plugins| plugins.as_table()) {
        for (plugin_key, value) in plugins {
            let enabled = value
                .get("enabled")
                .and_then(|enabled| enabled.as_bool())
                .unwrap_or(true);
            if !enabled {
                disabled_plugins.insert(plugin_key.clone());
            }
        }
    }
    extend_codex_disabled_plugins_lenient(&content, &mut disabled_plugins);

    CodexConfig {
        disabled_skill_paths,
        disabled_plugins,
    }
}

fn extend_codex_disabled_skill_paths_lenient(
    content: &str,
    home: &Path,
    disabled_skill_paths: &mut HashSet<PathBuf>,
) {
    let mut in_skill_config = false;
    let mut pending_path: Option<String> = None;
    let mut pending_enabled = true;

    let flush = |pending_path: &mut Option<String>,
                 pending_enabled: &mut bool,
                 disabled_skill_paths: &mut HashSet<PathBuf>| {
        if !*pending_enabled {
            if let Some(raw_path) = pending_path.take() {
                let expanded = home_relative(&raw_path, home);
                disabled_skill_paths.insert(expanded.clone());
                disabled_skill_paths.insert(normalized_existing_or_raw(&expanded));
            }
        } else {
            *pending_path = None;
        }
        *pending_enabled = true;
    };

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.starts_with("[[") {
            if in_skill_config {
                flush(
                    &mut pending_path,
                    &mut pending_enabled,
                    disabled_skill_paths,
                );
            }
            in_skill_config = line == "[[skills.config]]";
            pending_path = None;
            pending_enabled = true;
            continue;
        }
        if line.starts_with('[') {
            if in_skill_config {
                flush(
                    &mut pending_path,
                    &mut pending_enabled,
                    disabled_skill_paths,
                );
            }
            in_skill_config = false;
            continue;
        }
        if !in_skill_config {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"').trim_matches('\'');
        match key {
            "path" | "skill" | "directory" | "file" => pending_path = Some(value.to_string()),
            "enabled" => pending_enabled = value != "false",
            _ => {}
        }
    }

    if in_skill_config {
        flush(
            &mut pending_path,
            &mut pending_enabled,
            disabled_skill_paths,
        );
    }
}

fn extend_codex_disabled_plugins_lenient(content: &str, disabled_plugins: &mut HashSet<String>) {
    let mut pending_plugin: Option<String> = None;
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') {
            pending_plugin = line
                .strip_prefix("[plugins.")
                .and_then(|value| value.strip_suffix(']'))
                .map(|value| value.trim_matches('"').trim_matches('\'').to_string());
            continue;
        }
        let Some(plugin_key) = pending_plugin.as_deref() else {
            continue;
        };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() == "enabled" && value.trim() == "false" {
            disabled_plugins.insert(plugin_key.to_string());
        }
    }
}

fn add_skills_unique_by_file(
    all_skills: &mut Vec<InstalledSkill>,
    seen_files: &mut HashSet<String>,
    skills: Vec<InstalledSkill>,
) {
    for skill in skills {
        let key = skill
            .skill_file
            .clone()
            .unwrap_or_else(|| format!("{}/SKILL.md", skill.path));
        if seen_files.insert(key) {
            all_skills.push(skill);
        }
    }
}

fn collect_workspace_skill_dirs(
    working_dir: Option<&Path>,
    folder_name: &str,
    user_home: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let Some(working_dir) = working_dir else {
        return dirs;
    };
    let mut current = if working_dir.is_file() {
        working_dir.parent().map(Path::to_path_buf)
    } else {
        Some(working_dir.to_path_buf())
    };

    while let Some(dir) = current {
        // A user home is not a project root: its agent directories belong to
        // the official apps, even when the workspace has no Git boundary.
        if user_home == Some(dir.as_path()) {
            break;
        }
        let skills_dir = dir.join(folder_name).join("skills");
        if skills_dir.exists() {
            dirs.push(skills_dir);
        }
        if dir.join(".git").exists() {
            break;
        }
        current = dir.parent().map(Path::to_path_buf);
    }

    dirs
}

fn scan_codex_skills_for_context(
    home: Option<&Path>,
    codex_home: &Path,
    working_dir: Option<&Path>,
) -> Vec<InstalledSkill> {
    let mut skills = Vec::new();
    let mut seen_files = HashSet::new();

    let codex_agents = vec!["Codex".to_string()];
    let Some(home) = home else {
        return skills;
    };
    let codex_config = read_codex_config(home, codex_home);

    for dir in collect_workspace_skill_dirs(working_dir, ".agents", Some(home)) {
        let mut options = SkillScanOptions {
            scope: "project".to_string(),
            agents: codex_agents.clone(),
            source: Some(".agents/skills".to_string()),
            version: None,
            provider: Some("codex".to_string()),
            plugin_name: None,
            plugin_marketplace: None,
            disabled: is_path_disabled(&dir, &codex_config.disabled_skill_paths),
            visibility: Some("native".to_string()),
            implicit_allowed: true,
            diagnostics: Vec::new(),
        };
        if options.disabled {
            options
                .diagnostics
                .push("Disabled by Codex skills.config".to_string());
        }
        add_skills_unique_by_file(
            &mut skills,
            &mut seen_files,
            scan_skills_dir_with_options(&dir, &options),
        );
    }

    let global_agents_dir = home.join(".agents").join("skills");
    if global_agents_dir.exists() {
        let mut options = SkillScanOptions {
            scope: "global".to_string(),
            agents: codex_agents.clone(),
            source: Some("~/.agents/skills".to_string()),
            version: None,
            provider: Some("codex".to_string()),
            plugin_name: None,
            plugin_marketplace: None,
            disabled: is_path_disabled(&global_agents_dir, &codex_config.disabled_skill_paths),
            visibility: Some("native".to_string()),
            implicit_allowed: true,
            diagnostics: Vec::new(),
        };
        if options.disabled {
            options
                .diagnostics
                .push("Disabled by Codex skills.config".to_string());
        }
        add_skills_unique_by_file(
            &mut skills,
            &mut seen_files,
            scan_skills_dir_with_options(&global_agents_dir, &options),
        );
    }

    let codex_skills_dir = codex_home.join("skills");
    if codex_skills_dir.exists() {
        let mut options = SkillScanOptions {
            scope: "global".to_string(),
            agents: codex_agents.clone(),
            source: Some("CCEM Codex skills".to_string()),
            version: None,
            provider: Some("codex".to_string()),
            plugin_name: None,
            plugin_marketplace: None,
            disabled: is_path_disabled(&codex_skills_dir, &codex_config.disabled_skill_paths),
            visibility: Some("native".to_string()),
            implicit_allowed: true,
            diagnostics: Vec::new(),
        };
        if options.disabled {
            options
                .diagnostics
                .push("Disabled by Codex skills.config".to_string());
        }
        add_skills_unique_by_file(
            &mut skills,
            &mut seen_files,
            scan_skills_dir_with_options(&codex_skills_dir, &options),
        );

        let codex_system_skills_dir = codex_skills_dir.join(".system");
        if codex_system_skills_dir.exists() {
            let system_options = SkillScanOptions {
                scope: "system".to_string(),
                agents: codex_agents.clone(),
                source: Some("CCEM Codex system skills".to_string()),
                version: None,
                provider: Some("codex".to_string()),
                plugin_name: None,
                plugin_marketplace: None,
                disabled: is_path_disabled(
                    &codex_system_skills_dir,
                    &codex_config.disabled_skill_paths,
                ),
                visibility: Some("native".to_string()),
                implicit_allowed: true,
                diagnostics: Vec::new(),
            };
            add_skills_unique_by_file(
                &mut skills,
                &mut seen_files,
                scan_skills_dir_with_options(&codex_system_skills_dir, &system_options),
            );
        }
    }

    let admin_skills_dir = PathBuf::from("/etc/codex/skills");
    if admin_skills_dir.exists() {
        let mut options = SkillScanOptions {
            scope: "system".to_string(),
            agents: codex_agents.clone(),
            source: Some("/etc/codex/skills".to_string()),
            version: None,
            provider: Some("codex".to_string()),
            plugin_name: None,
            plugin_marketplace: None,
            disabled: is_path_disabled(&admin_skills_dir, &codex_config.disabled_skill_paths),
            visibility: Some("native".to_string()),
            implicit_allowed: true,
            diagnostics: Vec::new(),
        };
        if options.disabled {
            options
                .diagnostics
                .push("Disabled by Codex skills.config".to_string());
        }
        add_skills_unique_by_file(
            &mut skills,
            &mut seen_files,
            scan_skills_dir_with_options(&admin_skills_dir, &options),
        );
    }

    scan_codex_plugin_cache_skills(codex_home, &codex_config, &mut skills, &mut seen_files);

    skills
}

fn scan_codex_plugin_cache_skills(
    codex_home: &Path,
    codex_config: &CodexConfig,
    all_skills: &mut Vec<InstalledSkill>,
    seen_files: &mut HashSet<String>,
) {
    let cache_dir = codex_home.join("plugins").join("cache");
    let marketplace_entries = match std::fs::read_dir(cache_dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for marketplace_entry in marketplace_entries.flatten() {
        let marketplace_path = marketplace_entry.path();
        if !marketplace_path.is_dir() || is_hidden_dir(&marketplace_path) {
            continue;
        }
        let marketplace = marketplace_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown")
            .to_string();

        let plugin_entries = match std::fs::read_dir(&marketplace_path) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for plugin_entry in plugin_entries.flatten() {
            let plugin_path = plugin_entry.path();
            if !plugin_path.is_dir() || is_hidden_dir(&plugin_path) {
                continue;
            }
            let plugin_name = plugin_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unknown")
                .to_string();
            let plugin_key = format!("{}@{}", plugin_name, marketplace);
            let disabled = codex_config.disabled_plugins.contains(&plugin_key)
                || codex_config.disabled_plugins.contains(&plugin_name)
                || is_path_disabled(&plugin_path, &codex_config.disabled_skill_paths);
            let mut options = SkillScanOptions {
                scope: if marketplace.starts_with("openai-") {
                    "system".to_string()
                } else {
                    "plugin".to_string()
                },
                agents: vec!["Codex".to_string()],
                source: Some(marketplace.clone()),
                version: None,
                provider: Some("codex".to_string()),
                plugin_name: Some(plugin_name.clone()),
                plugin_marketplace: Some(marketplace.clone()),
                disabled,
                visibility: Some("native".to_string()),
                implicit_allowed: !disabled,
                diagnostics: Vec::new(),
            };
            if disabled {
                options
                    .diagnostics
                    .push("Disabled by Codex plugin or skills.config".to_string());
            }

            let scan_root = plugin_path.join("skills");
            let scan_root = if scan_root.exists() {
                scan_root
            } else {
                plugin_path
            };
            add_skills_unique_by_file(
                all_skills,
                seen_files,
                scan_skills_dir_with_options(&scan_root, &options),
            );
        }
    }
}

fn parse_claude_skill_overrides_from_value(
    value: &serde_json::Value,
    overrides: &mut HashMap<String, String>,
) {
    let candidates = [
        value.get("skillOverrides"),
        value
            .get("skills")
            .and_then(|skills| skills.get("overrides")),
        value
            .get("skills")
            .and_then(|skills| skills.get("skillOverrides")),
    ];

    for candidate in candidates.into_iter().flatten() {
        let Some(object) = candidate.as_object() else {
            continue;
        };
        for (key, value) in object {
            let mode = value.as_str().or_else(|| {
                value
                    .as_object()
                    .and_then(|object| object.get("mode"))
                    .and_then(|mode| mode.as_str())
            });
            if let Some(mode) = mode {
                overrides.insert(key.to_ascii_lowercase(), mode.to_ascii_lowercase());
            }
        }
    }
}

fn collect_claude_settings_paths(
    home: Option<&Path>,
    claude_home: &Path,
    working_dir: Option<&Path>,
) -> Vec<PathBuf> {
    let mut paths = vec![claude_home.join("settings.json")];
    if let Some(working_dir) = working_dir {
        let mut current = if working_dir.is_file() {
            working_dir.parent().map(Path::to_path_buf)
        } else {
            Some(working_dir.to_path_buf())
        };
        while let Some(dir) = current {
            if home == Some(dir.as_path()) {
                break;
            }
            paths.push(dir.join(".claude").join("settings.json"));
            if dir.join(".git").exists() {
                break;
            }
            current = dir.parent().map(Path::to_path_buf);
        }
    }
    paths
}

fn read_claude_skill_overrides(
    home: Option<&Path>,
    claude_home: &Path,
    working_dir: Option<&Path>,
) -> HashMap<String, String> {
    let mut overrides = HashMap::new();
    for settings_path in collect_claude_settings_paths(home, claude_home, working_dir) {
        let Ok(content) = std::fs::read_to_string(settings_path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        parse_claude_skill_overrides_from_value(&value, &mut overrides);
    }
    overrides
}

fn apply_claude_overrides(skill: &mut InstalledSkill, overrides: &HashMap<String, String>) {
    let mut keys = vec![
        skill.name.to_ascii_lowercase(),
        skill
            .display_name
            .as_deref()
            .unwrap_or(&skill.name)
            .to_ascii_lowercase(),
        skill
            .invocation_label
            .as_deref()
            .unwrap_or(&skill.name)
            .to_ascii_lowercase(),
        skill.path.to_ascii_lowercase(),
    ];
    if let Some(skill_file) = &skill.skill_file {
        keys.push(skill_file.to_ascii_lowercase());
    }

    let Some(mode) = keys.iter().find_map(|key| overrides.get(key)) else {
        return;
    };

    skill.visibility = Some(mode.clone());
    match mode.as_str() {
        "on" => {
            skill.disabled = false;
            skill.implicit_allowed = true;
        }
        "name-only" | "user-invocable-only" => {
            skill.implicit_allowed = false;
            skill
                .diagnostics
                .push(format!("Claude skillOverrides set {}", mode));
        }
        "off" => {
            skill.disabled = true;
            skill.implicit_allowed = false;
            skill
                .diagnostics
                .push("Disabled by Claude skillOverrides".to_string());
        }
        _ => {
            skill
                .diagnostics
                .push(format!("Unknown Claude skillOverrides mode: {}", mode));
        }
    }
}

fn claude_scope_priority(scope: &str) -> i32 {
    match scope {
        "enterprise" => 3,
        "global" | "personal" => 2,
        "project" => 1,
        _ => 0,
    }
}

fn apply_claude_native_priority(skills: Vec<InstalledSkill>) -> Vec<InstalledSkill> {
    let mut kept: Vec<InstalledSkill> = Vec::new();
    let mut native_by_name: HashMap<String, usize> = HashMap::new();

    for skill in skills {
        let is_plugin = skill.scope == "plugin";
        let is_explicit_only = skill.visibility.as_deref() == Some("explicit-only");
        if is_plugin || is_explicit_only {
            kept.push(skill);
            continue;
        }

        let key = skill
            .display_name
            .as_deref()
            .unwrap_or(&skill.name)
            .to_ascii_lowercase();
        if let Some(existing_index) = native_by_name.get(&key).copied() {
            let existing_priority = claude_scope_priority(&kept[existing_index].scope);
            let next_priority = claude_scope_priority(&skill.scope);
            if next_priority > existing_priority {
                kept[existing_index] = skill;
            }
        } else {
            native_by_name.insert(key, kept.len());
            kept.push(skill);
        }
    }

    kept
}

fn scan_claude_skills_for_context(
    home: Option<&Path>,
    claude_home: &Path,
    working_dir: Option<&Path>,
) -> Vec<InstalledSkill> {
    let claude_agents = vec!["Claude Code".to_string()];
    let mut skills = Vec::new();

    let enterprise_dir = PathBuf::from("/etc/claude-code/skills");
    if enterprise_dir.exists() {
        let options = SkillScanOptions {
            scope: "enterprise".to_string(),
            agents: claude_agents.clone(),
            source: Some("/etc/claude-code/skills".to_string()),
            version: None,
            provider: Some("claude".to_string()),
            plugin_name: None,
            plugin_marketplace: None,
            disabled: false,
            visibility: Some("native".to_string()),
            implicit_allowed: true,
            diagnostics: Vec::new(),
        };
        skills.extend(scan_skills_dir_with_options(&enterprise_dir, &options));
    }

    {
        let personal_dir = claude_home.join("skills");
        if personal_dir.exists() {
            let options = SkillScanOptions {
                scope: "global".to_string(),
                agents: claude_agents.clone(),
                source: Some("CCEM Claude skills".to_string()),
                version: None,
                provider: Some("claude".to_string()),
                plugin_name: None,
                plugin_marketplace: None,
                disabled: false,
                visibility: Some("native".to_string()),
                implicit_allowed: true,
                diagnostics: Vec::new(),
            };
            skills.extend(scan_skills_dir_with_options(&personal_dir, &options));
        }
    }

    for project_dir in collect_workspace_skill_dirs(working_dir, ".claude", home) {
        let options = SkillScanOptions {
            scope: "project".to_string(),
            agents: claude_agents.clone(),
            source: Some(".claude/skills".to_string()),
            version: None,
            provider: Some("claude".to_string()),
            plugin_name: None,
            plugin_marketplace: None,
            disabled: false,
            visibility: Some("native".to_string()),
            implicit_allowed: true,
            diagnostics: Vec::new(),
        };
        skills.extend(scan_skills_dir_with_options(&project_dir, &options));
    }

    skills.extend(scan_claude_plugin_skills(claude_home));
    if let Some(home) = home {
        let shared_agents_dir = home.join(".agents").join("skills");
        if shared_agents_dir.exists() {
            let options = SkillScanOptions {
                scope: "global".to_string(),
                agents: claude_agents.clone(),
                source: Some("~/.agents/skills".to_string()),
                version: None,
                provider: Some("claude".to_string()),
                plugin_name: None,
                plugin_marketplace: None,
                disabled: false,
                visibility: Some("explicit-only".to_string()),
                implicit_allowed: false,
                diagnostics: vec![
                    ".agents/skills is injected exactly by CCEM when selected; Claude native implicit discovery is not assumed".to_string(),
                ],
            };
            skills.extend(scan_skills_dir_with_options(&shared_agents_dir, &options));
        }
    }

    for project_agents_dir in collect_workspace_skill_dirs(working_dir, ".agents", home) {
        let options = SkillScanOptions {
            scope: "project".to_string(),
            agents: claude_agents.clone(),
            source: Some(".agents/skills".to_string()),
            version: None,
            provider: Some("claude".to_string()),
            plugin_name: None,
            plugin_marketplace: None,
            disabled: false,
            visibility: Some("explicit-only".to_string()),
            implicit_allowed: false,
            diagnostics: vec![
                ".agents/skills is available through CCEM exact-path injection only for Claude"
                    .to_string(),
            ],
        };
        skills.extend(scan_skills_dir_with_options(&project_agents_dir, &options));
    }

    let overrides = read_claude_skill_overrides(home, claude_home, working_dir);
    for skill in &mut skills {
        apply_claude_overrides(skill, &overrides);
    }

    apply_claude_native_priority(skills)
}

/// Scan plugin skills from the CCEM Claude profile.
fn scan_claude_plugin_skills(claude_home: &Path) -> Vec<InstalledSkill> {
    let mut skills = Vec::new();
    // Read installed_plugins.json
    let plugins_json = claude_home.join("plugins").join("installed_plugins.json");
    let content = match std::fs::read_to_string(&plugins_json) {
        Ok(c) => c,
        Err(_) => return skills,
    };

    // Parse: { "plugins": { "name@marketplace": [{ "scope": "...", "installPath": "...", "version": "..." }] } }
    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return skills,
    };

    let plugins = match parsed.get("plugins").and_then(|p| p.as_object()) {
        Some(p) => p,
        None => return skills,
    };

    for (plugin_key, installs) in plugins {
        // Extract name and marketplace from "name@marketplace"
        let mut parts = plugin_key.split('@');
        let plugin_name = parts.next().unwrap_or("unknown").to_string();
        let marketplace = parts.next().unwrap_or("unknown").to_string();

        let installs_arr = match installs.as_array() {
            Some(a) => a,
            None => continue,
        };

        for install in installs_arr {
            let install_path = match install.get("installPath").and_then(|p| p.as_str()) {
                Some(p) => PathBuf::from(p),
                None => continue,
            };
            let version = install
                .get("version")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            // Scan installPath/skills/ for SKILL.md subdirectories
            let skills_dir = install_path.join("skills");
            if skills_dir.exists() {
                let options = SkillScanOptions {
                    scope: "plugin".to_string(),
                    agents: vec!["Claude Code".to_string()],
                    source: Some(marketplace.clone()),
                    version: version.clone(),
                    provider: Some("claude".to_string()),
                    plugin_name: Some(plugin_name.clone()),
                    plugin_marketplace: Some(marketplace.clone()),
                    disabled: false,
                    visibility: Some("native".to_string()),
                    implicit_allowed: true,
                    diagnostics: Vec::new(),
                };
                let plugin_skills = scan_skills_dir_with_options(&skills_dir, &options);
                skills.extend(plugin_skills);
            }
        }
    }

    skills
}

/// Backward-compatible wrapper for the installed skills settings view.
fn scan_plugin_skills() -> Vec<InstalledSkill> {
    scan_claude_plugin_skills(&agent_home::claude_home())
}

fn ccem_agent_skill_file_targets(claude_home: &Path, codex_home: &Path) -> Vec<(String, PathBuf)> {
    vec![
        (
            "Codex".to_string(),
            codex_home
                .join("skills")
                .join(CCEM_AGENT_SKILL_NAME)
                .join("SKILL.md"),
        ),
        (
            "Claude Code".to_string(),
            claude_home
                .join("skills")
                .join(CCEM_AGENT_SKILL_NAME)
                .join("SKILL.md"),
        ),
    ]
}

fn get_ccem_agent_skill_status_for_homes(
    claude_home: &Path,
    codex_home: &Path,
) -> Result<CcemAgentSkillStatus, String> {
    let targets: Vec<CcemAgentSkillTarget> = ccem_agent_skill_file_targets(claude_home, codex_home)
        .into_iter()
        .map(|(agent, path)| {
            let content = std::fs::read_to_string(&path).ok();
            let installed = content.is_some();
            let up_to_date = content.as_deref() == Some(CCEM_AGENT_SKILL_CONTENT);
            CcemAgentSkillTarget {
                agent,
                path: path.to_string_lossy().to_string(),
                installed,
                up_to_date,
            }
        })
        .collect();
    let installed = targets.iter().all(|target| target.installed);
    let up_to_date = targets.iter().all(|target| target.up_to_date);

    Ok(CcemAgentSkillStatus {
        name: CCEM_AGENT_SKILL_NAME.to_string(),
        installed,
        up_to_date,
        targets,
    })
}

fn install_ccem_agent_skill_for_homes(
    claude_home: &Path,
    codex_home: &Path,
) -> Result<CcemAgentSkillStatus, String> {
    for (_, path) in ccem_agent_skill_file_targets(claude_home, codex_home) {
        reject_symlink_path(&path)?;
        let Some(parent) = path.parent() else {
            return Err(format!(
                "Invalid CCEM agent skill target: {}",
                path.to_string_lossy()
            ));
        };
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {}", parent.display(), error))?;
        std::fs::write(&path, CCEM_AGENT_SKILL_CONTENT)
            .map_err(|error| format!("Failed to write {}: {}", path.display(), error))?;
    }

    get_ccem_agent_skill_status_for_homes(claude_home, codex_home)
}

// ============================================
// Tauri Commands
// ============================================

#[tauri::command]
pub async fn get_ccem_agent_skill_status() -> Result<CcemAgentSkillStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        agent_home::ensure_agent_homes()?;
        get_ccem_agent_skill_status_for_homes(&agent_home::claude_home(), &agent_home::codex_home())
    })
    .await
    .map_err(|error| format!("Failed to read CCEM agent skill status: {}", error))?
}

#[tauri::command]
pub async fn install_ccem_agent_skill() -> Result<CcemAgentSkillStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        agent_home::ensure_agent_homes()?;
        install_ccem_agent_skill_for_homes(&agent_home::claude_home(), &agent_home::codex_home())
    })
    .await
    .map_err(|error| format!("Failed to install CCEM agent skill: {}", error))?
}

/// Stream skill search results via Claude CLI subprocess.
/// Emits "skill-search-stream" events for each line, then "skill-search-done".
#[tauri::command]
pub fn search_skills_stream(app: AppHandle, query: String) {
    std::thread::spawn(move || {
        if let Err(error) = agent_home::ensure_agent_homes() {
            let _ = app.emit(
                "skill-search-stream",
                serde_json::json!({
                    "type": "error", "error": error,
                })
                .to_string(),
            );
            let _ = app.emit("skill-search-done", ());
            return;
        }
        let prompt = format!(
            "用户想找: {}，请用 npx skills find 搜索并以 JSON 返回推荐，JSON 格式为 [{{\"name\": \"...\", \"package_id\": \"...\", \"description\": \"...\", \"source\": \"skills.sh\"}}]",
            query
        );

        let user_path = get_user_path();

        let mut cmd = Command::new("claude");
        cmd.args([
            "-p",
            &prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--allowedTools",
            "Bash(npx skills find *)",
        ])
        .env("PATH", user_path)
        .env_remove("CLAUDECODE")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

        // Set working directory to avoid running in `/`
        if let Some(dir) = config::get_default_working_dir() {
            cmd.current_dir(&dir);
        } else if let Some(home) = dirs::home_dir() {
            cmd.current_dir(home);
        }

        // Apply the application profile before its selected model connection.
        crate::agent_profile::configure_command("claude", &mut cmd);
        config::inject_ai_env(&mut cmd);

        let child = cmd.spawn();

        match child {
            Ok(mut process) => {
                if let Some(stdout) = process.stdout.take() {
                    let reader = std::io::BufReader::new(stdout);
                    for line in reader.lines() {
                        match line {
                            Ok(l) if !l.trim().is_empty() => {
                                let _ = app.emit("skill-search-stream", &l);
                            }
                            _ => {}
                        }
                    }
                }
                let _ = process.wait();
                let _ = app.emit("skill-search-done", ());
            }
            Err(e) => {
                let _ = app.emit(
                    "skill-search-stream",
                    &serde_json::json!({
                        "type": "error",
                        "error": format!("Failed to start claude CLI: {}", e)
                    })
                    .to_string(),
                );
                let _ = app.emit("skill-search-done", ());
            }
        }
    });
}

/// List all installed skills from three sources:
/// 1. CCEM profile skills and shared ~/.agents/skills/
/// 2. Plugin skills from the CCEM Claude profile
/// 3. Project skills: <defaultWorkingDir>/.claude/skills/ (optional)
#[tauri::command]
pub async fn list_workspace_skills(
    working_dir: Option<String>,
    provider: Option<String>,
) -> Result<Vec<InstalledSkill>, String> {
    tauri::async_runtime::spawn_blocking(move || list_workspace_skills_sync(working_dir, provider))
        .await
        .map_err(|error| format!("Failed to join workspace skill scan task: {}", error))?
}

fn list_workspace_skills_sync(
    working_dir: Option<String>,
    provider: Option<String>,
) -> Result<Vec<InstalledSkill>, String> {
    agent_home::ensure_agent_homes()?;
    let home = dirs::home_dir();
    let working_dir = working_dir
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let normalized_provider = provider
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    let mut skills = Vec::new();
    match normalized_provider.as_deref() {
        Some("codex") => {
            skills.extend(scan_codex_skills_for_context(
                home.as_deref(),
                &agent_home::codex_home(),
                working_dir.as_deref(),
            ));
        }
        Some("claude") | Some("claude-code") => {
            skills.extend(scan_claude_skills_for_context(
                home.as_deref(),
                &agent_home::claude_home(),
                working_dir.as_deref(),
            ));
        }
        _ => {
            skills.extend(scan_claude_skills_for_context(
                home.as_deref(),
                &agent_home::claude_home(),
                working_dir.as_deref(),
            ));
            skills.extend(scan_codex_skills_for_context(
                home.as_deref(),
                &agent_home::codex_home(),
                working_dir.as_deref(),
            ));
        }
    }

    mark_managed_skills(&mut skills);
    skills.sort_by(|left, right| {
        let left_disabled = left.disabled;
        let right_disabled = right.disabled;
        left_disabled
            .cmp(&right_disabled)
            .then_with(|| left.provider.cmp(&right.provider))
            .then_with(|| left.scope.cmp(&right.scope))
            .then_with(|| {
                left.display_name
                    .as_deref()
                    .unwrap_or(&left.name)
                    .to_ascii_lowercase()
                    .cmp(
                        &right
                            .display_name
                            .as_deref()
                            .unwrap_or(&right.name)
                            .to_ascii_lowercase(),
                    )
            })
            .then_with(|| left.path.cmp(&right.path))
    });

    Ok(skills)
}

#[tauri::command]
pub fn read_skill_files(skill_files: Vec<String>) -> Result<Vec<SelectedSkillContent>, String> {
    let mut seen = HashSet::new();
    let mut selected = Vec::new();

    for raw_path in skill_files {
        if !seen.insert(raw_path.clone()) {
            continue;
        }
        let path = PathBuf::from(&raw_path);
        let directory = path
            .parent()
            .map(|parent| parent.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut diagnostics = Vec::new();

        if path.file_name().and_then(|name| name.to_str()) != Some("SKILL.md") {
            diagnostics.push("Selected path is not a SKILL.md file".to_string());
            selected.push(SelectedSkillContent {
                skill_file: raw_path,
                directory,
                name: None,
                description: None,
                content: String::new(),
                resource_hints: Vec::new(),
                diagnostics,
            });
            continue;
        }

        match std::fs::read_to_string(&path) {
            Ok(content) => {
                let metadata = parse_skill_metadata(&content);
                diagnostics.extend(metadata.diagnostics.clone());
                selected.push(SelectedSkillContent {
                    skill_file: path.to_string_lossy().to_string(),
                    directory,
                    name: metadata.name,
                    description: metadata.description,
                    content,
                    resource_hints: collect_skill_resource_hints(path.parent()),
                    diagnostics,
                });
            }
            Err(error) => {
                diagnostics.push(format!("Failed to read selected skill: {}", error));
                selected.push(SelectedSkillContent {
                    skill_file: raw_path,
                    directory,
                    name: None,
                    description: None,
                    content: String::new(),
                    resource_hints: Vec::new(),
                    diagnostics,
                });
            }
        }
    }

    Ok(selected)
}

fn collect_skill_resource_hints(directory: Option<&Path>) -> Vec<String> {
    let Some(directory) = directory else {
        return Vec::new();
    };
    let mut hints = Vec::new();
    for resource_dir in ["scripts", "examples", "templates", "assets", "references"] {
        let path = directory.join(resource_dir);
        if path.exists() {
            hints.push(path.to_string_lossy().to_string());
        }
    }
    hints
}

#[tauri::command]
pub async fn list_installed_skills() -> Result<Vec<InstalledSkill>, String> {
    tauri::async_runtime::spawn_blocking(list_installed_skills_sync)
        .await
        .map_err(|error| format!("Failed to join installed skill scan task: {}", error))?
}

fn list_installed_skills_sync() -> Result<Vec<InstalledSkill>, String> {
    agent_home::ensure_agent_homes()?;
    let mut all_skills = Vec::new();

    if let Some(home) = dirs::home_dir() {
        // Source 1: Filesystem skills — scan multiple agent directories
        let claude_agents = ["Claude Code"];
        let codex_agents = ["Codex"];

        // CCEM Claude profile → Claude Code
        let claude_skills_dir = agent_home::claude_home().join("skills");
        if claude_skills_dir.exists() {
            all_skills.extend(scan_skills_dir(
                &claude_skills_dir,
                "global",
                &claude_agents
                    .iter()
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>(),
                Some("skills.sh"),
            ));
        }

        // ~/.agents/skills/ → Claude Code + Codex (shared)
        let agents_skills_dir = home.join(".agents").join("skills");
        if agents_skills_dir.exists() {
            let both_agents = vec!["Claude Code".to_string(), "Codex".to_string()];
            all_skills.extend(scan_skills_dir(
                &agents_skills_dir,
                "global",
                &both_agents,
                Some("skills.sh"),
            ));
        }

        // CCEM Codex profile → Codex
        let codex_skills_dir = agent_home::codex_home().join("skills");
        if codex_skills_dir.exists() {
            all_skills.extend(scan_skills_dir(
                &codex_skills_dir,
                "global",
                &codex_agents
                    .iter()
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>(),
                Some("skills.sh"),
            ));
        }

        // Source 2: Plugin skills
        all_skills.extend(scan_plugin_skills());
    }

    // Source 3: Project skills (if defaultWorkingDir is configured)
    if let Some(working_dir) = config::get_default_working_dir() {
        for project_skills_dir in collect_workspace_skill_dirs(
            Some(Path::new(&working_dir)),
            ".claude",
            dirs::home_dir().as_deref(),
        ) {
            all_skills.extend(scan_skills_dir(
                &project_skills_dir,
                "project",
                &["Claude Code".to_string()],
                None,
            ));
        }
    }

    mark_managed_skills(&mut all_skills);
    Ok(all_skills)
}

/// Return curated skill list for the Discover tab.
#[tauri::command]
pub fn get_curated_skills() -> Vec<CuratedSkill> {
    vec![
        // === Official (anthropics/skills) ===
        CuratedSkill {
            name: "Frontend Design".into(),
            package_id: "anthropics/skills".into(),
            skill_name: "frontend-design".into(),
            description: "Create distinctive, production-grade frontend interfaces with high design quality".into(),
            category: "official".into(),
            install_type: "skills".into(),
        },
        CuratedSkill {
            name: "Skill Creator".into(),
            package_id: "anthropics/skills".into(),
            skill_name: "skill-creator".into(),
            description: "Create and publish custom skills for Claude Code".into(),
            category: "official".into(),
            install_type: "skills".into(),
        },
        CuratedSkill {
            name: "Web Artifacts Builder".into(),
            package_id: "anthropics/skills".into(),
            skill_name: "web-artifacts-builder".into(),
            description: "Build interactive web artifacts with HTML/CSS/JS".into(),
            category: "official".into(),
            install_type: "skills".into(),
        },
        CuratedSkill {
            name: "MCP Builder".into(),
            package_id: "anthropics/skills".into(),
            skill_name: "mcp-builder".into(),
            description: "Build Model Context Protocol servers and tools".into(),
            category: "official".into(),
            install_type: "skills".into(),
        },
        CuratedSkill {
            name: "WebApp Testing".into(),
            package_id: "anthropics/skills".into(),
            skill_name: "webapp-testing".into(),
            description: "Automated testing for web applications".into(),
            category: "official".into(),
            install_type: "skills".into(),
        },
        CuratedSkill {
            name: "PDF".into(),
            package_id: "anthropics/skills".into(),
            skill_name: "pdf".into(),
            description: "Read, analyze, and extract data from PDF files".into(),
            category: "official".into(),
            install_type: "skills".into(),
        },
        CuratedSkill {
            name: "DOCX".into(),
            package_id: "anthropics/skills".into(),
            skill_name: "docx".into(),
            description: "Read and create Word documents".into(),
            category: "official".into(),
            install_type: "skills".into(),
        },
        CuratedSkill {
            name: "PPTX".into(),
            package_id: "anthropics/skills".into(),
            skill_name: "pptx".into(),
            description: "Create PowerPoint presentations".into(),
            category: "official".into(),
            install_type: "skills".into(),
        },
        CuratedSkill {
            name: "XLSX".into(),
            package_id: "anthropics/skills".into(),
            skill_name: "xlsx".into(),
            description: "Read and create Excel spreadsheets".into(),
            category: "official".into(),
            install_type: "skills".into(),
        },
        CuratedSkill {
            name: "Canvas Design".into(),
            package_id: "anthropics/skills".into(),
            skill_name: "canvas-design".into(),
            description: "Create visual designs and graphics using HTML Canvas".into(),
            category: "official".into(),
            install_type: "skills".into(),
        },
        CuratedSkill {
            name: "Algorithmic Art".into(),
            package_id: "anthropics/skills".into(),
            skill_name: "algorithmic-art".into(),
            description: "Generate algorithmic and generative art".into(),
            category: "official".into(),
            install_type: "skills".into(),
        },
        CuratedSkill {
            name: "Theme Factory".into(),
            package_id: "anthropics/skills".into(),
            skill_name: "theme-factory".into(),
            description: "Design and create custom themes for applications".into(),
            category: "official".into(),
            install_type: "skills".into(),
        },
        // === Popular (vercel-labs/agent-skills) ===
        CuratedSkill {
            name: "Vercel React Best Practices".into(),
            package_id: "vercel-labs/agent-skills".into(),
            skill_name: "vercel-react-best-practices".into(),
            description: "React and Next.js performance optimization guidelines from Vercel Engineering".into(),
            category: "popular".into(),
            install_type: "skills".into(),
        },
        CuratedSkill {
            name: "Deploy to Vercel".into(),
            package_id: "vercel-labs/agent-skills".into(),
            skill_name: "deploy-to-vercel".into(),
            description: "Deploy applications to Vercel with best practices".into(),
            category: "popular".into(),
            install_type: "skills".into(),
        },
        CuratedSkill {
            name: "Vercel Composition Patterns".into(),
            package_id: "vercel-labs/agent-skills".into(),
            skill_name: "vercel-composition-patterns".into(),
            description: "Advanced React composition patterns from Vercel".into(),
            category: "popular".into(),
            install_type: "skills".into(),
        },
        // === Community ===
        CuratedSkill {
            name: "Superpowers".into(),
            package_id: "obra/superpowers-marketplace".into(),
            skill_name: "superpowers".into(),
            description: "A marketplace of powerful skills for Claude Code — code review, TDD, debugging, and more".into(),
            category: "community".into(),
            install_type: "plugin".into(),
        },
        CuratedSkill {
            name: "UI/UX Pro Max".into(),
            package_id: "anthropics/skills".into(),
            skill_name: "ui-ux-pro-max".into(),
            description: "Professional UI/UX design intelligence with 50+ styles and component systems".into(),
            category: "community".into(),
            install_type: "plugin".into(),
        },
        CuratedSkill {
            name: "Humanizer ZH".into(),
            package_id: "anthropics/skills".into(),
            skill_name: "Humanizer-zh".into(),
            description: "Remove AI-generated traces from Chinese text, making it sound more natural".into(),
            category: "community".into(),
            install_type: "skills".into(),
        },
    ]
}

fn profile_skill_roots() -> Vec<PathBuf> {
    vec![
        agent_home::claude_home().join("skills"),
        agent_home::codex_home().join("skills"),
    ]
}

/// Never follow an installed skill or profile symlink while modifying files.
fn reject_symlink_path(path: &Path) -> Result<(), String> {
    if path
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("Skill paths must not contain parent-directory traversal".to_string());
    }
    for ancestor in path.ancestors() {
        if std::fs::symlink_metadata(ancestor)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(format!(
                "Refusing to modify a symlinked skill path: {}",
                ancestor.display()
            ));
        }
    }
    Ok(())
}

fn is_owned_skill_path(path: &Path, roots: &[PathBuf]) -> bool {
    if reject_symlink_path(path).is_err() {
        return false;
    }
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };
    roots.iter().any(|root| {
        path != root
            && path.starts_with(root)
            && root.canonicalize().is_ok_and(|canonical_root| {
                canonical_path != canonical_root && canonical_path.starts_with(canonical_root)
            })
    })
}

fn mark_managed_skills(skills: &mut [InstalledSkill]) {
    let roots = profile_skill_roots();
    for skill in skills {
        skill.managed_by_ccem =
            skill.scope == "global" && is_owned_skill_path(Path::new(&skill.path), &roots);
    }
}

fn validate_project_skill_directory(working_dir: &Path, user_home: &Path) -> Result<(), String> {
    let working_dir = normalized_existing_or_raw(working_dir);
    let user_home = normalized_existing_or_raw(user_home);
    if working_dir == user_home
        || working_dir.starts_with(user_home.join(".claude"))
        || working_dir.starts_with(user_home.join(".codex"))
        || working_dir.starts_with(user_home.join(".agents"))
    {
        return Err(
            "Select a project outside the official agent and shared user directories".to_string(),
        );
    }
    Ok(())
}

fn skill_install_roots(
    global: bool,
    agents: Option<&[String]>,
    claude_home: &Path,
    codex_home: &Path,
    working_dir: Option<&Path>,
) -> Result<Vec<PathBuf>, String> {
    if !global {
        let working_dir =
            working_dir.ok_or("Select a project directory before installing project skills")?;
        if let Some(user_home) = dirs::home_dir() {
            validate_project_skill_directory(working_dir, &user_home)?;
        }
    }
    let default_agents = vec!["Claude Code".to_string(), "Codex".to_string()];
    let agents = agents
        .filter(|agents| !agents.is_empty())
        .unwrap_or(&default_agents);
    let mut roots = Vec::new();
    for agent in agents {
        let root = match agent.as_str() {
            "Claude Code" | "claude-code" | "claude" => {
                if global {
                    claude_home.join("skills")
                } else {
                    working_dir
                        .ok_or("Select a project directory before installing project skills")?
                        .join(".claude/skills")
                }
            }
            "Codex" | "codex" => {
                if global {
                    codex_home.join("skills")
                } else {
                    working_dir
                        .ok_or("Select a project directory before installing project skills")?
                        .join(".agents/skills")
                }
            }
            other => return Err(format!("Unsupported CCEM skill agent: {}", other)),
        };
        reject_symlink_path(&root)?;
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    Ok(roots)
}

fn copy_skill_tree(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Skill packages cannot contain symlinks: {}",
            source.display()
        ));
    }
    if metadata.is_dir() {
        std::fs::create_dir_all(target).map_err(|error| error.to_string())?;
        for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            copy_skill_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        std::fs::copy(source, target).map_err(|error| error.to_string())?;
    } else {
        return Err(format!(
            "Unsupported file in skill package: {}",
            source.display()
        ));
    }
    Ok(())
}

fn promote_staged_skills(staging: &Path, roots: &[PathBuf]) -> Result<usize, String> {
    let staged_root = staging.join(".claude/skills");
    let entries = std::fs::read_dir(&staged_root)
        .map_err(|_| "The package did not install any skills".to_string())?;
    let mut sources = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.path().join("SKILL.md").is_file() {
            sources.push(entry.path());
        }
    }
    if sources.is_empty() {
        return Err("The package did not install any skills".to_string());
    }
    for root in roots {
        reject_symlink_path(root)?;
        std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
        for source in &sources {
            let name = source
                .file_name()
                .ok_or("Invalid skill package directory")?;
            let target = root.join(name);
            reject_symlink_path(&target)?;
            let prepared = root.join(format!(".ccem-skill-install-{}", rand::random::<u64>()));
            if let Err(error) = copy_skill_tree(source, &prepared) {
                let _ = std::fs::remove_dir_all(&prepared);
                return Err(error);
            }
            let backup = root.join(format!(".ccem-skill-backup-{}", rand::random::<u64>()));
            let had_target = target.exists();
            if had_target {
                if let Err(error) = std::fs::rename(&target, &backup) {
                    let _ = std::fs::remove_dir_all(&prepared);
                    return Err(error.to_string());
                }
            }
            if let Err(error) = std::fs::rename(&prepared, &target) {
                if had_target {
                    let _ = std::fs::rename(&backup, &target);
                }
                let _ = std::fs::remove_dir_all(&prepared);
                return Err(error.to_string());
            }
            if had_target {
                std::fs::remove_dir_all(backup).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(sources.len())
}

fn staged_skill_install_command(
    staging: &Path,
    package_id: &str,
    skill_name: Option<&str>,
) -> Command {
    let mut command = Command::new("npx");
    // skills' global Codex target is ~/.agents/skills, regardless of CODEX_HOME.
    // Project copy mode writes only in staging; CCEM promotes physical files.
    command.args([
        "--yes",
        "skills",
        "add",
        package_id,
        "-y",
        "--copy",
        "--agent",
        "claude-code",
    ]);
    if let Some(skill_name) = skill_name {
        command.args(["--skill", skill_name]);
    }
    command.current_dir(staging).env("PATH", get_user_path());
    command
}

fn install_skill_sync(
    package_id: &str,
    skill_name: Option<&str>,
    global: bool,
    agents: Option<&[String]>,
) -> Result<String, String> {
    if package_id.trim().is_empty()
        || package_id.starts_with('-')
        || skill_name.is_some_and(|name| name.trim().is_empty() || name.starts_with('-'))
    {
        return Err("A valid skill package and skill name are required".to_string());
    }
    agent_home::ensure_agent_homes()?;
    let working_dir = config::get_default_working_dir().map(PathBuf::from);
    let roots = skill_install_roots(
        global,
        agents,
        &agent_home::claude_home(),
        &agent_home::codex_home(),
        working_dir.as_deref(),
    )?;
    let staging_parent = agent_home::claude_home().join(".skill-staging");
    reject_symlink_path(&staging_parent)?;
    std::fs::create_dir_all(&staging_parent).map_err(|error| error.to_string())?;
    let staging = staging_parent.join(format!("{}-{}", std::process::id(), rand::random::<u64>()));
    std::fs::create_dir(&staging).map_err(|error| error.to_string())?;
    let result = (|| {
        let output = staged_skill_install_command(&staging, package_id, skill_name)
            .output()
            .map_err(|error| format!("Failed to run npx: {}", error))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(if stderr.trim().is_empty() {
                stdout.to_string()
            } else {
                stderr.to_string()
            });
        }
        let count = promote_staged_skills(&staging, &roots)?;
        Ok(format!(
            "Installed {} skill(s) in the selected CCEM profiles",
            count
        ))
    })();
    let _ = std::fs::remove_dir_all(staging);
    result
}

fn uninstall_skill_from_roots(
    name: &str,
    path: Option<&Path>,
    roots: &[PathBuf],
) -> Result<String, String> {
    let matches: Vec<_> = roots
        .iter()
        .flat_map(|root| scan_skills_dir(root, "global", &[], None))
        .filter(|skill| skill.name == name && is_owned_skill_path(Path::new(&skill.path), roots))
        .filter(|skill| path.is_none_or(|path| path == Path::new(&skill.path)))
        .collect();
    if matches.len() != 1 {
        return Err("Select an exact CCEM-owned skill; shared, plugin and official-app skills are managed at their source".to_string());
    }
    std::fs::remove_dir_all(&matches[0].path).map_err(|error| error.to_string())?;
    Ok(format!("Removed {} from the selected CCEM profile", name))
}

/// Install into a temporary project, then copy only into the selected CCEM profiles.
#[tauri::command]
pub fn install_skill(
    app: AppHandle,
    package_id: String,
    skill_name: Option<String>,
    global: bool,
    agents: Option<Vec<String>>,
) {
    std::thread::spawn(move || {
        let result = install_skill_sync(
            &package_id,
            skill_name.as_deref(),
            global,
            agents.as_deref(),
        );
        let payload = serde_json::json!({
            "package_id": package_id,
            "success": result.is_ok(),
            "message": result.unwrap_or_else(|error| error),
        });
        let _ = app.emit("skill-install-done", payload.to_string());
    });
}

/// Remove only the selected physical skill directory; never run a global CLI removal.
#[tauri::command]
pub fn uninstall_skill(app: AppHandle, name: String, global: bool, path: Option<String>) {
    std::thread::spawn(move || {
        let working_dir = config::get_default_working_dir().map(PathBuf::from);
        let result = agent_home::ensure_agent_homes()
            .and_then(|_| {
                skill_install_roots(
                    global,
                    None,
                    &agent_home::claude_home(),
                    &agent_home::codex_home(),
                    working_dir.as_deref(),
                )
            })
            .and_then(|roots| {
                uninstall_skill_from_roots(&name, path.as_deref().map(Path::new), &roots)
            });
        let payload = serde_json::json!({
            "name": name,
            "success": result.is_ok(),
            "message": result.unwrap_or_else(|error| error),
        });
        let _ = app.emit("skill-uninstall-done", payload.to_string());
    });
}

// ============================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_test_skill(path: &Path, name: &str) {
        fs::create_dir_all(path).unwrap();
        fs::write(path.join("SKILL.md"), format!("---\nname: {}\n---\n", name)).unwrap();
    }

    #[test]
    fn profile_skill_scans_ignore_official_settings_plugins_and_skills() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let claude_home = home.join(".ccem/agents/claude");
        let codex_home = home.join(".ccem/agents/codex");
        let project = home.join("project/non-git");
        write_test_skill(&home.join(".claude/skills/official"), "official-claude");
        write_test_skill(&home.join(".codex/skills/official"), "official-codex");
        write_test_skill(&home.join(".agents/skills/shared"), "shared");
        write_test_skill(&claude_home.join("skills/private"), "private-claude");
        write_test_skill(&codex_home.join("skills/private"), "private-codex");
        write_test_skill(&project.join(".claude/skills/project"), "project-claude");
        write_test_skill(&project.join(".agents/skills/project"), "project-codex");
        fs::write(
            home.join(".claude/settings.json"),
            r#"{"skillOverrides":{"private-claude":"off"}}"#,
        )
        .unwrap();
        fs::write(
            home.join(".codex/config.toml"),
            format!(
                "[[skills.config]]\npath = {:?}\nenabled = false\n",
                codex_home.join("skills").to_string_lossy()
            ),
        )
        .unwrap();
        let official_plugin = home.join(".claude/plugins/cache/market/plugin/1");
        write_test_skill(&official_plugin.join("skills/hidden"), "official-plugin");
        fs::write(
            home.join(".claude/plugins/installed_plugins.json"),
            serde_json::json!({"plugins":{"plugin@market":[{"installPath":official_plugin}]}})
                .to_string(),
        )
        .unwrap();
        write_test_skill(
            &home.join(".codex/plugins/cache/market/plugin/skills/hidden"),
            "official-codex-plugin",
        );

        let claude = scan_claude_skills_for_context(Some(&home), &claude_home, Some(&project));
        let codex = scan_codex_skills_for_context(Some(&home), &codex_home, Some(&project));
        let claude_names: HashSet<_> = claude.iter().map(|skill| skill.name.as_str()).collect();
        let codex_names: HashSet<_> = codex.iter().map(|skill| skill.name.as_str()).collect();
        assert!(claude_names.is_superset(&HashSet::from([
            "private-claude",
            "project-claude",
            "shared"
        ])));
        assert!(codex_names.is_superset(&HashSet::from([
            "private-codex",
            "project-codex",
            "shared"
        ])));
        assert!(!claude
            .iter()
            .chain(codex.iter())
            .any(|skill| skill.name.starts_with("official")));
        assert!(
            !claude
                .iter()
                .find(|skill| skill.name == "private-claude")
                .unwrap()
                .disabled
        );
        assert!(
            !codex
                .iter()
                .find(|skill| skill.name == "private-codex")
                .unwrap()
                .disabled
        );

        fs::write(
            claude_home.join("settings.json"),
            r#"{"skillOverrides":{"private-claude":"off"}}"#,
        )
        .unwrap();
        let claude = scan_claude_skills_for_context(Some(&home), &claude_home, Some(&project));
        assert!(
            claude
                .iter()
                .find(|skill| skill.name == "private-claude")
                .unwrap()
                .disabled
        );
    }

    #[test]
    fn staged_skill_install_copies_selected_profiles_without_global_cli_writes() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let claude_home = home.join(".ccem/agents/claude");
        let codex_home = home.join(".ccem/agents/codex");
        let staging = home.join("staging");
        let source = staging.join(".claude/skills/example");
        write_test_skill(&source, "Example Skill");
        fs::create_dir_all(source.join("scripts")).unwrap();
        fs::write(source.join("scripts/run.sh"), "echo example").unwrap();
        let official = home.join(".claude/skills/example");
        let shared = home.join(".agents/skills/example");
        write_test_skill(&official, "official untouched");
        write_test_skill(&shared, "shared untouched");
        let roots = skill_install_roots(true, None, &claude_home, &codex_home, None).unwrap();
        assert_eq!(
            roots,
            vec![claude_home.join("skills"), codex_home.join("skills")]
        );
        assert_eq!(
            skill_install_roots(
                true,
                Some(&["Codex".into()]),
                &claude_home,
                &codex_home,
                None
            )
            .unwrap(),
            vec![codex_home.join("skills")]
        );
        assert_eq!(promote_staged_skills(&staging, &roots).unwrap(), 1);
        fs::remove_dir_all(staging).unwrap();
        for root in &roots {
            assert_eq!(
                fs::read_to_string(root.join("example/scripts/run.sh")).unwrap(),
                "echo example"
            );
            assert!(is_owned_skill_path(&root.join("example"), &roots));
        }
        assert!(fs::read_to_string(official.join("SKILL.md"))
            .unwrap()
            .contains("official untouched"));
        assert!(fs::read_to_string(shared.join("SKILL.md"))
            .unwrap()
            .contains("shared untouched"));
        assert!(!is_owned_skill_path(&official, &roots));
        assert!(!is_owned_skill_path(&shared, &roots));

        let command = staged_skill_install_command(&home, "example/skills", Some("example"));
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert!(args.contains(&"--copy".to_string()));
        assert!(!args.iter().any(|arg| arg == "--global" || arg == "-g"));
        assert_eq!(command.get_current_dir(), Some(home.as_path()));
    }

    #[test]
    fn project_skill_mutations_cannot_select_an_official_or_shared_user_directory() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        for path in [
            &home,
            &home.join(".claude"),
            &home.join(".codex/projects"),
            &home.join(".agents"),
        ] {
            assert!(validate_project_skill_directory(path, &home).is_err());
        }
        assert!(validate_project_skill_directory(&home.join("projects/repo"), &home).is_ok());
    }

    #[test]
    fn uninstall_removes_only_the_exact_owned_profile_skill() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let roots = vec![
            home.join("profiles/claude/skills"),
            home.join("profiles/codex/skills"),
        ];
        let official = home.join(".claude/skills/same");
        let shared = home.join(".agents/skills/same");
        for path in [
            &official,
            &shared,
            &roots[0].join("same"),
            &roots[1].join("same"),
        ] {
            write_test_skill(path, "same");
        }
        assert!(uninstall_skill_from_roots("same", Some(&official), &roots).is_err());
        assert!(uninstall_skill_from_roots("same", Some(&shared), &roots).is_err());
        assert!(uninstall_skill_from_roots("same", None, &roots).is_err());
        uninstall_skill_from_roots("same", Some(&roots[0].join("same")), &roots).unwrap();
        assert!(!roots[0].join("same").exists());
        assert!(roots[1].join("same/SKILL.md").exists());
        assert!(official.join("SKILL.md").exists());
        assert!(shared.join("SKILL.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn skill_mutations_reject_symlinks_to_external_skills() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let external = home.join("official/skills/same");
        let root = home.join("ccem/skills");
        write_test_skill(&external, "same");
        fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&external, root.join("same")).unwrap();
        assert!(!is_owned_skill_path(&root.join("same"), &[root.clone()]));
        assert!(
            uninstall_skill_from_roots("same", Some(&root.join("same")), &[root.clone()]).is_err()
        );
        let staging = home.join("staging");
        write_test_skill(&staging.join(".claude/skills/same"), "same");
        assert!(promote_staged_skills(&staging, &[root]).is_err());
        assert!(external.join("SKILL.md").exists());
    }

    #[test]
    fn test_parse_skill_frontmatter_with_data() {
        let content = r#"---
name: my-skill
description: A cool skill
---
# My Skill
Some content here.
"#;
        let (name, desc) = parse_skill_frontmatter(content);
        assert_eq!(name, Some("my-skill".to_string()));
        assert_eq!(desc, Some("A cool skill".to_string()));
    }

    #[test]
    fn test_parse_skill_frontmatter_quoted() {
        let content = "---\nname: \"quoted-name\"\ndescription: 'single quoted'\n---\n";
        let (name, desc) = parse_skill_frontmatter(content);
        assert_eq!(name, Some("quoted-name".to_string()));
        assert_eq!(desc, Some("single quoted".to_string()));
    }

    #[test]
    fn test_parse_skill_frontmatter_no_frontmatter() {
        let content = "# Just a markdown file\nNo frontmatter here.";
        let (name, desc) = parse_skill_frontmatter(content);
        assert_eq!(name, None);
        assert_eq!(desc, None);
    }

    #[test]
    fn test_parse_skill_frontmatter_empty() {
        let (name, desc) = parse_skill_frontmatter("");
        assert_eq!(name, None);
        assert_eq!(desc, None);
    }

    #[test]
    fn test_parse_skill_frontmatter_unclosed() {
        let content = "---\nname: broken\n";
        let (name, desc) = parse_skill_frontmatter(content);
        assert_eq!(name, None);
        assert_eq!(desc, None);
    }

    #[test]
    fn test_list_installed_skills_empty() {
        let dir = std::env::temp_dir().join("ccem-test-skills-empty");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let skills = scan_skills_dir(&dir, "global", &["Claude Code".to_string()], None);
        assert!(skills.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_list_installed_skills_with_skills() {
        let dir = std::env::temp_dir().join("ccem-test-skills-with");
        let _ = fs::remove_dir_all(&dir);
        let skill_dir = dir.join("test-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: Test Skill\ndescription: A test\n---\n# Test",
        )
        .unwrap();

        let skills = scan_skills_dir(
            &dir,
            "global",
            &["Claude Code".to_string()],
            Some("skills.sh"),
        );
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "Test Skill");
        assert_eq!(skills[0].description, "A test");
        assert_eq!(skills[0].scope, "global");
        assert_eq!(skills[0].agents, vec!["Claude Code"]);
        assert_eq!(skills[0].source, Some("skills.sh".to_string()));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_list_installed_skills_ignores_hidden() {
        let dir = std::env::temp_dir().join("ccem-test-skills-hidden");
        let _ = fs::remove_dir_all(&dir);
        let hidden = dir.join(".hidden-skill");
        fs::create_dir_all(&hidden).unwrap();
        fs::write(hidden.join("SKILL.md"), "---\nname: Hidden\n---\n").unwrap();

        let skills = scan_skills_dir(&dir, "global", &["Claude Code".to_string()], None);
        assert!(skills.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_list_installed_skills_fallback_dirname() {
        let dir = std::env::temp_dir().join("ccem-test-skills-fallback");
        let _ = fs::remove_dir_all(&dir);
        let skill_dir = dir.join("my-cool-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        // SKILL.md without frontmatter
        fs::write(
            skill_dir.join("SKILL.md"),
            "# Just a title\nNo frontmatter.",
        )
        .unwrap();

        let skills = scan_skills_dir(&dir, "global", &["Claude Code".to_string()], None);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "my-cool-skill");
        assert_eq!(skills[0].description, "");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_list_installed_skills_nested() {
        let dir = std::env::temp_dir().join("ccem-test-skills-nested");
        let _ = fs::remove_dir_all(&dir);
        // Pack directory without SKILL.md, containing nested skills
        let pack = dir.join("skill-pack");
        let nested = pack.join("sub-skill");
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            nested.join("SKILL.md"),
            "---\nname: Nested Skill\ndescription: Inside a pack\n---\n",
        )
        .unwrap();

        let skills = scan_skills_dir(&dir, "global", &["Claude Code".to_string()], None);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "Nested Skill");

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn test_scan_skills_dir_deduplicates_symlinked_skill_target() {
        let dir = std::env::temp_dir().join("ccem-test-skills-symlink-dedupe");
        let _ = fs::remove_dir_all(&dir);
        let real_skill = dir.join("real-skill");
        let linked_skill = dir.join("linked-skill");
        fs::create_dir_all(&real_skill).unwrap();
        fs::write(
            real_skill.join("SKILL.md"),
            "---\nname: Real Skill\ndescription: Linked once\n---\n",
        )
        .unwrap();
        std::os::unix::fs::symlink(&real_skill, &linked_skill).unwrap();

        let skills = scan_skills_dir(&dir, "global", &["Codex".to_string()], None);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "Real Skill");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_scan_skills_dir_skips_dependency_trees() {
        let dir = std::env::temp_dir().join("ccem-test-skills-skip-deps");
        let _ = fs::remove_dir_all(&dir);
        let dependency_skill = dir.join("node_modules").join("pkg").join("skill");
        fs::create_dir_all(&dependency_skill).unwrap();
        fs::write(
            dependency_skill.join("SKILL.md"),
            "---\nname: Dependency Skill\n---\n",
        )
        .unwrap();

        let skills = scan_skills_dir(&dir, "global", &["Codex".to_string()], None);
        assert!(skills.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_scan_skills_dir_limits_nested_depth() {
        let dir = std::env::temp_dir().join("ccem-test-skills-depth-limit");
        let _ = fs::remove_dir_all(&dir);
        let deep_skill = dir
            .join("one")
            .join("two")
            .join("three")
            .join("four")
            .join("five")
            .join("six")
            .join("seven")
            .join("too-deep");
        fs::create_dir_all(&deep_skill).unwrap();
        fs::write(deep_skill.join("SKILL.md"), "---\nname: Too Deep\n---\n").unwrap();

        let skills = scan_skills_dir(&dir, "global", &["Codex".to_string()], None);
        assert!(skills.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    fn skill_for_test(name: &str, scope: &str, path: &str) -> InstalledSkill {
        InstalledSkill {
            name: name.to_string(),
            description: String::new(),
            path: path.to_string(),
            scope: scope.to_string(),
            agents: vec!["Claude Code".to_string()],
            source: None,
            version: None,
            id: format!("test:{}", path),
            provider: Some("claude".to_string()),
            skill_file: Some(format!("{}/SKILL.md", path)),
            display_name: Some(name.to_string()),
            invocation_label: Some(name.to_string()),
            plugin_name: None,
            plugin_marketplace: None,
            disabled: false,
            visibility: Some("native".to_string()),
            implicit_allowed: true,
            ui_metadata: None,
            diagnostics: Vec::new(),
            managed_by_ccem: false,
        }
    }

    #[test]
    fn test_yaml_frontmatter_multiline_description() {
        let content = "---\nname: deep-research\ndescription: >\n  Search docs deeply,\n  then implement.\n---\n";
        let (name, desc) = parse_skill_frontmatter(content);
        assert_eq!(name, Some("deep-research".to_string()));
        assert_eq!(
            desc,
            Some("Search docs deeply, then implement.".to_string())
        );
    }

    #[test]
    fn test_codex_duplicate_names_are_preserved() {
        let dir = std::env::temp_dir().join("ccem-test-skills-duplicates");
        let _ = fs::remove_dir_all(&dir);
        for child in ["project-one", "project-two"] {
            let skill_dir = dir.join(child);
            fs::create_dir_all(&skill_dir).unwrap();
            fs::write(
                skill_dir.join("SKILL.md"),
                "---\nname: duplicate\ndescription: same name\n---\n",
            )
            .unwrap();
        }

        let options = SkillScanOptions {
            scope: "project".to_string(),
            agents: vec!["Codex".to_string()],
            source: Some(".agents/skills".to_string()),
            version: None,
            provider: Some("codex".to_string()),
            plugin_name: None,
            plugin_marketplace: None,
            disabled: false,
            visibility: Some("native".to_string()),
            implicit_allowed: true,
            diagnostics: Vec::new(),
        };
        let skills = scan_skills_dir_with_options(&dir, &options);
        assert_eq!(skills.len(), 2);
        assert!(skills.iter().all(|skill| skill.name == "duplicate"));
        assert_ne!(skills[0].skill_file, skills[1].skill_file);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_claude_native_priority_prefers_personal_over_project() {
        let skills = apply_claude_native_priority(vec![
            skill_for_test("same", "project", "/tmp/project/same"),
            skill_for_test("same", "global", "/tmp/global/same"),
        ]);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].scope, "global");
        assert_eq!(skills[0].path, "/tmp/global/same");
    }

    #[test]
    fn test_claude_plugin_skills_are_namespaced() {
        let dir = std::env::temp_dir().join("ccem-test-skills-plugin-namespace");
        let _ = fs::remove_dir_all(&dir);
        let skill_dir = dir.join("lint");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: lint\n---\n").unwrap();

        let options = SkillScanOptions {
            scope: "plugin".to_string(),
            agents: vec!["Claude Code".to_string()],
            source: Some("market".to_string()),
            version: Some("1.0.0".to_string()),
            provider: Some("claude".to_string()),
            plugin_name: Some("acme".to_string()),
            plugin_marketplace: Some("market".to_string()),
            disabled: false,
            visibility: Some("native".to_string()),
            implicit_allowed: true,
            diagnostics: Vec::new(),
        };
        let skills = scan_skills_dir_with_options(&dir, &options);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "acme:lint");
        assert_eq!(skills[0].display_name, Some("lint".to_string()));
        assert_eq!(skills[0].invocation_label, Some("acme:lint".to_string()));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_codex_config_disabled_skill_paths() {
        let home = std::env::temp_dir().join("ccem-test-codex-config");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(
            home.join(".codex").join("config.toml"),
            "[[skills.config]]\npath = \"~/blocked\"\nenabled = false\n\n[plugins.\"demo@market\"]\nenabled = false\n",
        )
        .unwrap();

        let config = read_codex_config(&home, &home.join(".codex"));
        assert!(is_path_disabled(
            &home.join("blocked").join("SKILL.md"),
            &config.disabled_skill_paths
        ));
        assert!(config.disabled_plugins.contains("demo@market"));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn test_workspace_agents_scan_stops_at_repo_root() {
        let root = std::env::temp_dir().join("ccem-test-workspace-root");
        let _ = fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let nested = repo.join("packages").join("app");
        fs::create_dir_all(repo.join(".agents").join("skills")).unwrap();
        fs::create_dir_all(root.join(".agents").join("skills")).unwrap();
        fs::create_dir_all(&nested).unwrap();
        fs::write(repo.join(".git"), "gitdir: somewhere").unwrap();

        let dirs = collect_workspace_skill_dirs(Some(&nested), ".agents", None);
        assert_eq!(dirs, vec![repo.join(".agents").join("skills")]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_hidden_system_container_can_be_scanned_directly() {
        let dir = std::env::temp_dir().join("ccem-test-codex-system-skills");
        let _ = fs::remove_dir_all(&dir);
        let system_skill = dir.join(".system").join("imagegen");
        fs::create_dir_all(&system_skill).unwrap();
        fs::write(system_skill.join("SKILL.md"), "---\nname: imagegen\n---\n").unwrap();

        let options = SkillScanOptions {
            scope: "system".to_string(),
            agents: vec!["Codex".to_string()],
            source: Some("CCEM Codex system skills".to_string()),
            version: None,
            provider: Some("codex".to_string()),
            plugin_name: None,
            plugin_marketplace: None,
            disabled: false,
            visibility: Some("native".to_string()),
            implicit_allowed: true,
            diagnostics: Vec::new(),
        };
        let skills = scan_skills_dir_with_options(&dir.join(".system"), &options);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "imagegen");
        assert_eq!(skills[0].scope, "system");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_ccem_agent_skill_status_reports_missing_targets() {
        let home = std::env::temp_dir().join("ccem-test-agent-skill-missing");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();

        let status = get_ccem_agent_skill_status_for_homes(
            &home.join("ccem/claude"),
            &home.join("ccem/codex"),
        )
        .unwrap();

        assert_eq!(status.name, "ccem");
        assert!(!status.installed);
        assert!(!status.up_to_date);
        assert_eq!(status.targets.len(), 2);
        assert!(status.targets.iter().any(|target| target.agent == "Codex"
            && Path::new(&target.path).ends_with(
                Path::new("ccem/codex")
                    .join("skills")
                    .join("ccem")
                    .join("SKILL.md")
            )
            && !target.installed
            && !target.up_to_date));
        assert!(status
            .targets
            .iter()
            .any(|target| target.agent == "Claude Code"
                && Path::new(&target.path).ends_with(
                    Path::new("ccem/claude")
                        .join("skills")
                        .join("ccem")
                        .join("SKILL.md")
                )
                && !target.installed
                && !target.up_to_date));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn test_install_ccem_agent_skill_writes_codex_and_claude_targets() {
        let home = std::env::temp_dir().join("ccem-test-agent-skill-install");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        let home = home.canonicalize().unwrap();
        write_test_skill(&home.join(".claude/skills/ccem"), "official-claude");
        write_test_skill(&home.join(".codex/skills/ccem"), "official-codex");

        let status =
            install_ccem_agent_skill_for_homes(&home.join("ccem/claude"), &home.join("ccem/codex"))
                .unwrap();

        assert!(status.installed);
        assert!(status.up_to_date);
        assert!(status.targets.iter().all(|target| target.installed));
        assert!(status.targets.iter().all(|target| target.up_to_date));

        let codex_skill = home
            .join("ccem/codex")
            .join("skills")
            .join("ccem")
            .join("SKILL.md");
        let claude_skill = home
            .join("ccem/claude")
            .join("skills")
            .join("ccem")
            .join("SKILL.md");
        let codex_content = fs::read_to_string(codex_skill).unwrap();
        let claude_content = fs::read_to_string(claude_skill).unwrap();

        assert_eq!(codex_content, CCEM_AGENT_SKILL_CONTENT);
        assert_eq!(claude_content, CCEM_AGENT_SKILL_CONTENT);
        assert!(codex_content.contains("ccem desktop health --json"));
        assert!(codex_content.contains("ccem desktop create"));
        assert!(
            fs::read_to_string(home.join(".claude/skills/ccem/SKILL.md"))
                .unwrap()
                .contains("official-claude")
        );
        assert!(fs::read_to_string(home.join(".codex/skills/ccem/SKILL.md"))
            .unwrap()
            .contains("official-codex"));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn test_get_curated_skills() {
        let curated = get_curated_skills();
        assert!(!curated.is_empty());
        // Check we have all three categories
        assert!(curated.iter().any(|s| s.category == "official"));
        assert!(curated.iter().any(|s| s.category == "popular"));
        assert!(curated.iter().any(|s| s.category == "community"));
    }
}
