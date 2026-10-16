use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCommand {
    pub token: String,
    pub name: String,
    pub description: Option<String>,
    pub path: String,
    pub scope: String,
    pub source: String,
    pub namespace: Option<String>,
    pub provider: String,
}

#[derive(Debug, Clone)]
struct CommandScanOptions {
    scope: String,
    source: String,
    provider: String,
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

fn extract_frontmatter(content: &str) -> Option<(String, &str)> {
    let trimmed = content.trim_start_matches('\u{feff}').trim_start();
    let first_line_end = trimmed.find('\n').unwrap_or(trimmed.len());
    if trimmed[..first_line_end].trim() != "---" {
        return None;
    }

    let mut frontmatter = Vec::new();
    let mut offset = if first_line_end < trimmed.len() {
        first_line_end + 1
    } else {
        first_line_end
    };
    for line in trimmed[offset..].split_inclusive('\n') {
        let content_line = line.trim_end_matches('\n').trim_end_matches('\r');
        let marker = content_line.trim();
        if marker == "---" || marker == "..." {
            offset += line.len();
            return Some((frontmatter.join("\n"), trimmed.get(offset..).unwrap_or("")));
        }
        frontmatter.push(content_line);
        offset += line.len();
    }

    None
}

fn parse_frontmatter_description(frontmatter: &str) -> Option<String> {
    match serde_yaml::from_str::<serde_yaml::Value>(frontmatter) {
        Ok(serde_yaml::Value::Mapping(mapping)) => {
            yaml_mapping_value(&mapping, "description").and_then(yaml_value_to_string)
        }
        _ => {
            for line in frontmatter.lines() {
                let Some((raw_key, raw_value)) = line.split_once(':') else {
                    continue;
                };
                if raw_key.trim().eq_ignore_ascii_case("description") {
                    let value = raw_value
                        .trim()
                        .trim_matches('"')
                        .trim_matches('\'')
                        .trim()
                        .to_string();
                    if !value.is_empty() && value != "|" && value != ">" {
                        return Some(value);
                    }
                }
            }
            None
        }
    }
}

fn first_body_line(content: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.trim_start_matches('#').trim().to_string())
        .filter(|line| !line.is_empty())
}

fn command_description(content: &str) -> Option<String> {
    if let Some((frontmatter, body)) = extract_frontmatter(content) {
        return parse_frontmatter_description(&frontmatter).or_else(|| first_body_line(body));
    }
    first_body_line(content)
}

fn is_hidden_component(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with('.'))
        .unwrap_or(false)
}

fn is_valid_command_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.starts_with('_')
        && !name.chars().any(char::is_whitespace)
}

fn namespace_for_command(root: &Path, file: &Path) -> Option<String> {
    let parent = file.parent()?;
    let relative = parent.strip_prefix(root).ok()?;
    let parts = relative
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(":"))
    }
}

fn scan_command_dir(root: &Path, options: &CommandScanOptions) -> Vec<WorkspaceCommand> {
    fn visit(
        root: &Path,
        dir: &Path,
        options: &CommandScanOptions,
        commands: &mut Vec<WorkspaceCommand>,
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries = entries.flatten().collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.path());

        for entry in entries {
            let path = entry.path();
            if is_hidden_component(&path) {
                continue;
            }
            if path.is_dir() {
                visit(root, &path, options, commands);
                continue;
            }
            if path.extension().and_then(|value| value.to_str()) != Some("md") {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if !is_valid_command_name(name) {
                continue;
            }
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            commands.push(WorkspaceCommand {
                token: format!("/{}", name),
                name: name.to_string(),
                description: command_description(&content),
                path: path.to_string_lossy().to_string(),
                scope: options.scope.clone(),
                source: options.source.clone(),
                namespace: namespace_for_command(root, &path),
                provider: options.provider.clone(),
            });
        }
    }

    let mut commands = Vec::new();
    if root.exists() {
        visit(root, root, options, &mut commands);
    }
    commands
}

fn collect_workspace_command_dirs(
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
        if user_home == Some(dir.as_path()) {
            break;
        }
        let commands_dir = dir.join(folder_name).join("commands");
        if commands_dir.exists() {
            dirs.push(commands_dir);
        }
        if dir.join(".git").exists() {
            break;
        }
        current = dir.parent().map(Path::to_path_buf);
    }

    dirs
}

fn add_commands_unique_by_path(
    target: &mut Vec<WorkspaceCommand>,
    seen_paths: &mut HashSet<String>,
    commands: Vec<WorkspaceCommand>,
) {
    for command in commands {
        if seen_paths.insert(command.path.clone()) {
            target.push(command);
        }
    }
}

