use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

use crate::config;

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

fn read_codex_config(home: &Path) -> CodexConfig {
    let config_path = home.join(".codex").join("config.toml");
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

fn collect_workspace_skill_dirs(working_dir: Option<&Path>, folder_name: &str) -> Vec<PathBuf> {
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
    working_dir: Option<&Path>,
) -> Vec<InstalledSkill> {
    let mut skills = Vec::new();
    let mut seen_files = HashSet::new();

    let codex_agents = vec!["Codex".to_string()];
    let Some(home) = home else {
        return skills;
    };
    let codex_config = read_codex_config(home);

    for dir in collect_workspace_skill_dirs(working_dir, ".agents") {
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

    let codex_skills_dir = home.join(".codex").join("skills");
    if codex_skills_dir.exists() {
        let mut options = SkillScanOptions {
            scope: "global".to_string(),
            agents: codex_agents.clone(),
            source: Some("~/.codex/skills".to_string()),
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
                source: Some("~/.codex/skills/.system".to_string()),
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

    scan_codex_plugin_cache_skills(home, &codex_config, &mut skills, &mut seen_files);

    skills
}

fn scan_codex_plugin_cache_skills(
    home: &Path,
    codex_config: &CodexConfig,
    all_skills: &mut Vec<InstalledSkill>,
    seen_files: &mut HashSet<String>,
) {
    let cache_dir = home.join(".codex").join("plugins").join("cache");
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

fn collect_claude_settings_paths(home: Option<&Path>, working_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = home {
        paths.push(home.join(".claude").join("settings.json"));
    }
    if let Some(working_dir) = working_dir {
        let mut current = if working_dir.is_file() {
            working_dir.parent().map(Path::to_path_buf)
        } else {
            Some(working_dir.to_path_buf())
        };
        while let Some(dir) = current {
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
    working_dir: Option<&Path>,
) -> HashMap<String, String> {
    let mut overrides = HashMap::new();
    for settings_path in collect_claude_settings_paths(home, working_dir) {
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

    if let Some(home) = home {
        let personal_dir = home.join(".claude").join("skills");
        if personal_dir.exists() {
            let options = SkillScanOptions {
                scope: "global".to_string(),
                agents: claude_agents.clone(),
                source: Some("~/.claude/skills".to_string()),
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

    for project_dir in collect_workspace_skill_dirs(working_dir, ".claude") {
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

    if let Some(home) = home {
        skills.extend(scan_claude_plugin_skills(home));

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

    for project_agents_dir in collect_workspace_skill_dirs(working_dir, ".agents") {
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

    let overrides = read_claude_skill_overrides(home, working_dir);
    for skill in &mut skills {
        apply_claude_overrides(skill, &overrides);
    }

    apply_claude_native_priority(skills)
}

/// Scan plugin skills from ~/.claude/plugins/
fn scan_claude_plugin_skills(home: &Path) -> Vec<InstalledSkill> {
    let mut skills = Vec::new();
    // Read installed_plugins.json
    let plugins_json = home
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");
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
    dirs::home_dir()
        .map(|home| scan_claude_plugin_skills(&home))
        .unwrap_or_default()
}

fn ccem_agent_skill_file_targets(home: &Path) -> Vec<(String, PathBuf)> {
    vec![
        (
            "Codex".to_string(),
            home.join(".codex")
                .join("skills")
                .join(CCEM_AGENT_SKILL_NAME)
                .join("SKILL.md"),
        ),
        (
            "Claude Code".to_string(),
            home.join(".claude")
                .join("skills")
                .join(CCEM_AGENT_SKILL_NAME)
                .join("SKILL.md"),
        ),
    ]
}

fn get_ccem_agent_skill_status_for_home(home: &Path) -> Result<CcemAgentSkillStatus, String> {
    let targets: Vec<CcemAgentSkillTarget> = ccem_agent_skill_file_targets(home)
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

fn install_ccem_agent_skill_for_home(home: &Path) -> Result<CcemAgentSkillStatus, String> {
    for (_, path) in ccem_agent_skill_file_targets(home) {
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

    get_ccem_agent_skill_status_for_home(home)
}

// ============================================
// Tauri Commands
// ============================================

#[tauri::command]
pub fn get_ccem_agent_skill_status() -> Result<CcemAgentSkillStatus, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Failed to resolve user home directory".to_string())?;
    get_ccem_agent_skill_status_for_home(&home)
}

#[tauri::command]
pub fn install_ccem_agent_skill() -> Result<CcemAgentSkillStatus, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Failed to resolve user home directory".to_string())?;
    install_ccem_agent_skill_for_home(&home)
}

/// Stream skill search results via Claude CLI subprocess.
/// Emits "skill-search-stream" events for each line, then "skill-search-done".
#[tauri::command]
pub fn search_skills_stream(app: AppHandle, query: String) {
    std::thread::spawn(move || {
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

        // Inject AI environment's API config (respects ai_enhanced setting)
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
/// 1. Filesystem skills: ~/.claude/skills/, ~/.agents/skills/, ~/.codex/skills/
/// 2. Plugin skills: ~/.claude/plugins/installed_plugins.json
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
                working_dir.as_deref(),
            ));
        }
        Some("claude") | Some("claude-code") => {
            skills.extend(scan_claude_skills_for_context(
                home.as_deref(),
                working_dir.as_deref(),
            ));
        }
        _ => {
            skills.extend(scan_claude_skills_for_context(
                home.as_deref(),
                working_dir.as_deref(),
            ));
            skills.extend(scan_codex_skills_for_context(
                home.as_deref(),
                working_dir.as_deref(),
            ));
        }
    }

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
    let mut all_skills = Vec::new();

    if let Some(home) = dirs::home_dir() {
        // Source 1: Filesystem skills — scan multiple agent directories
        let claude_agents = ["Claude Code"];
        let codex_agents = ["Codex"];

        // ~/.claude/skills/ → Claude Code
        let claude_skills_dir = home.join(".claude").join("skills");
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

        // ~/.codex/skills/ → Codex
        let codex_skills_dir = home.join(".codex").join("skills");
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
        let project_skills_dir = PathBuf::from(&working_dir).join(".claude").join("skills");
        if project_skills_dir.exists() {
            all_skills.extend(scan_skills_dir(
                &project_skills_dir,
                "project",
                &["Claude Code".to_string()],
                None,
            ));
        }
    }

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

/// Install a skill via npx skills add (async, event-driven).
/// Emits "skill-install-done" with { package_id, success, message }.
#[tauri::command]
pub fn install_skill(
    app: AppHandle,
    package_id: String,
    skill_name: Option<String>,
    global: bool,
    agents: Option<Vec<String>>,
) {
    std::thread::spawn(move || {
        let mut args = vec![
            "skills".to_string(),
            "add".to_string(),
            package_id.clone(),
            "-y".to_string(),
        ];

        // Add --skill if provided
        if let Some(ref sn) = skill_name {
            args.push("--skill".to_string());
            args.push(sn.clone());
        }

        if global {
            args.push("-g".to_string());
        }

        // Add --agent flags if agents are specified
        if let Some(ref agent_list) = agents {
            if !agent_list.is_empty() {
                args.push("--agent".to_string());
                for agent in agent_list {
                    // Map display names to CLI names
                    let cli_name = match agent.as_str() {
                        "Claude Code" => "claude-code",
                        "Codex" => "codex",
                        other => other,
                    };
                    args.push(cli_name.to_string());
                }
            }
        }

        let user_path = get_user_path();
        let result = Command::new("npx")
            .args(&args)
            .env("PATH", user_path)
            .output();

        let payload = match result {
            Ok(output) => {
                // npx skills add writes progress/spinners to stderr even on success,
                // so only check exit code — ignore stderr warnings.
                if output.status.success() {
                    serde_json::json!({
                        "package_id": package_id,
                        "success": true,
                        "message": String::from_utf8_lossy(&output.stdout).to_string()
                    })
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                    serde_json::json!({
                        "package_id": package_id,
                        "success": false,
                        "message": if stderr.is_empty() { stdout } else { stderr }
                    })
                }
            }
            Err(e) => {
                serde_json::json!({
                    "package_id": package_id,
                    "success": false,
                    "message": format!("Failed to run npx: {}", e)
                })
            }
        };

        let _ = app.emit("skill-install-done", payload.to_string());
    });
}

/// Uninstall a skill via npx skills remove (async, event-driven).
/// Emits "skill-uninstall-done" with { name, success, message }.
#[tauri::command]
pub fn uninstall_skill(app: AppHandle, name: String, global: bool) {
    std::thread::spawn(move || {
        let mut args = vec![
            "skills".to_string(),
            "remove".to_string(),
            name.clone(),
            "-y".to_string(),
        ];
        if global {
            args.push("-g".to_string());
        }

        let user_path = get_user_path();
        let result = Command::new("npx")
            .args(&args)
            .env("PATH", user_path)
            .output();

        let payload = match result {
            Ok(output) => {
                if output.status.success() {
                    serde_json::json!({
                        "name": name,
                        "success": true,
                        "message": String::from_utf8_lossy(&output.stdout).to_string()
                    })
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                    serde_json::json!({
                        "name": name,
                        "success": false,
                        "message": if stderr.is_empty() { stdout } else { stderr }
                    })
                }
            }
            Err(e) => {
                serde_json::json!({
                    "name": name,
                    "success": false,
                    "message": format!("Failed to run npx: {}", e)
                })
            }
        };

        let _ = app.emit("skill-uninstall-done", payload.to_string());
    });
}

// ============================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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

        let config = read_codex_config(&home);
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

        let dirs = collect_workspace_skill_dirs(Some(&nested), ".agents");
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
            source: Some("~/.codex/skills/.system".to_string()),
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

        let status = get_ccem_agent_skill_status_for_home(&home).unwrap();

        assert_eq!(status.name, "ccem");
        assert!(!status.installed);
        assert!(!status.up_to_date);
        assert_eq!(status.targets.len(), 2);
        assert!(status.targets.iter().any(|target| target.agent == "Codex"
            && Path::new(&target.path).ends_with(
                Path::new(".codex")
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
                    Path::new(".claude")
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

        let status = install_ccem_agent_skill_for_home(&home).unwrap();

        assert!(status.installed);
        assert!(status.up_to_date);
        assert!(status.targets.iter().all(|target| target.installed));
        assert!(status.targets.iter().all(|target| target.up_to_date));

        let codex_skill = home
            .join(".codex")
            .join("skills")
            .join("ccem")
            .join("SKILL.md");
        let claude_skill = home
            .join(".claude")
            .join("skills")
            .join("ccem")
            .join("SKILL.md");
        let codex_content = fs::read_to_string(codex_skill).unwrap();
        let claude_content = fs::read_to_string(claude_skill).unwrap();

        assert_eq!(codex_content, CCEM_AGENT_SKILL_CONTENT);
        assert_eq!(claude_content, CCEM_AGENT_SKILL_CONTENT);
        assert!(codex_content.contains("ccem desktop health --json"));
        assert!(codex_content.contains("ccem desktop create"));

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