fn scan_provider_commands(
    profile_home: Option<&Path>,
    user_home: Option<&Path>,
    working_dir: Option<&Path>,
    provider: &str,
    folder_name: &str,
) -> Vec<WorkspaceCommand> {
    let mut commands = Vec::new();
    let mut seen_paths = HashSet::new();

    for project_dir in collect_workspace_command_dirs(working_dir, folder_name, user_home) {
        let options = CommandScanOptions {
            scope: "project".to_string(),
            source: format!("{}/commands", folder_name),
            provider: provider.to_string(),
        };
        add_commands_unique_by_path(
            &mut commands,
            &mut seen_paths,
            scan_command_dir(&project_dir, &options),
        );
    }

    if let Some(profile_home) = profile_home {
        let global_dir = profile_home.join("commands");
        let options = CommandScanOptions {
            scope: "global".to_string(),
            source: format!("CCEM {}/commands", provider),
            provider: provider.to_string(),
        };
        add_commands_unique_by_path(
            &mut commands,
            &mut seen_paths,
            scan_command_dir(&global_dir, &options),
        );
    }

    commands.sort_by(|left, right| {
        let left_scope_rank = if left.scope == "project" { 0 } else { 1 };
        let right_scope_rank = if right.scope == "project" { 0 } else { 1 };
        left_scope_rank
            .cmp(&right_scope_rank)
            .then_with(|| left.token.cmp(&right.token))
            .then_with(|| left.namespace.cmp(&right.namespace))
            .then_with(|| left.path.cmp(&right.path))
    });
    commands
}

#[tauri::command]
pub async fn list_workspace_commands(
    working_dir: Option<String>,
    provider: Option<String>,
    codex_isolated: Option<bool>,
) -> Result<Vec<WorkspaceCommand>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_workspace_commands_sync(working_dir, provider, codex_isolated)
    })
    .await
    .map_err(|error| format!("Failed to scan workspace commands: {}", error))?
}

fn list_workspace_commands_sync(
    working_dir: Option<String>,
    provider: Option<String>,
    codex_isolated: Option<bool>,
) -> Result<Vec<WorkspaceCommand>, String> {
    let codex_isolated = match codex_isolated { Some(mode) => mode, None => crate::agent_home::codex_isolation_preference()? };
    crate::agent_home::prepare_agent_homes_for_mode(codex_isolated)?;
    let codex_home = crate::agent_home::codex_home_for_mode(codex_isolated);
    let home = dirs::home_dir();
    let working_dir = working_dir
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let normalized_provider = provider
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    let mut commands = Vec::new();
    match normalized_provider.as_deref() {
        Some("codex") => {
            commands.extend(scan_provider_commands(
                Some(&codex_home),
                home.as_deref(),
                working_dir.as_deref(),
                "codex",
                ".codex",
            ));
        }
        Some("claude") | Some("claude-code") => {
            commands.extend(scan_provider_commands(
                Some(&crate::agent_home::claude_home()),
                home.as_deref(),
                working_dir.as_deref(),
                "claude",
                ".claude",
            ));
        }
        _ => {
            commands.extend(scan_provider_commands(
                Some(&crate::agent_home::claude_home()),
                home.as_deref(),
                working_dir.as_deref(),
                "claude",
                ".claude",
            ));
            commands.extend(scan_provider_commands(
                Some(&codex_home),
                home.as_deref(),
                working_dir.as_deref(),
                "codex",
                ".codex",
            ));
        }
    }

    Ok(commands)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ccem-slash-commands-{}-{}", name, stamp))
    }

    #[test]
    fn scans_project_commands_with_frontmatter_and_namespace() {
        let dir = temp_dir("project");
        let commands_dir = dir.join(".claude").join("commands").join("tools");
        std::fs::create_dir_all(&commands_dir).unwrap();
        std::fs::write(
            commands_dir.join("verify.md"),
            "---\ndescription: Run the local verification gate\n---\nBody",
        )
        .unwrap();

        let commands = scan_provider_commands(None, None, Some(&dir), "claude", ".claude");

        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].token, "/verify");
        assert_eq!(
            commands[0].description,
            Some("Run the local verification gate".to_string())
        );
        assert_eq!(commands[0].scope, "project");
        assert_eq!(commands[0].source, ".claude/commands");
        assert_eq!(commands[0].namespace, Some("tools".to_string()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scans_command_description_from_body_when_frontmatter_is_missing() {
        let dir = temp_dir("body");
        let commands_dir = dir.join(".claude").join("commands");
        std::fs::create_dir_all(&commands_dir).unwrap();
        std::fs::write(
            commands_dir.join("dev-desktop.md"),
            "Start the desktop app in development mode.\n\nMore details.",
        )
        .unwrap();

        let commands = scan_provider_commands(None, None, Some(&dir), "claude", ".claude");

        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].token, "/dev-desktop");
        assert_eq!(
            commands[0].description,
            Some("Start the desktop app in development mode.".to_string())
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scans_profile_commands_without_discovering_official_home_as_a_project() {
        let dir = temp_dir("profile-isolation");
        let home = dir.join("user");
        let workspace = home.join("projects/non-git");
        let profile = home.join(".ccem/agents/claude");
        for (root, name) in [
            (home.join(".claude/commands"), "official"),
            (profile.join("commands"), "ccem"),
            (workspace.join(".claude/commands"), "project"),
        ] {
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join(format!("{}.md", name)), name).unwrap();
        }

        let commands = scan_provider_commands(
            Some(&profile),
            Some(&home),
            Some(&workspace),
            "claude",
            ".claude",
        );
        let names: Vec<_> = commands
            .iter()
            .map(|command| command.name.as_str())
            .collect();
        assert_eq!(names, vec!["project", "ccem"]);
        assert_eq!(
            commands[1].path,
            profile.join("commands").join("ccem.md").to_string_lossy()
        );

        let _ = std::fs::remove_dir_all(dir);
    }
}
